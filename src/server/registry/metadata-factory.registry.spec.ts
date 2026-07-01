import { describe, expect, it } from 'vitest'
import { MetadataFactory, MetadataFactoryRegistry, baseItemFactory } from './metadata-factory.registry'
import { ItemDefinition } from '../../shared/types/item.types'
import { asItemName } from '../../shared/types/item-name'

const def = (over: Partial<ItemDefinition> = {}): ItemDefinition => ({
  name: asItemName('water'),
  label: 'Water',
  weight: 1,
  stack: true,
  ...over,
})

describe('baseItemFactory', () => {
  it('create is a passthrough — an empty add mints an empty bag', () => {
    expect(baseItemFactory.create(def())).toEqual({})
    expect(baseItemFactory.create(def(), { serial: 'abc' })).toEqual({ serial: 'abc' })
  })

  it('validate returns the metadata untouched', () => {
    const meta = { serial: 'abc' }
    expect(baseItemFactory.validate(meta, def())).toBe(meta)
  })

  it('ships no stackKey override — the structural envelope default owns identity', () => {
    expect(baseItemFactory.stackKey).toBeUndefined()
  })
})

describe('MetadataFactoryRegistry', () => {
  it('resolves the baseItem factory for a kind-less definition', () => {
    const registry = new MetadataFactoryRegistry()
    expect(registry.resolve(def())).toBe(baseItemFactory)
  })

  it('falls back to baseItem when the definition kind is unregistered', () => {
    const registry = new MetadataFactoryRegistry()
    expect(registry.resolve(def({ kind: 'weapon' }))).toBe(baseItemFactory)
  })

  it('dispatches on def.kind once a kind is registered — no core edit needed', () => {
    const registry = new MetadataFactoryRegistry()
    const weapon: MetadataFactory = { create: () => ({}), validate: (m) => m }

    registry.register('weapon', weapon)

    expect(registry.resolve(def({ kind: 'weapon' }))).toBe(weapon)
    expect(registry.resolve(def())).toBe(baseItemFactory)
  })

  it('rejects double-registering an occupied kind', () => {
    const registry = new MetadataFactoryRegistry()
    const factory: MetadataFactory = { create: () => ({}), validate: (m) => m }

    registry.register('weapon', factory)

    expect(() => registry.register('weapon', factory)).toThrow(/already has a metadata factory/)
  })
})
