/**
 * Data shapes for the inventory domain. Pure declarations — no logic, no imports.
 */

/** Arbitrary per-stack metadata — part of the merge key (order-independent compare). */
export type Meta = Record<string, unknown>

/** Static item template (ox data/items.lua). */
export interface ItemDefinition {
  name: string
  label: string
  /** grams, per single unit */
  weight: number
  /** can multiple units share one slot? */
  stack: boolean
  /**
   * Per-item stack cap. `undefined === Infinity` (no cap). Lives on the definition /
   * registry, NEVER persisted → changing it costs zero DB migration.
   */
  maxStack?: number
}

/** A live stack occupying one slot. */
export interface Slot {
  /** 1-based slot index */
  slot: number
  name: string
  count: number
  /** cached weight = def.weight * count */
  weight: number
  metadata?: Meta
}

/** The persisted form of a single slot — empty metadata omitted. */
export interface SerializedSlot {
  slot: number
  name: string
  count: number
  metadata?: Meta
}

/**
 * The thin, persisted shape. Carries NO capacity (`slots`/`maxWeight`) — capacity is
 * re-resolved from policy on every hydrate, never stored → migration-free resize.
 */
export interface SerializedInventory {
  id: string
  type: string
  items: SerializedSlot[]
}

/** Capacity, resolved by policy and passed into `Inventory.from` — never persisted. */
export interface Capacity {
  slots: number
  maxWeight: number
}

/**
 * Open-ended context passed through `open` to the policies (capacity/access). Carries
 * per-open hints (e.g. a container's holder item) without coupling them to the service.
 */
export type InventoryContext = Record<string, unknown>
