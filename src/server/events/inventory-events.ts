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

/** The internal events a consumer can subscribe to, mapped to the payload each carries. */
export interface InventoryEventMap {
  changed: InventoryChangedEvent
  evicted: InventoryEvictedEvent
}

/**
 * Typed subscription facade over {@link InventoryEvents}. The raw bus types every handler param as
 * `payload?: T` (the emit contract allows a bare signal), forcing consumers to accept `T | undefined`
 * even though every inventory emit above always passes a payload. This surface hands back a
 * non-optional `T`, and passes the handler reference straight through so `off` still deregisters it.
 */
export const InventoryEventBus = {
  on<K extends keyof InventoryEventMap>(
    event: K,
    handler: (payload: InventoryEventMap[K]) => void,
  ): void {
    // The bus types the param as `payload?: T`; every inventory emit passes one, so widening the
    // handler to the optional-param form is sound and keeps the reference stable for `off`.
    InventoryEvents.on<InventoryEventMap[K]>(event, handler as (payload?: InventoryEventMap[K]) => void)
  },
  off<K extends keyof InventoryEventMap>(
    event: K,
    handler: (payload: InventoryEventMap[K]) => void,
  ): void {
    InventoryEvents.off<InventoryEventMap[K]>(event, handler as (payload?: InventoryEventMap[K]) => void)
  },
}

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
