import { SerializedInventory } from '../types/item.types'
import { SlotChange } from '../events/inventory-event.types'

/** State-down messages: full state on open, slot deltas on change. */
export type NuiDownMessage =
  | { kind: 'setInventory'; version: 1; inventory: SerializedInventory }
  | { kind: 'updateSlots'; version: 1; inventoryId: string; changes: SlotChange[] }

/** Actions-up messages the NUI sends. The five-action protocol, narrowed to this slice. */
export type NuiUpMessage =
  | {
      kind: 'move'
      fromInv: string
      fromSlot: number
      toInv: string
      toSlot: number
      count: number
    }
  | { kind: 'use'; inv: string; slot: number }
  | { kind: 'close'; inv: string }

/**
 * Client↔NUI transport. Versioned INDEPENDENTLY of the public bridge (it evolves with the
 * client, not frozen). The library owns the message shapes; the adapter owns the wire
 * (`SendNUIMessage` / NUI callbacks on FiveM — swappable for a different UI runtime).
 */
export abstract class NuiBridgeContract {
  /** Push a state-down message into the NUI. */
  abstract send(message: NuiDownMessage): void

  /** Register the handler the NUI calls with an actions-up message. */
  abstract onMessage(handler: (message: NuiUpMessage) => void): void
}
