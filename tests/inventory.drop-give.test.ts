import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition, InventoryContext } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { SlotChange, InventoryEvictedEvent } from '../src/shared/events/inventory-event.types'
import { playerInventoryId, parseInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { MetadataFactoryRegistry } from '../src/server/registry/metadata-factory.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { HookBus } from '../src/server/policies/hook-bus'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { InventoryService } from '../src/server/services/inventory.service'
import { InMemoryInventoryStore } from './in-memory.store'
import { makeRig } from './persistence-rig'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class FixedCapacityPolicy extends CapacityPolicyContract {
  resolve(): { slots: number; maxWeight: number } {
    return { slots: 10, maxWeight: 5000 }
  }
}

class AllowAccess extends AccessPolicyContract {
  canOpen(): boolean {
    return true
  }
}

/** A give gate driven per-test: proximity from ctx.distance, busy from a settable flag. */
class TestGiveAccess extends GiveAccessContract {
  busy = false
  canReceive(_targetInvId: string, _actor: number, ctx?: InventoryContext): boolean {
    if (this.busy) return false
    const distance = ctx?.distance
    if (typeof distance === 'number' && distance > 2) return false
    return true
  }
}

/** Records the unicast slot re-assertions so tests can prove a reassert-to-actor. */
class RecordingSync extends InventorySyncContract {
  setInventory(): void {}
  updates: { players: number[]; inventoryId: string; changes: SlotChange[] }[] = []
  updateSlots(players: Iterable<number>, inventoryId: string, changes: SlotChange[]): void {
    this.updates.push({ players: [...players], inventoryId, changes })
  }
}

function makeService(overrides?: { store?: InMemoryInventoryStore; give?: GiveAccessContract; sync?: InventorySyncContract }) {
  const store = overrides?.store ?? new InMemoryInventoryStore()
  const registry = new InventoryRegistry()
  const give = overrides?.give ?? new TestGiveAccess()
  const sync = overrides?.sync ?? new RecordingSync()
  const service = new InventoryService(
    store,
    new StaticItemRegistry(),
    new FixedCapacityPolicy(),
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
    new ViewerRegistry(),
    new AllowAccess(),
    sync,
    new TouchTracker(InventoryEvents),
    give,
    new HookBus(),
    new ItemBehaviorRegistry(),
    new MetadataFactoryRegistry(),
  )
  return { service, store, registry, give, sync }
}

describe('InventoryService.drop', () => {
  it('mints an ephemeral drop inventory and moves the item out of the source into it', async () => {
    const { service, registry } = makeService()
    const owner = playerInventoryId('char-1')
    await service.open('player', owner)
    await service.addItem(owner, 'water', 3) // slot 1

    const dropId = await service.drop(owner, 1, 3)

    // Destination is a freshly-minted drop inventory holding the moved stack.
    expect(parseInventoryId(dropId).type).toBe('drop')
    const drop = registry.get(dropId)!
    expect(drop.getSlot(1)).toMatchObject({ name: 'water', count: 3 })

    // Source slot emptied.
    expect(registry.get(owner)!.getSlot(1)).toBeNull()
  })

  it('never persists the drop — not on the move, not on a scheduler flush', async () => {
    const store = new InMemoryInventoryStore()
    const saveMany = vi.spyOn(store, 'saveMany')
    const { service, registry, dirty, touch, scheduler } = makeRig(store, { idleMs: 1000 })
    const owner = playerInventoryId('char-1')
    await service.open('player', owner)
    await service.addItem(owner, 'water', 3)

    const dropId = await service.drop(owner, 1, 3)

    // The move persisted the source, but the drop snapshot is never written.
    const persistedDrop = saveMany.mock.calls.flatMap((c) => c[0]).filter((s) => s.id === dropId)
    expect(persistedDrop).toEqual([])
    expect(await store.load(dropId)).toBeNull()

    // A flush pass must not write it either, even though the drop holds items.
    await scheduler.flush()
    expect(await store.load(dropId)).toBeNull()
    expect(registry.get(dropId)).not.toBeNull() // still resident, still evictable

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('evicts an idle drop and emits a drop-scoped evicted signal (no ghost pickup)', async () => {
    const store = new InMemoryInventoryStore()
    let now = 0
    const { service, registry, dirty, touch, scheduler } = makeRig(store, {
      idleMs: 1000,
      clock: () => now,
    })
    const owner = playerInventoryId('char-1')
    await service.open('player', owner)
    await service.addItem(owner, 'water', 1)

    const dropId = await service.drop(owner, 1, 1)

    const evicted: InventoryEvictedEvent[] = []
    const handler = (e?: unknown) => evicted.push(e as InventoryEvictedEvent)
    InventoryEvents.on('evicted', handler)

    now = 2000 // past idle
    await scheduler.sweep(now)
    InventoryEvents.off('evicted', handler)

    // The drop left memory (no resident inventory) and announced itself so the prop despawns.
    expect(registry.get(dropId)).toBeNull()
    expect(evicted).toContainEqual({ inventoryId: dropId, type: 'drop' })

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })
})

describe('InventoryService.give', () => {
  it("lands the item in a free slot of the target's inventory, emptying the source", async () => {
    const { service, registry } = makeService()
    const from = playerInventoryId('giver')
    const to = playerInventoryId('receiver')
    await service.open('player', from)
    await service.open('player', to)
    await service.addItem(from, 'water', 2) // from slot 1

    await service.give(from, 1, 2, to, 7)

    expect(registry.get(from)!.getSlot(1)).toBeNull()
    expect(registry.get(to)!.getSlot(1)).toMatchObject({ name: 'water', count: 2 })
  })

  it('rejects a give to an out-of-range target, mutating nothing and re-asserting the source to the actor', async () => {
    const give = new TestGiveAccess()
    const sync = new RecordingSync()
    const { service, registry } = makeService({ give, sync })
    const from = playerInventoryId('giver')
    const to = playerInventoryId('receiver')
    await service.open('player', from)
    await service.open('player', to)
    await service.addItem(from, 'water', 2)

    // distance > 2 → out of range per TestGiveAccess.
    await expect(service.give(from, 1, 2, to, 7, { distance: 5 })).rejects.toThrow()

    // Neither side mutated.
    expect(registry.get(from)!.getSlot(1)).toMatchObject({ name: 'water', count: 2 })
    expect(registry.get(to)!.getItems()).toEqual([])

    // The actor gets the real source slot re-asserted so their optimistic prediction snaps back.
    expect(sync.updates).toContainEqual({
      players: [7],
      inventoryId: from,
      changes: [{ slot: 1, item: expect.objectContaining({ name: 'water', count: 2 }) }],
    })
  })

  it('rejects a give to a busy target, mutating nothing and re-asserting the source to the actor', async () => {
    const give = new TestGiveAccess()
    give.busy = true
    const sync = new RecordingSync()
    const { service, registry } = makeService({ give, sync })
    const from = playerInventoryId('giver')
    const to = playerInventoryId('receiver')
    await service.open('player', from)
    await service.open('player', to)
    await service.addItem(from, 'water', 2)

    await expect(service.give(from, 1, 2, to, 7)).rejects.toThrow()

    expect(registry.get(from)!.getSlot(1)).toMatchObject({ name: 'water', count: 2 })
    expect(registry.get(to)!.getItems()).toEqual([])
    expect(sync.updates.some((u) => u.players[0] === 7 && u.inventoryId === from)).toBe(true)
  })
})
