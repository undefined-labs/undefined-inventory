import { describe, expect, it } from 'vitest'
import { createWeaponFactory } from './weapon.factory'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { ItemDefinition, WeaponMeta } from '../../shared/types/item.types'
import { ItemName, asItemName } from '../../shared/types/item-name'

const pistol = asItemName('weapon_pistol')
const flashlight = asItemName('at_flashlight')
const suppressor = asItemName('at_suppressor')

/** A registry that only knows the flashlight — the suppressor is always dangling. */
class FakeRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    return name === flashlight ? def() : null
  }
}

const def = (over: Partial<ItemDefinition> = {}): ItemDefinition => ({
  name: pistol,
  kind: 'weapon',
  label: 'Pistol',
  weight: 1000,
  stack: false,
  ...over,
})

const factory = (over: Partial<Parameters<typeof createWeaponFactory>[0]> = {}) =>
  createWeaponFactory({ registry: new FakeRegistry(), now: () => 0, mintSerial: () => 'SN-1', ...over })

describe('weaponFactory.create', () => {
  it('mints a serial, zeroed ammo, and default (full) durability', () => {
    const meta = factory().create(def())
    expect(meta).toMatchObject({ serial: 'SN-1', ammo: 0, durability: 100, components: [] })
  })

  it('seeds serial/ammo/durability/components from caller input', () => {
    const meta = factory().create(def(), {
      serial: 'SN-9',
      ammo: 12,
      durability: 42,
      components: [flashlight],
    })
    expect(meta).toMatchObject({ serial: 'SN-9', ammo: 12, durability: 42, components: [flashlight] })
  })
})

describe('weaponFactory.validate — component pruning', () => {
  it('prunes a dangling component ref and keeps a valid one', () => {
    const meta = factory().create(def(), { components: [flashlight, suppressor] })
    expect(factory().validate(meta, def()).components).toEqual([flashlight])
  })
})

describe('weaponFactory.validate — lazy decay', () => {
  it('decays durability by elapsed time, evaluated on read (no tick)', () => {
    // Minted at t=0 with degrade=100min; read 50min later → half the bar gone.
    const meta = factory().create(def())
    const read = factory({ now: () => 50 * 60_000 }).validate(meta, def({ degrade: 100 }))
    expect(read.durability).toBe(50)
  })

  it('never decays below zero and leaves a non-degrading weapon untouched', () => {
    const meta = factory().create(def())
    expect(factory({ now: () => 999 * 60_000 }).validate(meta, def({ degrade: 100 })).durability).toBe(0)
    expect(factory({ now: () => 999 * 60_000 }).validate(meta, def()).durability).toBe(100)
  })
})

describe('weaponFactory.stackKey — narrowed identity', () => {
  it('projects the serial, so two weapons with different serials never stack', () => {
    const a = factory().create(def(), { serial: 'SN-A' })
    const b = factory().create(def(), { serial: 'SN-B' })
    expect(factory().stackKey!(a)).not.toBe(factory().stackKey!(b))
  })

  // No-merge-loss: every identity-bearing field must survive the projection. Mutating the sole
  // identity field (serial) MUST change the key; mutating per-instance state must NOT.
  it('covers weapon identity fields (serial) and excludes per-instance state', () => {
    const base = factory().create(def(), { serial: 'SN-A', ammo: 5, durability: 80, components: [flashlight] })
    const key = factory().stackKey!(base)

    const identityFields: (keyof WeaponMeta)[] = ['serial']
    for (const field of identityFields) {
      const mutated = { ...base, [field]: 'CHANGED' } as WeaponMeta
      expect(factory().stackKey!(mutated)).not.toBe(key)
    }

    const stateOnly: WeaponMeta = { ...base, ammo: 0, durability: 1, components: [], durabilityAt: 999 }
    expect(factory().stackKey!(stateOnly)).toBe(key)
  })
})
