import { describe, expect, it } from 'vitest'
import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { SerializedInventory } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { makeRig } from './persistence-rig'

/**
 * A store the test fully controls: it can be made to fail the next save, and to
 * block a save mid-flight on a manually-released gate (to drive concurrency).
 */
class ControllableStore extends InventoryStoreContract {
  private snapshots = new Map<string, SerializedInventory>()
  /** Every batch handed to saveMany, in order — for asserting no double-write. */
  readonly batches: SerializedInventory[][] = []
  /** Saves currently inside saveMany — proves no two overlap. */
  inFlight = 0
  maxConcurrent = 0

  private failNext = false
  private gate: Promise<void> | null = null
  private releaseGate: (() => void) | null = null
  private onEnter: (() => void) | null = null

  /** The next saveMany rejects. */
  failOnce(): void {
    this.failNext = true
  }

  /**
   * Block the next saveMany until `release()` is called. The returned `entered`
   * promise resolves once saveMany has actually entered, so the test can interleave.
   */
  block(): { entered: Promise<void>; release: () => void } {
    const entered = new Promise<void>((r) => (this.onEnter = r))
    this.gate = new Promise<void>((r) => (this.releaseGate = r))
    return { entered, release: () => this.releaseGate?.() }
  }

  async load(id: string): Promise<SerializedInventory | null> {
    const snap = this.snapshots.get(id)
    return snap ? structuredClone(snap) : null
  }

  async saveMany(invs: SerializedInventory[]): Promise<void> {
    this.inFlight++
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
    this.onEnter?.()
    this.onEnter = null
    try {
      if (this.gate) {
        const g = this.gate
        this.gate = null
        await g
      }
      if (this.failNext) {
        this.failNext = false
        throw new Error('store down')
      }
      this.batches.push(invs.map((i) => structuredClone(i)))
      for (const inv of invs) this.snapshots.set(inv.id, structuredClone(inv))
    } finally {
      this.inFlight--
    }
  }

  async delete(id: string): Promise<void> {
    this.snapshots.delete(id)
  }
}

describe('persistence hardening', () => {
  it('re-queues ids when saveMany fails, and the next flush retries them', async () => {
    const store = new ControllableStore()
    const { service, scheduler, dirty } = makeRig(store)
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    store.failOnce()
    await expect(scheduler.flush()).rejects.toThrow()

    // Nothing landed, but the id is still dirty.
    expect(await store.load(id)).toBeNull()

    // Next tick retries and succeeds.
    await scheduler.flush()
    expect((await store.load(id))!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])

    dirty.dispose()
    scheduler.dispose()
  })

  it('does not lose a mutation that arrives while a save is in flight', async () => {
    const store = new ControllableStore()
    const { service, scheduler, dirty } = makeRig(store)
    const id = stashInventoryId('a')

    await service.open('stash', id)
    await service.addItem(id, 'water', 1)

    // Start a flush and pause it inside saveMany.
    const { entered, release } = store.block()
    const flushing = scheduler.flush()
    await entered

    // A mutation lands while the first save is mid-flight.
    await service.addItem(id, 'water', 1)

    release()
    await flushing

    // The in-flight save wrote count=1; the mid-flight mutation must survive to a later tick.
    await scheduler.flush()
    expect((await store.load(id))!.items).toEqual([{ slot: 1, name: 'water', count: 2 }])

    dirty.dispose()
    scheduler.dispose()
  })

  it('shutdown awaits the in-flight save then flushes the remainder, with no overlap', async () => {
    const store = new ControllableStore()
    const { service, scheduler, dirty } = makeRig(store)
    const a = stashInventoryId('a')
    const b = stashInventoryId('b')

    await service.open('stash', a)
    await service.addItem(a, 'water', 1)

    // A tick is in flight, paused inside saveMany (saving 'a').
    const { entered, release } = store.block()
    const ticking = scheduler.flush()
    await entered

    // A new inventory goes dirty while that save is mid-flight.
    await service.open('stash', b)
    await service.addItem(b, 'water', 2)

    // Shutdown is requested while the tick is still in flight.
    const shuttingDown = scheduler.flushAll()
    release()
    await Promise.all([ticking, shuttingDown])

    // No two saveMany ran at once.
    expect(store.maxConcurrent).toBe(1)

    // Both inventories persisted — the in-flight one and the remainder.
    expect((await store.load(a))!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])
    expect((await store.load(b))!.items).toEqual([{ slot: 1, name: 'water', count: 2 }])

    dirty.dispose()
    scheduler.dispose()
  })
})
