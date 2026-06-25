import { Inventory, moveItem } from './inventory'
import { Capacity, ItemDefinition } from '../types/item.types'

const water: ItemDefinition = { name: 'water', label: 'Water', weight: 100, stack: true }
const ammo: ItemDefinition = {
  name: 'ammo',
  label: 'Ammo',
  weight: 10,
  stack: true,
  maxStack: 10,
}
const phone: ItemDefinition = { name: 'phone', label: 'Phone', weight: 200, stack: false }

const DEFS: Record<string, ItemDefinition> = { water, ammo, phone }
const defOf = (name: string): ItemDefinition => DEFS[name]!

const cap = (slots: number, maxWeight: number): Capacity => ({ slots, maxWeight })
const inv = (slots = 5, maxWeight = 1_000_000) =>
  new Inventory('player:1', 'player', cap(slots, maxWeight))

describe('moveItem — move (full count onto an empty target slot)', () => {
  test('relocates the whole stack, leaving the source slot empty', () => {
    const a = inv()
    a.addItem(water, 3) // slot 1

    const { fromChanged, toChanged } = moveItem(a, a, 1, 4, 3, defOf)

    expect(a.getSlot(1)).toBeNull()
    expect(a.getSlot(4)).toMatchObject({ name: 'water', count: 3 })
    expect(fromChanged).toBe(1)
    expect(toChanged).toBe(4)
  })
})

describe('moveItem — split (partial count onto an empty target slot)', () => {
  test('moves part of the stack, leaving the remainder at the source', () => {
    const a = inv()
    a.addItem(water, 5) // slot 1

    moveItem(a, a, 1, 2, 2, defOf)

    expect(a.getSlot(1)).toMatchObject({ name: 'water', count: 3 })
    expect(a.getSlot(2)).toMatchObject({ name: 'water', count: 2 })
  })
})

describe('moveItem — merge (target holds same item + same meta)', () => {
  test('combines uncapped stacks fully when the whole source fits', () => {
    const a = inv()
    a.setSlot(1, water, 4)
    a.setSlot(2, water, 3)

    moveItem(a, a, 1, 2, 4, defOf) // merge slot 1's 4 into slot 2's 3

    expect(a.getSlot(2)).toMatchObject({ name: 'water', count: 7 })
    expect(a.getSlot(1)).toBeNull()
  })

  test('fills the target to its cap and leaves the remainder at the source', () => {
    const a = inv()
    a.setSlot(1, ammo, 8) // source
    a.setSlot(2, ammo, 6) // target; cap is 10 → headroom 4

    moveItem(a, a, 1, 2, 8, defOf)

    expect(a.getSlot(2)).toMatchObject({ name: 'ammo', count: 10 })
    expect(a.getSlot(1)).toMatchObject({ name: 'ammo', count: 4 }) // 8 - 4 stayed
  })
})

describe('moveItem — swap (target holds a different item)', () => {
  test('exchanges the two stacks when count === source.count', () => {
    const a = inv()
    a.setSlot(1, water, 3)
    a.setSlot(2, phone, 1)

    moveItem(a, a, 1, 2, 3, defOf) // whole water stack onto the phone slot

    expect(a.getSlot(1)).toMatchObject({ name: 'phone', count: 1 })
    expect(a.getSlot(2)).toMatchObject({ name: 'water', count: 3 })
  })

  test('swaps onto a non-stackable target of the same name (one unit each)', () => {
    const a = inv()
    a.setSlot(1, phone, 1, { serial: 'a' })
    a.setSlot(2, phone, 1, { serial: 'b' })

    moveItem(a, a, 1, 2, 1, defOf)

    expect(a.getSlot(1)).toMatchObject({ name: 'phone', metadata: { serial: 'b' } })
    expect(a.getSlot(2)).toMatchObject({ name: 'phone', metadata: { serial: 'a' } })
  })

  test('swaps when only the metadata differs (not a merge)', () => {
    const a = inv()
    a.setSlot(1, water, 2, { q: 'clean' })
    a.setSlot(2, water, 5, { q: 'dirty' })

    moveItem(a, a, 1, 2, 2, defOf)

    expect(a.getSlot(1)).toMatchObject({ count: 5, metadata: { q: 'dirty' } })
    expect(a.getSlot(2)).toMatchObject({ count: 2, metadata: { q: 'clean' } })
  })
})

describe('moveItem — atomic rejection of a partial swap', () => {
  test('partial count onto a different item throws and mutates neither slot', () => {
    const a = inv()
    a.setSlot(1, water, 5)
    a.setSlot(2, phone, 1)

    expect(() => moveItem(a, a, 1, 2, 2, defOf)).toThrow() // count 2 < source 5

    expect(a.getSlot(1)).toMatchObject({ name: 'water', count: 5 })
    expect(a.getSlot(2)).toMatchObject({ name: 'phone', count: 1 })
  })
})

describe('moveItem — weight rules', () => {
  test('same-inv move is weight-exempt even when the inventory is already over capacity', () => {
    // maxWeight 500g; the inventory is already over (8 ammo = 80g... bump to clear over-cap).
    // Use a tight bag that is already at the brim, then rearrange within it.
    const a = new Inventory('player:1', 'player', cap(5, 80)) // 80g cap
    a.setSlot(1, ammo, 8) // 8 × 10g = 80g — exactly full

    // Relocating within the same inventory shifts no net weight → must succeed.
    moveItem(a, a, 1, 3, 8, defOf)

    expect(a.getSlot(3)).toMatchObject({ name: 'ammo', count: 8 })
    expect(a.getSlot(1)).toBeNull()
  })

  test('cross-inv move that would exceed the target weight throws, mutating neither side', () => {
    const a = inv(5, 1_000_000)
    a.setSlot(1, water, 4) // 4 × 100g = 400g

    const b = new Inventory('player:2', 'player', cap(5, 300)) // room for < 400g

    expect(() => moveItem(a, b, 1, 1, 4, defOf)).toThrow()

    expect(a.getSlot(1)).toMatchObject({ name: 'water', count: 4 }) // source intact
    expect(b.getSlot(1)).toBeNull() // target untouched
  })

  test('cross-inv move within the target weight succeeds', () => {
    const a = inv()
    a.setSlot(1, water, 2) // 200g

    const b = new Inventory('player:2', 'player', cap(5, 500))
    moveItem(a, b, 1, 1, 2, defOf)

    expect(a.getSlot(1)).toBeNull()
    expect(b.getSlot(1)).toMatchObject({ name: 'water', count: 2 })
  })
})
