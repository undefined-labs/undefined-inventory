import { afterEach, describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition, SerializedInventory } from '../src/shared/types/item.types'
import { SlotChange } from '../src/shared/events/inventory-event.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { ProximityGivePolicy } from '../src/server/policies/proximity-give.policy'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { InventoryService } from '../src/server/services/inventory.service'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventorySyncSubscriber } from '../src/server/subscribers/inventory-sync.subscriber'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: 'water', label: 'Water', weight: 100, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: string): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class FixedCapacityPolicy extends CapacityPolicyContract {
  resolve() {
    return { slots: 10, maxWeight: 5000 }
  }
}

/** Records every push so a test can assert who got what — the fake transport adapter. */
class RecordingSync extends InventorySyncContract {
  full: { player: number; inventory: SerializedInventory }[] = []
  pushes: { players: number[]; inventoryId: string; changes: SlotChange[] }[] = []

  setInventory(player: number, inventory: SerializedInventory): void {
    this.full.push({ player, inventory })
  }
  updateSlots(players: Iterable<number>, inventoryId: string, changes: SlotChange[]): void {
    this.pushes.push({ players: [...players], inventoryId, changes })
  }
}

/** Always-deny gate, to assert access rejection at the open boundary. */
class DenyAccess extends AccessPolicyContract {
  canOpen(): boolean {
    return false
  }
}

class AllowAccess extends AccessPolicyContract {
  canOpen(): boolean {
    return true
  }
}

function makeHarness(
  access: AccessPolicyContract = new AllowAccess(),
  capacity: CapacityPolicyContract = new FixedCapacityPolicy(),
) {
  const registry = new InventoryRegistry()
  const viewers = new ViewerRegistry()
  const sync = new RecordingSync()
  const service = new InventoryService(
    new InMemoryInventoryStore(),
    new StaticItemRegistry(),
    capacity,
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
    viewers,
    access,
    sync,
    new TouchTracker(InventoryEvents),
    new ProximityGivePolicy(new InMemoryInventoryLock()),
  )
  const subscriber = new InventorySyncSubscriber(InventoryEvents, viewers, sync)
  return { service, viewers, sync, subscriber, dispose: () => subscriber.dispose() }
}

describe('open + viewer registration', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.dispose())

  it('registers the opener as a viewer and pushes full state down to them', async () => {
    h = makeHarness()
    const id = stashInventoryId('a')

    await h.service.open('stash', id, { player: 1 }, 1)

    expect([...h.viewers.get(id)]).toEqual([1])
    expect(h.sync.full).toHaveLength(1)
    expect(h.sync.full[0]).toMatchObject({ player: 1 })
    expect(h.sync.full[0]!.inventory.id).toBe(id)
  })

  it('denied access rejects the open and registers no viewer', async () => {
    h = makeHarness(new DenyAccess())
    const id = stashInventoryId('a')

    await expect(h.service.open('stash', id, { player: 1 }, 1)).rejects.toThrow()

    expect([...h.viewers.get(id)]).toEqual([])
    expect(h.sync.full).toHaveLength(0)
  })
})

describe('change broadcast targets the viewer set only', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.dispose())

  it('broadcasts updateSlots to current viewers and no one else', async () => {
    h = makeHarness()
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')

    // Players 1 & 2 watch A; player 3 watches a different inventory B.
    await h.service.open('stash', a, { player: 1 }, 1)
    await h.service.open('stash', a, { player: 2 }, 2)
    await h.service.open('stash', b, { player: 3 }, 3)
    h.sync.pushes.length = 0 // ignore any open-time pushes

    await h.service.addItem(a, 'water', 3)

    const pushes = h.sync.pushes.filter((p) => p.inventoryId === a)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.players.sort()).toEqual([1, 2])
    expect(pushes[0]!.changes).toEqual([
      { slot: 1, item: expect.objectContaining({ name: 'water', count: 3 }) },
    ])
    // Player 3 (viewing B) saw nothing about A.
    expect(h.sync.pushes.some((p) => p.players.includes(3))).toBe(false)
  })
})

describe('rejected action re-asserts truth to the actor', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.dispose())

  it('unicasts the rejected move\'s referenced slots back to the actor only', async () => {
    // Target is tight: 3 water (300g) can't fit a 200g-max inventory → cross-inv move rejects.
    const tight = new (class extends CapacityPolicyContract {
      resolve(_t: string, id: string) {
        return id.endsWith('b') ? { slots: 10, maxWeight: 200 } : { slots: 10, maxWeight: 5000 }
      }
    })()
    h = makeHarness(undefined, tight)
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')

    await h.service.open('stash', a, { player: 1 }, 1)
    await h.service.open('stash', b, { player: 2 }, 2)
    await h.service.addItem(a, 'water', 3) // slot 1 of A
    h.sync.pushes.length = 0

    // Actor 1 optimistically drags A:1 → B:1; the server rejects it.
    await expect(h.service.moveItem(a, b, 1, 1, 3, 1)).rejects.toThrow()

    // Every re-assert went to the actor only — no other player saw the failed action.
    expect(h.sync.pushes.every((p) => p.players.length === 1 && p.players[0] === 1)).toBe(true)

    // Source slot re-asserted as still holding the water (the optimistic remove is undone).
    const aPush = h.sync.pushes.find((p) => p.inventoryId === a)
    expect(aPush!.changes).toContainEqual({
      slot: 1,
      item: expect.objectContaining({ name: 'water', count: 3 }),
    })
    // Target slot re-asserted as empty so the client's optimistic ghost clears.
    const bPush = h.sync.pushes.find((p) => p.inventoryId === b)
    expect(bPush!.changes).toContainEqual({ slot: 1, item: null })
  })
})

describe('viewer lifecycle', () => {
  let h: ReturnType<typeof makeHarness>
  afterEach(() => h?.dispose())

  it('close drops the viewer so later changes no longer reach them', async () => {
    h = makeHarness()
    const a = stashInventoryId('a')
    await h.service.open('stash', a, { player: 1 }, 1)
    await h.service.open('stash', a, { player: 2 }, 2)

    h.service.close(a, 1)
    h.sync.pushes.length = 0
    await h.service.addItem(a, 'water', 1)

    const push = h.sync.pushes.find((p) => p.inventoryId === a)!
    expect(push.players).toEqual([2])
  })

  it('disconnect drops every viewer entry for that player across inventories', async () => {
    h = makeHarness()
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')
    await h.service.open('stash', a, { player: 1 }, 1)
    await h.service.open('stash', b, { player: 1 }, 1)
    await h.service.open('stash', a, { player: 2 }, 2)

    h.service.disconnect(1)
    h.sync.pushes.length = 0
    await h.service.addItem(a, 'water', 1)
    await h.service.addItem(b, 'water', 1)

    // Player 1 gone everywhere; player 2 still watching A.
    expect(h.sync.pushes.find((p) => p.inventoryId === a)!.players).toEqual([2])
    expect(h.sync.pushes.some((p) => p.inventoryId === b)).toBe(false)
  })
})
