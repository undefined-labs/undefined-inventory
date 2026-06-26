import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { HookBus } from '../src/server/policies/hook-bus'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { InventoryChangedEvent } from '../src/shared/events/inventory-event.types'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: 'water', label: 'Water', weight: 100, stack: true },
  phone: { name: 'phone', label: 'Phone', weight: 200, stack: false },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: string): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class FixedCapacityPolicy extends CapacityPolicyContract {
  constructor(private slots: number, private maxWeight: number) {
    super()
  }
  resolve(): { slots: number; maxWeight: number } {
    return { slots: this.slots, maxWeight: this.maxWeight }
  }
}

class AllowAccess extends AccessPolicyContract {
  canOpen(): boolean {
    return true
  }
}

class NoopSync extends InventorySyncContract {
  setInventory(): void {}
  updateSlots(): void {}
}

class AllowGive extends GiveAccessContract {
  canReceive(): boolean {
    return true
  }
}

function makeService(overrides?: {
  store?: InMemoryInventoryStore
  capacity?: CapacityPolicyContract
}): {
  service: InventoryService
  store: InMemoryInventoryStore
  registry: InventoryRegistry
} {
  const store = overrides?.store ?? new InMemoryInventoryStore()
  const capacity = overrides?.capacity ?? new FixedCapacityPolicy(10, 5000)
  const registry = new InventoryRegistry()
  const service = new InventoryService(
    store,
    new StaticItemRegistry(),
    capacity,
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
    new ViewerRegistry(),
    new AllowAccess(),
    new NoopSync(),
    new TouchTracker(InventoryEvents),
    new AllowGive(),
    new HookBus(),
    new ItemBehaviorRegistry(),
  )
  return { service, store, registry }
}

describe('InventoryService.open', () => {
  it('opens an unknown id as a born-fresh empty inventory (no error)', async () => {
    const { service } = makeService()

    const inv = await service.open('stash', stashInventoryId('locker-1'))

    expect(inv.getItems()).toEqual([])
    expect(inv.id).toBe('stash:locker-1')
    expect(inv.type).toBe('stash')
  })

  it('returns the same instance on two opens of one id (identity map)', async () => {
    const { service } = makeService()
    const id = stashInventoryId('locker-1')

    const first = await service.open('stash', id)
    const second = await service.open('stash', id)

    expect(second).toBe(first)
  })

  it('resolves capacity from policy on every open — a config bump applies on reload, never persisted', async () => {
    const store = new InMemoryInventoryStore()
    const id = stashInventoryId('locker-1')

    // First open at the original capacity, persist its items.
    const small = makeService({ store, capacity: new FixedCapacityPolicy(5, 1000) })
    const inv = await small.service.open('stash', id)
    inv.addItem(ITEMS.water!, 1)
    await store.saveMany([inv.serialize()])

    // The stored snapshot must carry NO capacity (thin shape).
    const stored = await store.load(id)
    expect(stored).not.toHaveProperty('slots')
    expect(stored).not.toHaveProperty('maxWeight')

    // Re-open through a fresh service with a bumped policy → new capacity applies.
    const big = makeService({ store, capacity: new FixedCapacityPolicy(20, 9000) })
    const reopened = await big.service.open('stash', id)

    expect(reopened.slots).toBe(20)
    expect(reopened.maxWeight).toBe(9000)
    expect(reopened.countItem('water')).toBe(1)
  })
})

describe('InventoryService mutations', () => {
  it('addItem mutates memory and emits inventory:changed with the changed slots', async () => {
    const { service } = makeService()
    const id = stashInventoryId('locker-1')

    const events: InventoryChangedEvent[] = []
    const handler = (e?: unknown) => events.push(e as InventoryChangedEvent)
    InventoryEvents.on('changed', handler)

    const inv = await service.open('stash', id)
    await service.addItem(id, 'water', 3)
    InventoryEvents.off('changed', handler)

    expect(inv.countItem('water')).toBe(3)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ inventoryId: id, type: 'stash', reason: 'add' })
    expect(events[0]!.changes).toEqual([{ slot: 1, item: expect.objectContaining({ name: 'water', count: 3 }) }])
  })

  it('removeItem mutates memory and emits an emptied slot as item: null', async () => {
    const { service } = makeService()
    const id = stashInventoryId('locker-1')

    const events: InventoryChangedEvent[] = []
    const handler = (e?: unknown) => events.push(e as InventoryChangedEvent)

    const inv = await service.open('stash', id)
    await service.addItem(id, 'water', 2)

    InventoryEvents.on('changed', handler)
    await service.removeItem(id, 'water', 2)
    InventoryEvents.off('changed', handler)

    expect(inv.countItem('water')).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ reason: 'remove' })
    expect(events[0]!.changes).toEqual([{ slot: 1, item: null }])
  })

  it('refuses to mutate an inventory whose lock is already held', async () => {
    const store = new InMemoryInventoryStore()
    const capacity = new FixedCapacityPolicy(10, 5000)
    const registry = new InventoryRegistry()
    const lock = new InMemoryInventoryLock()
    const service = new InventoryService(
      store,
      new StaticItemRegistry(),
      capacity,
      registry,
      lock,
      InventoryEvents,
      new ViewerRegistry(),
      new AllowAccess(),
      new NoopSync(),
      new TouchTracker(InventoryEvents),
      new AllowGive(),
      new HookBus(),
      new ItemBehaviorRegistry(),
    )
    const id = stashInventoryId('locker-1')
    const inv = await service.open('stash', id)

    // Simulate a mutation in flight holding the lock across its awaits.
    expect(lock.acquire(id)).toBe(true)
    await expect(service.addItem(id, 'water', 1)).rejects.toThrow()
    expect(inv.countItem('water')).toBe(0)

    // Once released, the same mutation succeeds.
    lock.release(id)
    await service.addItem(id, 'water', 1)
    expect(inv.countItem('water')).toBe(1)
  })
})

describe('InventoryService.moveItem (cross-inventory)', () => {
  it('moves a stack across two inventories, emits a changed for each side, persists both in one saveMany', async () => {
    const { service, store } = makeService()
    const saveMany = vi.spyOn(store, 'saveMany')
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')

    const events: InventoryChangedEvent[] = []
    const handler = (e?: unknown) => events.push(e as InventoryChangedEvent)

    const from = await service.open('stash', a)
    const to = await service.open('stash', b)
    await service.addItem(a, 'water', 3) // slot 1 of A

    InventoryEvents.on('changed', handler)
    await service.moveItem(a, b, 1, 1, 3)
    InventoryEvents.off('changed', handler)

    // Domain effect: stack relocated A→B.
    expect(from.getSlot(1)).toBeNull()
    expect(to.getSlot(1)).toMatchObject({ name: 'water', count: 3 })

    // One event per side.
    expect(events.map((e) => e.inventoryId).sort()).toEqual([a, b])

    // Both sides land in a single transaction — a crash can't split the move.
    expect(saveMany).toHaveBeenCalledTimes(1)
    expect(saveMany.mock.calls[0]![0].map((s) => s.id).sort()).toEqual([a, b])
    expect((await store.load(a))!.items).toEqual([])
    expect((await store.load(b))!.items).toEqual([{ slot: 1, name: 'water', count: 3 }])
  })

  it('serializes overlapping concurrent moves — the second cannot interleave mid-flight', async () => {
    // A store whose saveMany blocks until released, so we can hold one move "in flight"
    // (lock held across the await) and fire a second overlapping move against it.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let firstSaveStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => (firstSaveStarted = resolve))

    const store = new InMemoryInventoryStore()
    let calls = 0
    const real = store.saveMany.bind(store)
    store.saveMany = async (invs) => {
      if (calls++ === 0) {
        firstSaveStarted()
        await gate // first move parks here holding both locks
      }
      return real(invs)
    }

    const { service } = makeService({ store })
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')
    const from = await service.open('stash', a)
    await service.open('stash', b)
    await service.addItem(a, 'water', 4)

    const first = service.moveItem(a, b, 1, 1, 2) // parks in saveMany holding a + b
    await firstStarted

    // A second move touching an overlapping id must NOT proceed while the first holds locks.
    await expect(service.moveItem(b, a, 1, 1, 1)).rejects.toThrow()

    release()
    await first
    // Only the first move's effect is visible; the rejected one mutated nothing.
    expect(from.getSlot(1)).toMatchObject({ name: 'water', count: 2 }) // 4 - 2 split
  })

  it('dedupes the lock for a same-inventory move — does not self-block on a single id', async () => {
    // fromId === toId: the Set collapses [a, a] → [a], so the second acquire never runs
    // against an already-held lock. Without the dedupe this would throw "is locked" on itself.
    const { service } = makeService()
    const a = stashInventoryId('a')
    const from = await service.open('stash', a)
    await service.addItem(a, 'water', 3) // slot 1

    await expect(service.moveItem(a, a, 1, 2, 3)).resolves.toBeUndefined()

    expect(from.getSlot(1)).toBeNull()
    expect(from.getSlot(2)).toMatchObject({ name: 'water', count: 3 })
  })

  it('rejects a cross-inv move over the target weight without mutating or persisting either side', async () => {
    // Source roomy, target tight: 3 water = 300g but the target only holds < 300g.
    const tightTarget = new (class extends CapacityPolicyContract {
      resolve(_type: string, id: string) {
        return id.endsWith('b') ? { slots: 10, maxWeight: 200 } : { slots: 10, maxWeight: 5000 }
      }
    })()

    const { service, store } = makeService({ capacity: tightTarget })
    const saveMany = vi.spyOn(store, 'saveMany')
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')
    const from = await service.open('stash', a)
    const to = await service.open('stash', b)
    await service.addItem(a, 'water', 3) // 300g

    await expect(service.moveItem(a, b, 1, 1, 3)).rejects.toThrow()

    // Neither side mutated, nothing persisted — atomic rejection.
    expect(from.getSlot(1)).toMatchObject({ name: 'water', count: 3 })
    expect(to.getItems()).toEqual([])
    expect(saveMany).not.toHaveBeenCalled()
  })
})
