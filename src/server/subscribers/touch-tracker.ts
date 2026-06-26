import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { InventoryChangedEvent } from '../../shared/events/inventory-event.types'

/** Wall-clock source, injectable so tests can drive idle time deterministically. */
export type Clock = () => number

/**
 * Stamps when each inventory was last mutated by subscribing to `inventory:changed`. Lives
 * outside the registry (a subscriber, not the identity map) to keep that map pure — the
 * stamp drives the idle half of the eviction predicate.
 */
export class TouchTracker {
  private touchedAt = new Map<string, number>()
  private readonly handler = (event?: unknown): void => {
    this.touch((event as InventoryChangedEvent).inventoryId)
  }

  constructor(
    private readonly events: OpenCoreServerLibrary,
    private readonly clock: Clock = Date.now,
  ) {
    this.events.on('changed', this.handler)
  }

  /** Stamp `id` as just-mutated. Mutation-only — opens and reads never touch. */
  touch(id: string): void {
    this.touchedAt.set(id, this.clock())
  }

  /** When `id` was last mutated, or `undefined` if never touched while held. */
  lastTouchedAt(id: string): number | undefined {
    return this.touchedAt.get(id)
  }

  /** Forget `id`'s stamp once it leaves memory. */
  forget(id: string): void {
    this.touchedAt.delete(id)
  }

  dispose(): void {
    this.events.off('changed', this.handler)
  }
}
