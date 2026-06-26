import { describe, expect, it } from 'vitest'
import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { SerializedInventory } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { InventoryEvictedEvent } from '../src/shared/events/inventory-event.types'
import { InMemoryInventoryStore } from './in-memory.store'
import { makeRig } from './persistence-rig'

/** An in-memory store whose next save can be made to fail or block mid-flight. */
class FailableStore extends InventoryStoreContract {
  private snapshots = new Map<string, SerializedInventory>()
  private failNext = false
  private gate: Promise<void> | null = null
  private releaseGate: (() => void) | null = null
  private onEnter: (() => void) | null = null

  failOnce(): void {
    this.failNext = true
  }

  /** Block the next saveMany until `release()`; `entered` resolves once it is inside. */
  block(): { entered: Promise<void>; release: () => void } {
    const entered = new Promise<void>((r) => (this.onEnter = r))
    this.gate = new Promise<void>((r) => (this.releaseGate = r))
    return { entered, release: () => this.releaseGate?.() }
  }

  async load(id: string): Promise<SerializedInventory | null> {
    return this.snapshots.get(id) ?? null
  }

  async saveMany(invs: SerializedInventory[]): Promise<void> {
    this.onEnter?.()
    this.onEnter = null
    if (this.gate) {
      const g = this.gate
      this.gate = null
      await g
    }
    if (this.failNext) {
      this.failNext = false
      throw new Error('store down')
    }
    for (const inv of invs) this.snapshots.set(inv.id, structuredClone(inv))
  }

  async delete(id: string): Promise<void> {
    this.snapshots.delete(id)
  }
}

const IDLE_MS = 1000

/**
 * Eviction predicate: an inventory leaves memory only when it is idle ∧ unwatched ∧
 * unlocked, and never before its dirty state has been flushed. These tests assert the
 * three guards (each prevents a dupe/desync) and the save-before-evict ordering.
 */
describe('eviction predicate', () => {
  it('evicts an idle, unwatched, unlocked inventory once past the threshold', async () => {
    const store = new InMemoryInventoryStore()
    let now = 0
    const { service, scheduler, registry, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    // Not yet idle: a sweep right after the touch must keep it.
    await scheduler.sweep(IDLE_MS - 1)
    expect(registry.get(id)).not.toBeNull()

    // Past the idle threshold with nothing watching or locking it → evicted.
    await scheduler.sweep(IDLE_MS + 1)
    expect(registry.get(id)).toBeNull()

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('never evicts an inventory with a viewer, however long idle', async () => {
    const store = new InMemoryInventoryStore()
    let now = 0
    const { service, scheduler, registry, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')
    const viewer = 42

    await service.open('stash', id, undefined, viewer)
    await service.addItem(id, 'water', 1)

    now = IDLE_MS * 100
    await scheduler.sweep(now)
    expect(registry.get(id)).not.toBeNull()

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('never evicts an inventory whose lock is held, however long idle', async () => {
    const store = new InMemoryInventoryStore()
    let now = 0
    const { service, scheduler, registry, locks, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    // A mutation elsewhere is mid-flight, holding this id's lock.
    expect(locks.acquire(id)).toBe(true)

    now = IDLE_MS * 100
    await scheduler.sweep(now)
    expect(registry.get(id)).not.toBeNull()

    // Once released, the next sweep is free to evict.
    locks.release(id)
    await scheduler.sweep(now)
    expect(registry.get(id)).toBeNull()

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('persists a dirty inventory before evicting it', async () => {
    const store = new FailableStore()
    let now = 0
    const { service, scheduler, registry, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    now = IDLE_MS * 100
    await scheduler.sweep(now)

    // Evicted from memory, but its unsaved tail landed on disk first.
    expect(registry.get(id)).toBeNull()
    expect((await store.load(id))!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('never evicts an inventory whose flush failed (no lost unsaved tail)', async () => {
    const store = new FailableStore()
    let now = 0
    const { service, scheduler, registry, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    now = IDLE_MS * 100
    store.failOnce()
    // The sweep's flush rejects; the inventory must stay resident, not evicted unsaved.
    await expect(scheduler.sweep(now)).rejects.toThrow()
    expect(registry.get(id)).not.toBeNull()
    expect(await store.load(id)).toBeNull()

    // A later sweep flushes successfully, then evicts.
    await scheduler.sweep(now)
    expect(registry.get(id)).toBeNull()
    expect((await store.load(id))!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('does not evict a still-dirty inventory when a save is already in flight', async () => {
    const store = new FailableStore()
    let now = 0
    const { service, scheduler, registry, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)
    now = IDLE_MS * 100

    // A save-pass is in flight, paused inside saveMany — this id is dirty and mid-save.
    const { entered, release } = store.block()
    const ticking = scheduler.sweep(now)
    await entered

    // A second sweep runs while the first save is in flight. Its flush is a no-op (a save
    // is already running), so the id is still considered dirty → it must NOT be evicted.
    await scheduler.sweep(now)
    expect(registry.get(id)).not.toBeNull()

    release()
    await ticking

    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })

  it('emits `evicted` when an inventory leaves memory, so a drop resource can despawn', async () => {
    const store = new InMemoryInventoryStore()
    let now = 0
    const { service, scheduler, dirty, touch } = makeRig(store, {
      idleMs: IDLE_MS,
      clock: () => now,
    })
    const id = stashInventoryId('a')
    const evicted: InventoryEvictedEvent[] = []
    const onEvicted = (e?: unknown) => evicted.push(e as InventoryEvictedEvent)
    InventoryEvents.on('evicted', onEvicted)

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    now = IDLE_MS * 100
    await scheduler.sweep(now)

    expect(evicted).toEqual([{ inventoryId: id, type: 'stash' }])

    InventoryEvents.off('evicted', onEvicted)
    dirty.dispose()
    touch.dispose()
    scheduler.dispose()
  })
})
