import { Slot } from '../types/item.types'

/** Why a change fired — rides on the public envelope so observers can branch. */
export type ChangeReason = 'add' | 'remove' | 'move' | 'use' | 'mutate'

/**
 * One slot's new authoritative state. `item: null` means the slot emptied. State, not
 * coordinates, so the UI repaints with no round-trip. Shared by the NUI + public bridge.
 */
export type SlotChange = { slot: number; item: Slot | null }

/** Internal `inventory:changed` payload — carries the live ids/changes for subscribers. */
export interface InventoryChangedEvent {
  inventoryId: string
  type: string
  changes: SlotChange[]
  weight: number
  reason: ChangeReason
}

/**
 * Flat, serialisable envelope crossing the resource boundary. Versioned by FIELD (the
 * event name `changed` stays stable); never leaks the live aggregate. The frozen seam
 * shops/crafting consume.
 */
export interface PublicInventoryChanged {
  version: 1
  inventoryId: string
  type: string
  changes: SlotChange[]
  weight: number
  reason: ChangeReason
}

/** Internal `inventory:evicted` payload — an inventory was swept from memory after flushing. */
export interface InventoryEvictedEvent {
  inventoryId: string
  type: string
}

/**
 * Flat public envelope for an eviction. Drop-scoped consumers (a drop resource) listen so
 * they can despawn the world prop once its inventory leaves memory — otherwise the prop
 * outlives the data and becomes a ghost pickup.
 */
export interface PublicInventoryEvicted {
  version: 1
  inventoryId: string
  type: string
}
