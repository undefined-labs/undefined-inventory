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
  private saving = false

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
    if (this.saving) return
    const ids = this.dirty.drain()
    if (ids.length === 0) return

    this.saving = true
    const snapshots = this.snapshotsFor(ids)
    try {
      await this.store.saveMany(snapshots)
    } catch (error) {
      this.dirty.requeue(ids)
      throw error
    } finally {
      this.saving = false
    }
  }

  /** Stop the interval and persist everything remaining — lossless planned restart. */
  async flushAll(): Promise<void> {
    this.stop()
    await this.flush()
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
