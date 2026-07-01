import { Inventory, sameMeta } from './inventory'
import { Capacity, ItemDefinition } from '../types/item.types'
import { asItemName } from '../types/item-name'

const water: ItemDefinition = { name: asItemName('water'), label: 'Water', weight: 500, stack: true }
const phone: ItemDefinition = { name: asItemName('phone'), label: 'Phone', weight: 1000, stack: false }

const cap = (slots: number, maxWeight: number): Capacity => ({ slots, maxWeight })

const makeInventory = () => new Inventory('player:1', 'player', cap(5, 10000))

describe('Inventory.addItem (pure domain)', () => {
  test('merges stackable items into one slot', () => {
    const inv = makeInventory()
    inv.addItem(water, 3)
    inv.addItem(water, 2)
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('splatters non-stackables one per slot', () => {
    const inv = makeInventory()
    expect(inv.addItem(phone, 3)).toEqual([1, 2, 3])
    expect(inv.getItems()).toHaveLength(3)
  })

  test('rejects when over max weight, mutating nothing', () => {
    const inv = makeInventory()
    expect(() => inv.addItem(water, 21)).toThrow() // 500g × 21 > 10kg
    expect(inv.getItems()).toHaveLength(0)
  })

  test('rejects count <= 0, mutating nothing', () => {
    const inv = makeInventory()
    expect(() => inv.addItem(water, 0)).toThrow()
    expect(() => inv.addItem(water, -5)).toThrow()
    expect(inv.getItems()).toHaveLength(0)
  })

  test('throws when no free slot remains, mutating nothing', () => {
    const inv = new Inventory('player:p', 'player', cap(2, 100000))
    inv.addItem(phone, 2) // fills slots 1 and 2
    expect(() => inv.addItem(phone, 1)).toThrow()
    expect(inv.getItems()).toHaveLength(2) // unchanged
  })
})

describe('Inventory stack caps (maxStack: merge to cap, spill to next empty)', () => {
  const ammo: ItemDefinition = {
    name: asItemName('ammo'),
    label: 'Ammo',
    weight: 1,
    stack: true,
    maxStack: 10,
  }

  test('merges up to the cap then spills the remainder to the next empty slot', () => {
    const inv = new Inventory('player:c', 'player', cap(5, 1_000_000))
    inv.addItem(ammo, 25) // cap 10 → 10 + 10 + 5
    expect(inv.getSlot(1)!.count).toBe(10)
    expect(inv.getSlot(2)!.count).toBe(10)
    expect(inv.getSlot(3)!.count).toBe(5)
  })

  test('tops up an existing capped stack before opening a new slot', () => {
    const inv = new Inventory('player:c', 'player', cap(5, 1_000_000))
    inv.addItem(ammo, 6) // slot 1: 6
    inv.addItem(ammo, 8) // fills slot 1 to 10, spills 4 to slot 2
    expect(inv.getSlot(1)!.count).toBe(10)
    expect(inv.getSlot(2)!.count).toBe(4)
  })

  test('a cap that cannot fit (no free slot for spill) throws and mutates nothing', () => {
    const inv = new Inventory('player:c', 'player', cap(1, 1_000_000))
    inv.addItem(ammo, 5)
    expect(() => inv.addItem(ammo, 8)).toThrow() // would need slot 2
    expect(inv.getSlot(1)!.count).toBe(5) // untouched
  })

  test('undefined maxStack means no cap (Infinity)', () => {
    const inv = new Inventory('player:c', 'player', cap(5, 1_000_000))
    inv.addItem(water, 1000)
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(1000)
  })
})

describe('Inventory.removeItem (validate-before-mutate, no half-drain)', () => {
  test('partial remove decrements the stack, slot stays', () => {
    const inv = makeInventory()
    inv.addItem(water, 5)
    expect(inv.removeItem(water, 2)).toEqual([1])
    expect(inv.getSlot(1)!.count).toBe(3)
  })

  test('exact remove empties the slot', () => {
    const inv = makeInventory()
    inv.addItem(water, 3)
    inv.removeItem(water, 3)
    expect(inv.getSlot(1)).toBeNull()
  })

  test('throws when not enough held, and leaves EVERY slot untouched', () => {
    const inv = new Inventory('player:c', 'player', cap(5, 1_000_000))
    inv.addItem(water, 3, { q: 'a' }) // slot 1
    inv.addItem(water, 3, { q: 'b' }) // slot 2 (different meta → different stack)
    // ask for more 'a' water than exists; the low slot must NOT be partially drained
    expect(() => inv.removeItem(water, 5, { q: 'a' })).toThrow()
    expect(inv.getSlot(1)!.count).toBe(3)
    expect(inv.getSlot(2)!.count).toBe(3)
  })

  test('rejects count <= 0', () => {
    const inv = makeInventory()
    inv.addItem(water, 3)
    expect(() => inv.removeItem(water, 0)).toThrow()
    expect(inv.getSlot(1)!.count).toBe(3)
  })
})

describe('sameMeta (order-independent deep equality)', () => {
  test('matches regardless of key order', () => {
    expect(sameMeta({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  test('does not match when values differ', () => {
    expect(sameMeta({ a: 1 }, { a: 2 })).toBe(false)
  })

  test('matches nested objects regardless of key order', () => {
    expect(sameMeta({ x: { p: 1, q: 2 } }, { x: { q: 2, p: 1 } })).toBe(true)
  })

  test('merges add-item stacks only when metadata matches (key order agnostic)', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { a: 1, b: 2 })
    inv.addItem(water, 2, { b: 2, a: 1 })
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('keeps separate stacks when metadata differs', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { quality: 'clean' })
    inv.addItem(water, 2, { quality: 'dirty' })
    expect(inv.getItems()).toHaveLength(2)
  })
})

describe('stackKey default (envelope − overrides − extra)', () => {
  test('identical identity metadata stacks', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { quality: 'clean' })
    inv.addItem(water, 2, { quality: 'clean' })
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('differing only in overrides still stacks', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { quality: 'clean', overrides: { label: 'Spring Water' } })
    inv.addItem(water, 2, { quality: 'clean', overrides: { label: 'Tap Water', weight: 400 } })
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('differing only in extra still stacks', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { quality: 'clean', extra: { foo: 1 } })
    inv.addItem(water, 2, { quality: 'clean', extra: { bar: { deep: true } } })
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('a bag holding only reserved channels stacks with a bare item', () => {
    const inv = makeInventory()
    inv.addItem(water, 3)
    inv.addItem(water, 2, { overrides: { label: 'X' }, extra: { n: 1 } })
    expect(inv.getItems()).toHaveLength(1)
    expect(inv.getSlot(1)!.count).toBe(5)
  })

  test('differing in an identity field does not stack', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { serial: 'A', overrides: { label: 'X' } })
    inv.addItem(water, 2, { serial: 'B', overrides: { label: 'X' } })
    expect(inv.getItems()).toHaveLength(2)
  })

  test('a new identity field is projected automatically (not stacked)', () => {
    const inv = makeInventory()
    inv.addItem(water, 3, { owner: 'alice' })
    inv.addItem(water, 2, { owner: 'bob' })
    expect(inv.getItems()).toHaveLength(2)
  })
})

describe('serialize → from (thin round-trip)', () => {
  test('round-trips the thin shape: { id, type, items }, no capacity, empty meta omitted', () => {
    const inv = makeInventory()
    inv.addItem(water, 4)
    inv.addItem(phone, 1, { serial: 'xyz' })

    const serialized = inv.serialize()
    expect(serialized).toEqual({
      id: 'player:1',
      type: 'player',
      items: [
        { slot: 1, name: 'water', count: 4 }, // no metadata key (empty omitted)
        { slot: 2, name: 'phone', count: 1, metadata: { serial: 'xyz' } },
      ],
    })

    const restored = Inventory.from(serialized, cap(5, 10000))
    expect(restored.serialize()).toEqual(serialized)
    expect(restored.id).toBe('player:1')
    expect(restored.type).toBe('player')
  })

  test('capacity comes from the policy argument, never the persisted data', () => {
    const inv = makeInventory()
    inv.addItem(water, 1)
    const restored = Inventory.from(inv.serialize(), cap(99, 50000))
    expect(restored.slots).toBe(99)
    expect(restored.maxWeight).toBe(50000)
  })
})

describe('lenient rehydrate (grandfather-and-decay: over-cap stack loads, never grows, draws down)', () => {
  const ammo: ItemDefinition = {
    name: asItemName('ammo'),
    label: 'Ammo',
    weight: 1,
    stack: true,
    maxStack: 10,
  }

  const overCap = {
    id: 'player:c',
    type: 'player',
    items: [{ slot: 1, name: 'ammo', count: 25 }], // 25 > maxStack 10
  }

  test('loads an over-cap stack without crashing and WITHOUT force-splitting it', () => {
    const inv = Inventory.from(overCap, cap(5, 1_000_000))
    expect(inv.getSlot(1)!.count).toBe(25) // grandfathered in as-is
    expect(inv.getItems()).toHaveLength(1)
  })

  test('grow-blocked: an add never grows the over-cap slot, never mints a second over-cap slot', () => {
    // The headroom clamp is under test: cap(10) - count(25) is negative → that stack
    // must offer NO merge room (no silent underflow landing the unit in slot 1).
    const inv = Inventory.from(overCap, cap(5, 1_000_000))
    inv.addItem(ammo, 1)
    expect(inv.getSlot(1)!.count).toBe(25) // unchanged — did not grow to 26
    expect(inv.getSlot(2)!.count).toBe(1) // spilled to a fresh slot
    expect(inv.getSlot(2)!.count).toBeLessThanOrEqual(10) // and that slot respects the cap
  })

  test('draws down on remove: the over-cap slot decays monotonically toward <= cap', () => {
    const inv = Inventory.from(overCap, cap(5, 1_000_000))
    inv.removeItem(ammo, 20) // 25 → 5
    expect(inv.getSlot(1)!.count).toBe(5)
    expect(inv.getSlot(1)!.count).toBeLessThanOrEqual(10) // self-healed below cap
  })
})
