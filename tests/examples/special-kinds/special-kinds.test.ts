import { afterEach, describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../../../src/shared/contracts/item-registry.contract'
import { ItemDefinition } from '../../../src/shared/types/item.types'
import { ItemName, asItemName } from '../../../src/shared/types/item-name'
import { stashInventoryId } from '../../../src/shared/utils/inventory-id'
import { InventoryModule } from '../../../src/server/module/inventory.module'
import { inventoryServerPlugin } from '../../../src/server/plugin/inventory.plugin'
import { InMemoryInventoryStore } from '../../in-memory.store'
import { createGarbageFactory } from './garbage.factory'
import { createIdentificationFactory } from './identification.factory'

/**
 * `garbage` and `identification` are declared as kinds here, in the example resource — core's
 * `ItemKind` never names them. Both are stackable, so the only thing that can keep two apart is
 * their stacking identity, not a `stack: false` flag.
 */
const ITEMS: Record<string, ItemDefinition> = {
  garbage: { name: asItemName('garbage'), kind: 'garbage', label: 'Garbage', weight: 50, stack: true },
  id_card: { name: asItemName('id_card'), kind: 'identification', label: 'ID Card', weight: 0, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

/**
 * Stands up the module, then registers the two special kinds from *outside* core via the public
 * `registerMetadataFactory` seam — exactly how an integrator's own resource would add a kind.
 */
async function installWithSpecialKinds() {
  const store = new InMemoryInventoryStore()
  const plugin = inventoryServerPlugin({ store, items: new StaticItemRegistry() })
  await plugin.install()

  InventoryModule.registerMetadataFactory('garbage', createGarbageFactory())
  InventoryModule.registerMetadataFactory('identification', createIdentificationFactory())

  return { store, plugin }
}

const OWNER_A = { citizenid: 'A1', firstname: 'Ada', lastname: 'Byron', dob: '1815-12-10', sex: 'F' }
const OWNER_B = { citizenid: 'B2', firstname: 'Alan', lastname: 'Turing', dob: '1912-06-23', sex: 'M' }

afterEach(() => {
  InventoryModule.reset()
})

describe('external special-kinds example resource (factory-registry seam)', () => {
  it('mints identification metadata through the externally-registered factory', async () => {
    const { store, plugin } = await installWithSpecialKinds()
    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'id_card', 1, OWNER_A)
    await plugin.stop?.()

    const slot = (await store.load(id))!.items.find((s) => s.name === 'id_card')!
    expect(slot.metadata).toMatchObject(OWNER_A)
  })

  it('never merges two identification cards with distinct owner data (identity preserved)', async () => {
    const { store, plugin } = await installWithSpecialKinds()
    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'id_card', 1, OWNER_A)
    await service.addItem(id, 'id_card', 1, OWNER_B)
    await plugin.stop?.()

    const cards = (await store.load(id))!.items.filter((s) => s.name === 'id_card')
    // Two distinct owners → two slots, each count 1. A merge here would silently destroy a card.
    expect(cards).toHaveLength(2)
    expect(cards.every((s) => s.count === 1)).toBe(true)
    expect(new Set(cards.map((s) => (s.metadata as { citizenid: string }).citizenid))).toEqual(
      new Set(['A1', 'B2']),
    )
  })

  it('stacks two identification cards for the SAME owner (identical identity)', async () => {
    const { store, plugin } = await installWithSpecialKinds()
    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'id_card', 1, OWNER_A)
    await service.addItem(id, 'id_card', 1, { ...OWNER_A })
    await plugin.stop?.()

    const cards = (await store.load(id))!.items.filter((s) => s.name === 'id_card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.count).toBe(2)
  })

  it('stacks garbage across pickups despite distinct fenced extra tags', async () => {
    const { store, plugin } = await installWithSpecialKinds()
    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await service.addItem(id, 'garbage', 1)
    await service.addItem(id, 'garbage', 1)
    await plugin.stop?.()

    const garbage = (await store.load(id))!.items.filter((s) => s.name === 'garbage')
    // Each pickup minted a distinct extra.pickupId, but extra is never identity → one merged stack.
    expect(garbage).toHaveLength(1)
    expect(garbage[0]!.count).toBe(2)
  })

  it('rejects an identification with no owner (a card without an owner is nonsense)', async () => {
    await installWithSpecialKinds()
    const service = InventoryModule.resolveService()
    const id = stashInventoryId('locker-1')

    await service.open('stash', id)
    await expect(service.addItem(id, 'id_card', 1)).rejects.toThrow(/owner field/)
  })
})
