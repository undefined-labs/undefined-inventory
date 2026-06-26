import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { Inventory } from '../../shared/domain/inventory'
import { InventoryChangedEvent } from '../../shared/events/inventory-event.types'
import { Capacity, SerializedInventory } from '../../shared/types/item.types'

/** Wall-clock source, injectable so tests can drive idle time deterministically. */
export type Clock = () => number

/**
 * Identity map (`id → one live instance`) plus the inventory factory. One instance per id
 * is load-bearing: locks key on the id and shared viewers must mutate the same aggregate.
 *
 * Also holds per-inventory eviction metadata — a mutation-only `lastTouchedAt` stamp, fed
 * by `inventory:changed` so the aggregate stays pure. The stamp drives the idle half of the
 * eviction predicate.
 */
export class InventoryRegistry {
  private live = new Map<string, Inventory>()
  private touchedAt = new Map<string, number>()

  private readonly onChanged = (event?: unknown): void => {
    this.touch((event as InventoryChangedEvent).inventoryId)
  }

  constructor(
    private readonly events?: OpenCoreServerLibrary,
    private readonly clock: Clock = Date.now,
  ) {
    this.events?.on('changed', this.onChanged)
  }

  /** The live instance for `id`, or `null` if not currently held. */
  get(id: string): Inventory | null {
    return this.live.get(id) ?? null
  }

  /** Track an instance under its id. Seeds the idle clock so a just-opened inventory is
   * not immediately eviction-eligible before it has ever been touched. */
  set(inv: Inventory): void {
    this.live.set(inv.id, inv)
    this.touch(inv.id)
  }

  /** Every currently-held id. */
  ids(): string[] {
    return [...this.live.keys()]
  }

  /** When `id` was last mutated, or `undefined` if never touched while held. */
  lastTouchedAt(id: string): number | undefined {
    return this.touchedAt.get(id)
  }

  /** Stamp `id` as just-mutated. Mutation-only — opens and reads never touch. */
  touch(id: string): void {
    this.touchedAt.set(id, this.clock())
  }

  /** Drop `id` from memory (post-flush eviction). */
  evict(id: string): void {
    this.live.delete(id)
    this.touchedAt.delete(id)
  }

  /** Create a born-fresh empty inventory. */
  create(type: string, id: string, capacity: Capacity): Inventory {
    return new Inventory(id, type, capacity)
  }

  /** Rehydrate a stored inventory. */
  from(serialized: SerializedInventory, capacity: Capacity): Inventory {
    return Inventory.from(serialized, capacity)
  }

  dispose(): void {
    this.events?.off('changed', this.onChanged)
  }
}
