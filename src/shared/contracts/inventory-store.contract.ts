import { SerializedInventory } from '../types/item.types'

/**
 * Persistence boundary for inventory data, proven correct by the exported conformance kit.
 * Abstract class (not interface) so it survives as a runtime DI token.
 */
export abstract class InventoryStoreContract {
  /** `null` when absent — born-fresh, not an error. */
  abstract load(id: string): Promise<SerializedInventory | null>
  /** One transaction: all given inventories land, or none do. */
  abstract saveMany(invs: SerializedInventory[]): Promise<void>
}
