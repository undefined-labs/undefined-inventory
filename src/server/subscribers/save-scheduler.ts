import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventoryRegistry } from '../registry/inventory.registry'
import { ViewerRegistry } from '../registry/viewer.registry'
import { DirtySet } from './dirty-set'

export interface SaveSchedulerOptions {
  /** Flush interval in ms. Default 300_000 (5 min) — crash loss window is one interval. */
  saveIntervalMs?: number
  /** Idle threshold in ms before an unwatched, unlocked inventory is eviction-eligible. */
  idleMs?: number
}

/**
 * Periodically persists dirty inventories in one `saveMany` transaction (write-behind).
 * A single save runs at a time; failed ids are re-queued so no change is dropped.
 */
export class SaveScheduler {
  private readonly intervalMs: number
  private readonly idleMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  /** The save currently in flight, or null. Held so shutdown can await it. */
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly store: InventoryStoreContract,
    private readonly registry: InventoryRegistry,
    private readonly dirty: DirtySet,
    private readonly viewers: ViewerRegistry,
    private readonly locks: InventoryLockContract,
    options?: SaveSchedulerOptions,
  ) {
    this.intervalMs = options?.saveIntervalMs ?? 300_000
    this.idleMs = options?.idleMs ?? 600_000
  }

  /** Begin the periodic flush+sweep loop. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep(Date.now()), this.intervalMs)
  }

  /**
   * One save-pass: flush dirty state, then evict every inventory that is idle ∧ unwatched ∧
   * unlocked. Flush-before-evict is non-negotiable — an inventory must be on disk before it
   * leaves memory, or its unsaved tail is lost. The three guards prevent dropping a live
   * instance out from under a viewer or lock-holder (a dupe/desync).
   */
  async sweep(now: number): Promise<void> {
    await this.flush()
    // If a save is still running (this pass's flush was a no-op, or another tick's save is
    // mid-flight), some resident state may be unsaved — skip eviction entirely this pass
    // rather than risk dropping an unflushed inventory. The next pass evicts once clean.
    if (this.inFlight) return
    for (const id of this.registry.ids()) {
      if (this.evictable(id, now)) this.registry.evict(id)
    }
  }

  /** Evict iff idle ∧ zero-viewers ∧ no-locks-held. */
  private evictable(id: string, now: number): boolean {
    if (this.viewers.get(id).size > 0) return false
    if (this.locks.isLocked(id)) return false
    const touchedAt = this.registry.lastTouchedAt(id)
    return touchedAt !== undefined && now - touchedAt >= this.idleMs
  }

  /** Persist all currently-dirty inventories in one transaction. */
  async flush(): Promise<void> {
    // No overlapping tick — a save already running covers this pass; new mutations
    // accumulate in the live dirty set and are picked up next tick.
    if (this.inFlight) return
    const ids = this.dirty.drain()
    if (ids.length === 0) return

    this.inFlight = this.save(ids)
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  /**
   * Stop the interval and drain to disk — lossless planned restart.
   * Awaits any in-flight save first (no concurrent saveMany), then keeps flushing
   * until nothing is dirty so mutations that arrived mid-save also land.
   */
  async flushAll(): Promise<void> {
    this.stop()
    // Let an in-flight tick finish before we start writing — never two saveMany at once.
    if (this.inFlight) await this.inFlight.catch(() => {})
    while (this.dirty.size > 0) await this.flush()
  }

  /** One transaction over `ids`; on failure re-queue them for the next pass. */
  private async save(ids: string[]): Promise<void> {
    const snapshots = this.snapshotsFor(ids)
    try {
      await this.store.saveMany(snapshots)
    } catch (error) {
      this.dirty.requeue(ids)
      throw error
    }
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.stop()
  }

  /** Serialize the live aggregates for the given ids, skipping any since evicted. */
  private snapshotsFor(ids: string[]) {
    return ids
      .map((id) => this.registry.get(id))
      .filter((inv): inv is NonNullable<typeof inv> => inv !== null)
      .map((inv) => inv.serialize())
  }
}
