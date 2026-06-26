import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { InventoryChangedEvent } from '../../shared/events/inventory-event.types'

/**
 * Tracks inventory ids with unsaved changes by subscribing to `inventory:changed`. Lives
 * outside the aggregate (a subscriber, not a domain flag) to keep the domain pure.
 */
export class DirtySet {
  private ids = new Set<string>()
  private readonly handler = (event?: unknown): void => {
    this.add((event as InventoryChangedEvent).inventoryId)
  }

  constructor(private readonly events: OpenCoreServerLibrary) {
    this.events.on('changed', this.handler)
  }

  add(id: string): void {
    this.ids.add(id)
  }

  /** Remove and return all dirty ids. New mutations land in a fresh set. */
  drain(): string[] {
    const drained = [...this.ids]
    this.ids.clear()
    return drained
  }

  /** Re-queue ids whose save failed, so the next pass retries them. */
  requeue(ids: string[]): void {
    for (const id of ids) this.ids.add(id)
  }

  /** Whether `id` currently has unsaved changes (used by the eviction predicate). */
  has(id: string): boolean {
    return this.ids.has(id)
  }

  get size(): number {
    return this.ids.size
  }

  dispose(): void {
    this.events.off('changed', this.handler)
  }
}
