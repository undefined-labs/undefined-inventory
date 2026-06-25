import { afterEach, describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { ItemDefinition, SerializedInventory } from '../src/shared/types/item.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryModule } from '../src/server/module/inventory.module'
import { inventoryServerPlugin } from '../src/server/plugin/inventory.plugin'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: 'water', label: 'Water', weight: 100, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: string): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

afterEach(() => {
  InventoryModule.reset()
})

describe('inventoryServerPlugin', () => {
  it('resolves a working service that mutates and persists end-to-end', async () => {
    const store = new InMemoryInventoryStore()
    const plugin = inventoryServerPlugin({
      store,
      items: new StaticItemRegistry(),
      saveIntervalMs: 50,
    })

    await plugin.install()

    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'water', 4)

    // Shut down via the lifecycle flush — data must land.
    await plugin.stop?.()

    const stored = await store.load(id)
    expect(stored!.items).toEqual<SerializedInventory['items']>([
      { slot: 1, name: 'water', count: 4 },
    ])
  })

  it('throws when the required store port is missing', () => {
    InventoryModule.setItemRegistry(new StaticItemRegistry())
    expect(() => InventoryModule.install()).toThrow(/store/i)
  })
})
