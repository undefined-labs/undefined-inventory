import { createServerLibrary } from '@open-core/framework/server'
// Self-import so `toPublic`/`toPublicEvicted` are called through the module namespace, keeping
// the DTO-build step interceptable in tests (asserts OFF builds no envelope).
import * as self from './inventory-events'
import {
  InventoryChangedEvent,
  InventoryEvictedEvent,
  PublicInventoryChanged,
  PublicInventoryEvicted,
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

  InventoryEvents.emitExternal('changed', self.toPublic(event))
}

/**
 * Emit `inventory:evicted` internally for every eviction, but mirror it across the resource
 * boundary only for drops. Core stays policy-free (any internal subscriber can react to any
 * type); the wire-scoping lives at the external edge, where the only v1 consumer is a drop
 * resource despawning its world prop. Gated by the same opt-in bridge as `changed`.
 */
export function emitInventoryEvicted(event: InventoryEvictedEvent): void {
  InventoryEvents.emit('evicted', event)

  if (!bridgeExternalEvents || event.type !== 'drop') return

  InventoryEvents.emitExternal('evicted', self.toPublicEvicted(event))
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

/** Live eviction event → frozen public envelope. */
export function toPublicEvicted(event: InventoryEvictedEvent): PublicInventoryEvicted {
  return {
    version: 1,
    inventoryId: event.inventoryId,
    type: event.type,
  }
}
