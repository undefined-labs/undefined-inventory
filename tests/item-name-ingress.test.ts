import { describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { Inventory } from '../src/shared/domain/inventory'

// A catalog keyed on canonical names — the registration ingress runs asItemName once per def.
const ITEMS: Record<string, ItemDefinition> = {
  [asItemName('water')]: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
  [asItemName('WEAPON_PISTOL')]: {
    name: asItemName('WEAPON_PISTOL'),
    kind: 'weapon',
    label: 'Pistol',
    weight: 1000,
    stack: false,
  },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    // No per-lookup case-folding — the key is already canonical when it reaches here.
    return ITEMS[name] ?? null
  }
}

describe('ItemName normalise-at-ingress', () => {
  const registry = new StaticItemRegistry()

  it('resolves both weapon casings to the same registered def', () => {
    expect(registry.get(asItemName('weapon_pistol'))).toBe(registry.get(asItemName('WEAPON_PISTOL')))
    expect(registry.get(asItemName('weapon_pistol'))?.name).toBe('WEAPON_PISTOL')
  })

  it('loads a legacy lowercase save and resolves it without per-lookup case-folding', () => {
    // A store row persisted before branding — a raw, non-canonical name.
    const legacy = { id: 'stash:1', type: 'stash', items: [{ slot: 1, name: 'WATER', count: 4 }] }

    const inv = Inventory.from(legacy, { slots: 10, maxWeight: 5000 })

    // Hydration canonicalised the slot name, so a canonical query matches and the def resolves.
    expect(inv.countItem(asItemName('water'))).toBe(4)
    expect(registry.get(inv.getSlot(1)!.name)).toBe(ITEMS[asItemName('water')])
  })

  it('defaults an existing definition to the baseItem kind (absent === plain)', () => {
    expect(registry.get(asItemName('water'))?.kind).toBeUndefined()
    expect(registry.get(asItemName('WEAPON_PISTOL'))?.kind).toBe('weapon')
  })
})
