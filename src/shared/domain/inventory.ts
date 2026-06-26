import { InventoryError } from '../errors'
import {
  Capacity,
  ItemDefinition,
  Meta,
  SerializedInventory,
  SerializedSlot,
  Slot,
} from '../types/item.types'

/**
 * Inventory aggregate root. Pure: no framework imports, no I/O, no events.
 * Capacity is supplied per hydrate (never persisted) so resizing needs no migration.
 */
export class Inventory {
  readonly id: string
  readonly type: string
  readonly slots: number
  readonly maxWeight: number
  /**
   * Memory-only inventory that is never written to the store (a ground drop). Still fully
   * evictable — when an ephemeral inventory is swept, the `evicted` signal lets a drop
   * resource despawn its world prop. Lives on the aggregate (not inferred from `type`) so the
   * persistence-skip is an explicit property the domain owns.
   */
  readonly ephemeral: boolean
  private items = new Map<number, Slot>()

  constructor(
    id: string,
    type: string,
    capacity: Capacity,
    items: SerializedSlot[] = [],
    options?: { ephemeral?: boolean },
  ) {
    this.id = id
    this.type = type
    this.slots = capacity.slots
    this.maxWeight = capacity.maxWeight
    this.ephemeral = options?.ephemeral ?? false
    for (const slot of items) {
      this.items.set(slot.slot, {
        slot: slot.slot,
        name: slot.name,
        count: slot.count,
        // recomputed on the next add/remove from the item def's per-unit weight
        weight: 0,
        metadata: slot.metadata,
      })
    }
  }

  get weight(): number {
    let total = 0
    for (const slot of this.items.values()) total += slot.weight
    return total
  }

  /**
   * Merge `count` units into matching stacks up to `maxStack`, spilling the remainder to
   * empty slots. Non-stackable → one unit per slot. Returns the changed slot numbers.
   * Rejects (count<=0, over-weight, no room) mutate nothing.
   */
  addItem(def: ItemDefinition, count: number, metadata?: Meta): number[] {
    if (count <= 0) throw new InventoryError('count must be positive')
    if (this.weight + def.weight * count > this.maxWeight)
      throw new InventoryError('exceeds max weight')

    // planPlacement throws on no room before this loop runs → application is atomic
    const plan = this.planPlacement(def, count, metadata)
    for (const step of plan) {
      step.slot.count += step.add
      step.slot.weight = def.weight * step.slot.count
      this.items.set(step.slot.slot, step.slot)
    }
    return [...new Set(plan.map((step) => step.slot.slot))]
  }

  /** Resolve where `count` units land without mutating, honouring `maxStack`. */
  private planPlacement(
    def: ItemDefinition,
    count: number,
    metadata?: Meta,
  ): { slot: Slot; add: number }[] {
    const cap = def.stack ? def.maxStack ?? Infinity : 1
    const steps: { slot: Slot; add: number }[] = []
    let remaining = count

    if (def.stack) {
      for (const existing of this.matchingSlots(def.name, metadata)) {
        if (remaining <= 0) break
        const headroom = cap - existing.count
        if (headroom <= 0) continue // skips over-cap stacks → they never grow
        const add = Math.min(headroom, remaining)
        steps.push({ slot: existing, add })
        remaining -= add
      }
    }

    const taken = new Set<number>()
    while (remaining > 0) {
      const slotNumber = this.firstEmptySlot(taken)
      if (slotNumber === null) throw new InventoryError('no free slot')
      const add = Math.min(cap, remaining)
      steps.push({
        slot: { slot: slotNumber, name: def.name, count: 0, weight: 0, metadata },
        add,
      })
      taken.add(slotNumber)
      remaining -= add
    }
    return steps
  }

  /** Total units of an item across all matching slots. */
  countItem(itemName: string, metadata?: Meta): number {
    let total = 0
    for (const slot of this.matchingSlots(itemName, metadata)) total += slot.count
    return total
  }

  /**
   * Remove `count` units, draining the lowest slot first. Returns the changed slot numbers
   * (including any emptied to zero). Validates the total held before mutating → an
   * over-remove throws and leaves the inventory untouched (no half-drain).
   */
  removeItem(def: ItemDefinition, count: number, metadata?: Meta): number[] {
    if (count <= 0) throw new InventoryError('count must be positive')
    if (this.countItem(def.name, metadata) < count)
      throw new InventoryError('not enough')

    const changed: number[] = []
    let remaining = count
    for (const slot of this.matchingSlots(def.name, metadata)) {
      if (remaining <= 0) break
      const taken = Math.min(remaining, slot.count)
      slot.count -= taken
      remaining -= taken
      if (slot.count === 0) this.items.delete(slot.slot)
      else slot.weight = def.weight * slot.count
      changed.push(slot.slot)
    }
    return changed
  }

  getSlot(slotNumber: number): Slot | null {
    return this.items.get(slotNumber) ?? null
  }

  /**
   * Low-level placement of a known stack into a specific slot, used by `moveItem`. Bypasses
   * the merge/spill planner: the caller has already decided the exact slot and count. Pass
   * `count <= 0` to clear the slot. Weight is recomputed from the supplied definition.
   */
  setSlot(slotNumber: number, def: ItemDefinition, count: number, metadata?: Meta): void {
    if (count <= 0) {
      this.items.delete(slotNumber)
      return
    }
    this.items.set(slotNumber, {
      slot: slotNumber,
      name: def.name,
      count,
      weight: def.weight * count,
      metadata,
    })
  }

  getItems(): Slot[] {
    return [...this.items.values()]
  }

  /** The lowest empty slot index, or `null` if full. Used to target a give server-side. */
  firstFreeSlot(): number | null {
    return this.firstEmptySlot(new Set())
  }

  /** Thin persisted shape: `{ id, type, items }`, empty metadata omitted, no capacity. */
  serialize(): SerializedInventory {
    return {
      id: this.id,
      type: this.type,
      items: this.getItems().map((slot) => {
        const out: SerializedSlot = { slot: slot.slot, name: slot.name, count: slot.count }
        if (slot.metadata && Object.keys(slot.metadata).length > 0)
          out.metadata = slot.metadata
        return out
      }),
    }
  }

  /**
   * Rehydrate a live aggregate. Lenient: an over-cap stack loads as-is, with the cap
   * re-enforced on the next add/remove rather than at load. Capacity comes from policy.
   */
  static from(serialized: SerializedInventory, capacity: Capacity): Inventory {
    return new Inventory(serialized.id, serialized.type, capacity, serialized.items)
  }

  private firstEmptySlot(taken: ReadonlySet<number>): number | null {
    for (let n = 1; n <= this.slots; n++)
      if (!this.items.has(n) && !taken.has(n)) return n
    return null
  }

  /** Matching slots sorted ascending by slot index. Returns live references. */
  private matchingSlots(itemName: string, metadata?: Meta): Slot[] {
    return this.getItems()
      .filter((slot) => slot.name === itemName && sameMeta(slot.metadata, metadata))
      .sort((a, b) => a.slot - b.slot)
  }
}

/** The slot numbers a `moveItem` touched, so the caller can emit precise `changed`s. */
export interface MoveResult {
  fromChanged: number
  toChanged: number
}

/**
 * Relocate units between slots — move, split, merge, or swap, decided by the target slot's
 * state. `defOf` resolves per-unit weight (keeps the domain free of the item registry).
 */
export function moveItem(
  from: Inventory,
  to: Inventory,
  fromSlot: number,
  toSlot: number,
  count: number,
  defOf: (name: string) => ItemDefinition,
): MoveResult {
  // A no-op self-move would have the merge/swap branches write the same slot twice and lose
  // units, so reject it before reading the source.
  if (from === to && fromSlot === toSlot) throw new InventoryError('source and target are the same slot')

  const source = from.getSlot(fromSlot)
  if (!source) throw new InventoryError('source slot is empty')

  // Guard count against the source up front: the empty-target branch trusts it blindly, so an
  // over-count there would conjure units at the target and underflow the source into a dupe.
  if (count <= 0) throw new InventoryError('count must be positive')
  if (count > source.count) throw new InventoryError('count exceeds source stack')

  const sourceDef = defOf(source.name)
  const target = to.getSlot(toSlot)
  const crossInv = from !== to

  // A move within one inventory shifts no net weight, so it stays weight-exempt (even when
  // already over capacity). Across two, the weight arriving at `to` is validated up front.
  const guardTargetWeight = (delta: number): void => {
    if (crossInv && to.weight + delta > to.maxWeight)
      throw new InventoryError('exceeds target max weight')
  }

  // Empty target → move (whole stack) or split (partial); remainder stays at source.
  if (!target) {
    guardTargetWeight(sourceDef.weight * count)
    to.setSlot(toSlot, sourceDef, count, source.metadata)
    from.setSlot(fromSlot, sourceDef, source.count - count, source.metadata)
    return { fromChanged: fromSlot, toChanged: toSlot }
  }

  // Same item + same meta + stackable → merge up to cap; remainder stays at source.
  if (sourceDef.stack && target.name === source.name && sameMeta(target.metadata, source.metadata)) {
    const cap = sourceDef.maxStack ?? Infinity
    const moved = Math.min(count, cap - target.count)
    guardTargetWeight(sourceDef.weight * moved)
    to.setSlot(toSlot, sourceDef, target.count + moved, target.metadata)
    from.setSlot(fromSlot, sourceDef, source.count - moved, source.metadata)
    return { fromChanged: fromSlot, toChanged: toSlot }
  }

  // Occupied by a different item / non-stack / meta-mismatch → swap. Only a whole-stack
  // move can swap; a partial count would have nowhere to put the leftover.
  if (count !== source.count) throw new InventoryError('partial swap is not allowed')

  const targetDef = defOf(target.name)
  // Swap exchanges stacks: `to` loses the target's weight and gains the source's.
  guardTargetWeight(sourceDef.weight * source.count - targetDef.weight * target.count)
  to.setSlot(toSlot, sourceDef, source.count, source.metadata)
  from.setSlot(fromSlot, targetDef, target.count, target.metadata)
  return { fromChanged: fromSlot, toChanged: toSlot }
}

/** Order-independent, deep metadata equality. */
export function sameMeta(a?: Meta, b?: Meta): boolean {
  if (a === b) return true
  if (!a || !b) return false

  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false

  return aKeys.every((key) => {
    const aValue = a[key]
    const bValue = b[key]
    if (isPlainObject(aValue) && isPlainObject(bValue))
      return sameMeta(aValue as Meta, bValue as Meta)
    return aValue === bValue
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
