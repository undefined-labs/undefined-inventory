import { describe, expect, it, vi } from 'vitest'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InMemoryInventoryStore } from './in-memory.store'
import { makeRig } from './persistence-rig'
import { asItemName } from '../src/shared/types/item-name'

describe('inventory persistence (write-behind)', () => {
  it('does NOT write to the store on each mutation', async () => {
    const { store, service, dirty, scheduler } = makeRig(new InMemoryInventoryStore())
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
    const { store, service, dirty, scheduler } = makeRig(new InMemoryInventoryStore())
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
    const first = makeRig(store)
    await first.service.open('stash', id)
    await first.service.addItem(id, 'water', 5)
    await first.scheduler.flushAll()
    first.dirty.dispose()

    // Restart: brand-new registry + service over the SAME store. Items must be intact.
    const second = makeRig(store)
    const reopened = await second.service.open('stash', id)
    expect(reopened.countItem(asItemName('water'))).toBe(5)

    second.dirty.dispose()
    second.scheduler.dispose()
  })
})
