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
  private items = new Map<number, Slot>()

  constructor(id: string, type: string, capacity: Capacity, items: SerializedSlot[] = []) {
    this.id = id
    this.type = type
    this.slots = capacity.slots
    this.maxWeight = capacity.maxWeight
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

  getItems(): Slot[] {
    return [...this.items.values()]
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
