import { describe, expect, it, vi } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { DirtySet } from '../src/server/subscribers/dirty-set'
import { SaveScheduler } from '../src/server/subscribers/save-scheduler'
import { InventoryService } from '../src/server/services/inventory.service'
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
  resolve(): { slots: number; maxWeight: number } {
    return { slots: 10, maxWeight: 5000 }
  }
}

/** A full persistence rig wired the way the module wires it, but constructed by hand. */
function makeRig() {
  const store = new InMemoryInventoryStore()
  const registry = new InventoryRegistry()
  const dirty = new DirtySet(InventoryEvents)
  const service = new InventoryService(
    store,
    new StaticItemRegistry(),
    new FixedCapacityPolicy(),
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
  )
  const scheduler = new SaveScheduler(store, registry, dirty)
  return { store, registry, dirty, scheduler, service }
}

describe('inventory persistence (write-behind)', () => {
  it('does NOT write to the store on each mutation', async () => {
    const { store, service, dirty, scheduler } = makeRig()
    const saveMany = vi.spyOn(store, 'saveMany')
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)
    await service.addItem(id, 'water', 1)

    expect(saveMany).not.toHaveBeenCalled()

    dirty.dispose()
    scheduler.dispose()
  })

  it('flushes all dirty inventories in a single saveMany transaction', async () => {
    const { store, service, dirty, scheduler } = makeRig()
    const saveMany = vi.spyOn(store, 'saveMany')
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')

    await service.open('stash', a)
    await service.open('stash', b)
    await service.addItem(a, 'water', 1)
    await service.addItem(b, 'water', 2)

    await scheduler.flush()

    // One transaction, both inventories.
    expect(saveMany).toHaveBeenCalledTimes(1)
    const batch = saveMany.mock.calls[0]![0]
    expect(batch.map((s) => s.id).sort()).toEqual([a, b])

    // Data actually landed.
    expect((await store.load(a))!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])
    expect((await store.load(b))!.items).toEqual([{ slot: 1, name: 'water', count: 2 }])

    dirty.dispose()
    scheduler.dispose()
  })

  it('survives a shutdown-flush / restart cycle (lossless planned restart)', async () => {
    const store = new InMemoryInventoryStore()
    const id = stashInventoryId('locker-1')

    // First boot: open, mutate (no save yet), then shut down with a flush.
    const first = makeRigOn(store)
    await first.service.open('stash', id)
    await first.service.addItem(id, 'water', 5)
    await first.scheduler.flushAll()
    first.dirty.dispose()

    // Restart: brand-new registry + service over the SAME store. Items must be intact.
    const second = makeRigOn(store)
    const reopened = await second.service.open('stash', id)
    expect(reopened.countItem('water')).toBe(5)

    second.dirty.dispose()
    second.scheduler.dispose()
  })
})

/** Build a rig over a provided store (to share a store across a restart boundary). */
function makeRigOn(store: InMemoryInventoryStore) {
  const registry = new InventoryRegistry()
  const dirty = new DirtySet(InventoryEvents)
  const service = new InventoryService(
    store,
    new StaticItemRegistry(),
    new FixedCapacityPolicy(),
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
  )
  const scheduler = new SaveScheduler(store, registry, dirty)
  return { store, registry, dirty, scheduler, service }
}
