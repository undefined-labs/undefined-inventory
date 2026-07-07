/**
 * Data shapes for the inventory domain — plus the pure guards that narrow the opaque `Meta`
 * bag back to a named shape (no I/O, no framework).
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

/**
 * Weapon metadata: a serial (the identity-bearing field), lazily-decayed durability, loaded ammo,
 * and attached component refs (canonical {@link ItemName} keys, pruned against the registry on
 * load). `durabilityAt` is decay bookkeeping — the epoch-ms anchor the current durability was last
 * computed at — kept out of stacking identity by the kind's narrowed `stackKey`.
 */
export type WeaponMeta = MetaEnvelope & {
  serial: string
  durability: number
  ammo: number
  components: ItemName[]
  durabilityAt?: number
}

/**
 * Structural guard for {@link WeaponMeta}: true when the four identity/state fields are present
 * with the right primitive shape. `durabilityAt` is optional bookkeeping, so it is not checked.
 * Lets a caller narrow an opaque {@link Meta} bag without an unchecked `as` cast.
 */
export function isWeaponMeta(meta: unknown): meta is WeaponMeta {
  if (typeof meta !== 'object' || meta === null) return false
  const bag = meta as Record<string, unknown>
  return (
    typeof bag.serial === 'string' &&
    typeof bag.durability === 'number' &&
    typeof bag.ammo === 'number' &&
    Array.isArray(bag.components)
  )
}

/**
 * Narrow an opaque {@link Meta} bag to {@link WeaponMeta}, throwing if it is not weapon-shaped.
 * The typed replacement for the accidental `as WeaponMeta` cast — a non-weapon bag fails loudly
 * at the boundary instead of surfacing as a later `undefined` field read.
 */
export function asWeaponMeta(meta: unknown): WeaponMeta {
  if (!isWeaponMeta(meta)) throw new TypeError('metadata is not weapon-shaped')
  return meta
}

/**
 * Container metadata: a minted `uid` referencing the container's own inventory row
 * (`container:<uid>`) and the `size` read from the definition. Contents live in that row, never
 * nested here — the item carries only the reference. `uid` is the sole identity field and each
 * instance mints a fresh one, so the kind's `stackKey` keeps every container in its own slot.
 */
export type ContainerMeta = MetaEnvelope & {
  uid: string
  size: number
}

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
  /**
   * Weapon-kind decay config: minutes for durability to fall from 100 to 0. Absent → the weapon
   * never decays. Read only by the weapon factory's lazy `validate`; there is no background tick.
   */
  degrade?: number
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
  /**
   * The count of leading slots (`1..reservedSlots`) that auto-placement de-prioritises — a
   * player's hotbar. Never a *first* choice for a spill/give/auto-place target: those fill the
   * ordinary slots first and only fall back to a reserved slot when the rest is full. Existing
   * stacks in reserved slots still top up (a merge is not a slot choice). Explicit moves
   * (`moveItem`/`setSlot`) ignore this entirely — the user owns the hotbar directly. Defaults to
   * 0 (no reserved slots), and, like the rest of capacity, is never persisted.
   */
  reservedSlots?: number
}

/**
 * Open-ended context passed through `open` to the policies (capacity/access). Carries
 * per-open hints (e.g. a container's holder item) without coupling them to the service.
 */
export type InventoryContext = Record<string, unknown>
