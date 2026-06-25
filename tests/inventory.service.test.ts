import { beforeEach, describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { InventoryChangedEvent } from '../src/shared/events/inventory-event.types'
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
