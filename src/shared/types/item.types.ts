/**
 * Data shapes for the inventory domain. Pure declarations — no logic.
 */
import { ItemKind, ItemName } from './item-name'

/** Arbitrary per-stack metadata — part of the merge key (order-independent compare). */
export type Meta = Record<string, unknown>

/**
 * Definition-shadow channel: per-instance overrides of a definition's cosmetic/weight fields.
 * Never identity — two stacks differing only here still stack (excluded from `stackKey`).
 */
export interface MetaOverrides {
  weight?: number
  label?: string
  image?: string
}

/**
 * The two reserved, non-identity channels shared by every kind's metadata envelope. Both are
 * excluded from stacking identity by construction: `overrides` shadows the definition, `extra`
 * is fenced open-ended modder data. Everything else in the bag is identity.
 */
export interface MetaEnvelope {
  overrides?: MetaOverrides
  /** Open-ended modder scratch. Never identity; a size/depth bound is owed at the client ingress. */
  extra?: Record<string, unknown>
}

/**
 * Plain-item metadata: the whole open bag is identity, plus the reserved envelope channels.
 * The default `stackKey` (envelope − `overrides` − `extra`) makes any new identity field count
 * automatically, while override/extra additions never fragment a stack.
 */
export type BaseItemMeta = MetaEnvelope & Meta

/** Static item template (ox data/items.lua). */
export interface ItemDefinition {
  name: ItemName
  /** The item's kind; absent is treated as `baseItem`, so existing definitions need no change. */
  kind?: ItemKind
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
  /**
   * Marks this item as a container holder (a bag/wallet/mail-package). Its contents live in
   * an own inventory row keyed `container:<metadata.uid>`, not nested in the item's metadata;
   * the item carries only the reference. `size` sets the container's capacity. A container
   * item is non-stackable by construction — each instance owns a distinct row.
   */
  container?: { size: number }
  /**
   * Units removed per `use`. Its presence marks an item as usable (a consumable/tool); the
   * count is the data side of a use, the effect lives in the `ItemBehaviorRegistry`. Absent →
   * the item is not usable.
   */
  consume?: number
}

/** A live stack occupying one slot. */
export interface Slot {
  /** 1-based slot index */
  slot: number
  /** Canonical key — normalised at hydration, so the live aggregate never re-case-folds. */
  name: ItemName
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
