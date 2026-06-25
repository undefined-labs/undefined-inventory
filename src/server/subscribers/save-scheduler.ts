import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventoryRegistry } from '../registry/inventory.registry'
import { DirtySet } from './dirty-set'

export interface SaveSchedulerOptions {
  /** Flush interval in ms. Default 300_000 (5 min) — crash loss window is one interval. */
  saveIntervalMs?: number
}

/**
 * Periodically persists dirty inventories in one `saveMany` transaction (write-behind).
 * A single save runs at a time; failed ids are re-queued so no change is dropped.
 */
export class SaveScheduler {
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  /** The save currently in flight, or null. Held so shutdown can await it. */
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly store: InventoryStoreContract,
    private readonly registry: InventoryRegistry,
    private readonly dirty: DirtySet,
    options?: SaveSchedulerOptions,
  ) {
    this.intervalMs = options?.saveIntervalMs ?? 300_000
  }

  /** Begin the periodic flush loop. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.intervalMs)
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
