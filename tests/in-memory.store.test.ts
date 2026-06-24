import { runStoreConformance } from '../src/shared/testing/store-conformance'
import { SerializedInventory } from '../src/shared/types/item.types'
import { InMemoryInventoryStore } from './in-memory.store'

runStoreConformance('in-memory fake', {
  create: () => new InMemoryInventoryStore(),
  // negative count → the fake rejects it, driving the all-or-nothing path
  poison: (valid: SerializedInventory): SerializedInventory => ({
    ...valid,
    items: [{ slot: 1, name: 'broken', count: -1 }],
  }),
})
