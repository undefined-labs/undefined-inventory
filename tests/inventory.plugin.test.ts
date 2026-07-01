import { afterEach, describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition, SerializedInventory } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { SlotChange } from '../src/shared/events/inventory-event.types'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryModule } from '../src/server/module/inventory.module'
import { inventoryServerPlugin } from '../src/server/plugin/inventory.plugin'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
  WEAPON_PISTOL: {
    name: asItemName('weapon_pistol'),
    kind: 'weapon',
    label: 'Pistol',
    weight: 1000,
    stack: false,
  },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
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

  it('registers the weapon kind as a core factory — a fresh weapon mints a serial', async () => {
    const store = new InMemoryInventoryStore()
    const plugin = inventoryServerPlugin({ store, items: new StaticItemRegistry() })
    await plugin.install()

    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')
    await service.open('stash', id)
    await service.addItem(id, 'WEAPON_PISTOL', 1)
    await plugin.stop?.()

    const slot = (await store.load(id))!.items.find((s) => s.name === 'WEAPON_PISTOL')!
    expect(slot.metadata).toMatchObject({ ammo: 0, durability: 100, components: [] })
    expect(typeof slot.metadata!.serial).toBe('string')
  })

  it('throws when the required store port is missing', () => {
    InventoryModule.setItemRegistry(new StaticItemRegistry())
    expect(() => InventoryModule.install()).toThrow(/store/i)
  })

  it('wires sync by default — opening with a viewer pushes through the supplied sync adapter', async () => {
    const pushed: { player: number; inventoryId: string }[] = []
    class RecordingSync extends InventorySyncContract {
      setInventory(player: number, inventory: SerializedInventory): void {
        pushed.push({ player, inventoryId: inventory.id })
      }
      updateSlots(players: Iterable<number>, inventoryId: string, _c: SlotChange[]): void {
        for (const player of players) pushed.push({ player, inventoryId })
      }
    }

    const plugin = inventoryServerPlugin({
      store: new InMemoryInventoryStore(),
      items: new StaticItemRegistry(),
      sync: new RecordingSync(),
    })
    await plugin.install()

    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id, { player: 7 }, 7)
    await service.addItem(id, 'water', 1)

    // Both the open's setInventory and the change's broadcast reached the viewer.
    expect(pushed).toContainEqual({ player: 7, inventoryId: id })
    expect(pushed.filter((p) => p.player === 7).length).toBeGreaterThanOrEqual(2)
  })

  it('disables the sync subscriber when disableDefaultUi is set — no broadcast on change', async () => {
    const broadcasts: number[] = []
    class CountingSync extends InventorySyncContract {
      setInventory(): void {}
      updateSlots(players: Iterable<number>): void {
        for (const _p of players) broadcasts.push(_p)
      }
    }

    const plugin = inventoryServerPlugin({
      store: new InMemoryInventoryStore(),
      items: new StaticItemRegistry(),
      sync: new CountingSync(),
      disableDefaultUi: true,
    })
    await plugin.install()

    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id, { player: 7 }, 7)
    await service.addItem(id, 'water', 1)

    // Viewer registered, but with the subscriber off, the change isn't broadcast.
    expect(broadcasts).toEqual([])
  })
})
