import { createServerLibrary } from '@open-core/framework/server'
import {
  InventoryChangedEvent,
  PublicInventoryChanged,
} from '../../shared/events/inventory-event.types'

/** The library-local event bus. Subscribers (DirtySet, sync) listen here. */
export const InventoryEvents = createServerLibrary('inventory')

let bridgeExternalEvents = false

export function configureInventoryEvents(options?: { bridgeExternalEvents?: boolean }): void {
  bridgeExternalEvents = options?.bridgeExternalEvents ?? false
}

/**
 * Emit `inventory:changed` internally, and — only when the bridge is on — externally as a
 * flat public DTO. Bridge defaults OFF so a pure-core server pays no cross-resource cost.
 */
export function emitInventoryChanged(event: InventoryChangedEvent): void {
  InventoryEvents.emit('changed', event)

  if (!bridgeExternalEvents) return

  InventoryEvents.emitExternal('changed', toPublic(event))
}

/** Live internal event → frozen, serialisable public envelope. */
export function toPublic(event: InventoryChangedEvent): PublicInventoryChanged {
  return {
    version: 1,
    inventoryId: event.inventoryId,
    type: event.type,
    changes: event.changes,
    weight: event.weight,
    reason: event.reason,
  }
}
