import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { HookBus } from '../src/server/policies/hook-bus'
import { InventoryEvents, configureInventoryEvents } from '../src/server/events/inventory-events'
import * as inventoryEvents from '../src/server/events/inventory-events'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class FixedCapacityPolicy extends CapacityPolicyContract {
  resolve(): { slots: number; maxWeight: number } {
    return { slots: 10, maxWeight: 5000 }
  }
}

class AllowAccess extends AccessPolicyContract {
  canOpen(): boolean {
    return true
  }
}

class NoopSync extends InventorySyncContract {
  setInventory(): void {}
  updateSlots(): void {}
}

class AllowGive extends GiveAccessContract {
  canReceive(): boolean {
    return true
  }
}

function makeService(): InventoryService {
  return new InventoryService(
    new InMemoryInventoryStore(),
    new StaticItemRegistry(),
    new FixedCapacityPolicy(),
    new InventoryRegistry(),
    new InMemoryInventoryLock(),
    InventoryEvents,
    new ViewerRegistry(),
    new AllowAccess(),
    new NoopSync(),
    new TouchTracker(InventoryEvents),
    new AllowGive(),
    new HookBus(),
    new ItemBehaviorRegistry(),
  )
}

/**
 * The frozen public seam for `changed`. Observers (shops/crafting/logging) depend on the
 * envelope shape + version, never the live aggregate. The bridge is opt-in (default OFF) so a
 * pure-core server pays no cross-resource cost.
 */
describe('external bridge: changed seam', () => {
  afterEach(() => {
    configureInventoryEvents({ bridgeExternalEvents: false })
    vi.restoreAllMocks()
  })

  it('builds no envelope and emits nothing external when the bridge is off (the default)', async () => {
    // No configure call — OFF is the default. A pure-core server must pay zero cross-resource
    // cost: the DTO is never built, not merely built-then-dropped. Spy on `toPublic` to assert
    // the construction itself is skipped, and on `emitExternal` for the wire.
    const toPublic = vi.spyOn(inventoryEvents, 'toPublic')
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    const service = makeService()
    const id = stashInventoryId('locker-1')
    await service.open('stash', id)
    await service.addItem(id, 'water', 3)

    expect(toPublic).not.toHaveBeenCalled()
    expect(external).not.toHaveBeenCalled()
  })

  it('emits a flat versioned envelope when the bridge is on', async () => {
    configureInventoryEvents({ bridgeExternalEvents: true })
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    const service = makeService()
    const id = stashInventoryId('locker-1')
    await service.open('stash', id)
    await service.addItem(id, 'water', 3)

    expect(external).toHaveBeenCalledWith('changed', {
      version: 1,
      inventoryId: id,
      type: 'stash',
      changes: [{ slot: 1, item: expect.objectContaining({ name: 'water', count: 3 }) }],
      weight: 300,
      reason: 'add',
    })
  })

  it('emits two independent envelopes for a cross-inventory move', async () => {
    configureInventoryEvents({ bridgeExternalEvents: true })
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    const service = makeService()
    const from = stashInventoryId('from')
    const to = stashInventoryId('to')
    await service.open('stash', from)
    await service.open('stash', to)
    await service.addItem(from, 'water', 2)
    external.mockClear() // drop the addItem envelope; only the move's emissions matter here

    await service.moveItem(from, to, 1, 1, 2)

    const moves = external.mock.calls.filter(([name]) => name === 'changed')
    expect(moves).toHaveLength(2)
    const ids = moves.map(([, envelope]) => (envelope as { inventoryId: string }).inventoryId)
    expect(new Set(ids)).toEqual(new Set([from, to]))
    for (const [, envelope] of moves) {
      expect(envelope).toMatchObject({ version: 1, reason: 'move' })
    }
  })
})
