import { Inventory } from '../../shared/domain/inventory'
import { Capacity, SerializedInventory } from '../../shared/types/item.types'

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

  /** Create a born-fresh empty inventory. */
  create(type: string, id: string, capacity: Capacity): Inventory {
    return new Inventory(id, type, capacity)
  }

  /** Rehydrate a stored inventory. */
  from(serialized: SerializedInventory, capacity: Capacity): Inventory {
    return Inventory.from(serialized, capacity)
  }
}
