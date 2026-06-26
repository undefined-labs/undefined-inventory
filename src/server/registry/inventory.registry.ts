import { Inventory } from '../../shared/domain/inventory'
import { Capacity, SerializedInventory, Slot } from '../../shared/types/item.types'

/** Per-instance hydrate options threaded from the service (e.g. container weight rollup). */
export interface HydrateOptions {
  ephemeral?: boolean
  extraWeightOf?: (slot: Slot) => number
}

/**
 * Identity map (`id → one live instance`) plus the inventory factory. One instance per id
 * is load-bearing: locks key on the id and shared viewers must mutate the same aggregate.
 */
export class InventoryRegistry {
  private live = new Map<string, Inventory>()

  /** The live instance for `id`, or `null` if not currently held. */
  get(id: string): Inventory | null {
    return this.live.get(id) ?? null
  }

  /** Track an instance under its id. */
  set(inv: Inventory): void {
    this.live.set(inv.id, inv)
  }

  /** Every currently-held id. */
  ids(): string[] {
    return [...this.live.keys()]
  }

  /** Drop `id` from memory (post-flush eviction). */
  evict(id: string): void {
    this.live.delete(id)
  }

  /** Create a born-fresh empty inventory. */
  create(type: string, id: string, capacity: Capacity, options?: HydrateOptions): Inventory {
    return new Inventory(id, type, capacity, [], options)
  }

  /** Create a born-fresh ephemeral inventory (a ground drop) — never persisted, still evictable. */
  createEphemeral(type: string, id: string, capacity: Capacity): Inventory {
    return new Inventory(id, type, capacity, [], { ephemeral: true })
  }

  /** Rehydrate a stored inventory. */
  from(serialized: SerializedInventory, capacity: Capacity, options?: HydrateOptions): Inventory {
    return new Inventory(serialized.id, serialized.type, capacity, serialized.items, options)
  }
}
