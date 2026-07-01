import { describe, expect, it } from 'vitest'
import { createContainerFactory } from './container.factory'
import { ContainerMeta, ItemDefinition } from '../../shared/types/item.types'
import { asItemName } from '../../shared/types/item-name'

const backpack = asItemName('backpack')

const def = (over: Partial<ItemDefinition> = {}): ItemDefinition => ({
  name: backpack,
  kind: 'container',
  label: 'Backpack',
  weight: 1000,
  stack: false,
  container: { size: 10 },
  ...over,
})

/** A deterministic uid counter so distinctness is observable. */
const counter = () => {
  let n = 0
  return () => `UID-${++n}`
}

const factory = (mintUid = () => 'UID-1') => createContainerFactory({ mintUid })

describe('containerFactory.create', () => {
  it('mints a uid and records size from the definition', () => {
    const meta = factory().create(def())
    expect(meta).toEqual({ uid: 'UID-1', size: 10 })
  })

  it('seeds uid/size from caller input', () => {
    const meta = factory().create(def(), { uid: 'UID-9', size: 42 })
    expect(meta).toMatchObject({ uid: 'UID-9', size: 42 })
  })

  it('mints a distinct uid per instance from identical definitions', () => {
    const f = factory(counter())
    const a = f.create(def())
    const b = f.create(def())
    expect(a.uid).not.toBe(b.uid)
  })

  it('throws when a container kind has no container.size', () => {
    expect(() => factory().create(def({ container: undefined }))).toThrow(/no container\.size/)
  })
})

describe('containerFactory.validate', () => {
  it('re-reads size from the definition so a resize applies on load', () => {
    const meta = factory().create(def())
    expect(factory().validate(meta, def({ container: { size: 20 } })).size).toBe(20)
  })
})

describe('containerFactory.stackKey — non-stackable by construction', () => {
  it('projects the uid, so two freshly-minted containers never stack', () => {
    const f = factory(counter())
    const a = f.create(def())
    const b = f.create(def())
    expect(f.stackKey!(a)).not.toBe(f.stackKey!(b))
  })

  // No-merge-loss: the sole identity field (uid) must survive; definition-derived size must not.
  it('covers container identity (uid) and excludes definition-derived size', () => {
    const base = factory().create(def(), { uid: 'UID-A', size: 10 })
    const key = factory().stackKey!(base)

    const mutated: ContainerMeta = { ...base, uid: 'UID-B' }
    expect(factory().stackKey!(mutated)).not.toBe(key)

    const sizeOnly: ContainerMeta = { ...base, size: 99 }
    expect(factory().stackKey!(sizeOnly)).toBe(key)
  })
})
