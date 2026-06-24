import { describe, test, expect, beforeEach } from 'vitest'
import { InventoryStoreContract } from '../contracts/inventory-store.contract'
import { SerializedInventory } from '../types/item.types'

export interface StoreConformanceFactory {
  /** A fresh, empty store per test. */
  create(): InventoryStoreContract
  /**
   * Turn a valid inventory into one this store rejects during `saveMany`. Drives the
   * all-or-nothing transaction test. Omit only if the store cannot fail a write.
   */
  poison?(valid: SerializedInventory): SerializedInventory
}

const inv = (id: string, items: SerializedInventory['items'] = []): SerializedInventory => ({
  id,
  type: 'stash',
  items,
})

/**
 * Parametrized store conformance suite, run by both the in-memory fake and downstream real
 * stores. Asserts the forbidden failure modes: silent data loss/corruption, and half-writes.
 */
export function runStoreConformance(
  name: string,
  factory: StoreConformanceFactory,
): void {
  describe(`store conformance: ${name}`, () => {
    let store: InventoryStoreContract
    beforeEach(() => {
      store = factory.create()
    })

    test('load of a missing inventory returns null (born-fresh, not throw)', async () => {
      await expect(store.load('stash:does-not-exist')).resolves.toBeNull()
    })

    test('saveMany then load returns exactly what went in (thin round-trip identity)', async () => {
      const a = inv('stash:a', [{ slot: 1, name: 'water', count: 4 }])
      const b = inv('stash:b', [
        { slot: 2, name: 'phone', count: 1, metadata: { serial: 'xyz' } },
      ])
      await store.saveMany([a, b])

      await expect(store.load('stash:a')).resolves.toEqual(a)
      await expect(store.load('stash:b')).resolves.toEqual(b)
    })

    test('saveMany overwrites a prior snapshot (no stale merge / no corruption)', async () => {
      await store.saveMany([inv('stash:a', [{ slot: 1, name: 'water', count: 4 }])])
      await store.saveMany([inv('stash:a', [{ slot: 1, name: 'water', count: 1 }])])
      const loaded = await store.load('stash:a')
      expect(loaded!.items).toEqual([{ slot: 1, name: 'water', count: 1 }])
    })

    if (factory.poison) {
      const poison = factory.poison
      test('saveMany is one transaction: a poisoned batch lands NEITHER entry', async () => {
        const good = inv('stash:good', [{ slot: 1, name: 'water', count: 4 }])
        const bad = poison(inv('stash:bad', [{ slot: 1, name: 'phone', count: 1 }]))

        await expect(store.saveMany([good, bad])).rejects.toThrow()

        // No half-write: the good entry must NOT have landed.
        await expect(store.load('stash:good')).resolves.toBeNull()
        await expect(store.load('stash:bad')).resolves.toBeNull()
      })
    }
  })
}
