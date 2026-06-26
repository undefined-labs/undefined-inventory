import { SerializedInventory } from '../types/item.types'
import { SlotChange } from '../events/inventory-event.types'

/**
 * Server→client transport for inventory state. The library owns the *protocol* (what is
 * sent); the adapter owns the *wire* (how it reaches the client — FiveM net events, and a
 * RedM or future adapter could swap in behind this same port). Abstract class = DI token.
 */
export abstract class InventorySyncContract {
  /** Full state down to one player on open — the NUI `setInventory`. */
  abstract setInventory(player: number, inventory: SerializedInventory): void

  /** Authoritative slot changes broadcast to every current viewer — the NUI `updateSlots`. */
  abstract updateSlots(players: Iterable<number>, inventoryId: string, changes: SlotChange[]): void
}
