import { describe, expect, it, vi } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { playerInventoryId, stashInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'
import { InMemoryInventoryStore } from './in-memory.store'
import { HookBus } from '../src/server/policies/hook-bus'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
  bread: { name: asItemName('bread'), label: 'Bread', weight: 100, stack: true },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: ItemName): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class TypeCapacity extends CapacityPolicyContract {
  resolve() {
    return { slots: 50, maxWeight: 120_000 }
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

function makeService(hooks = new HookBus()): {
  service: InventoryService
  hooks: HookBus
} {
  const registry = new InventoryRegistry()
  const service = new InventoryService(
    new InMemoryInventoryStore(),
    new StaticItemRegistry(),
    new TypeCapacity(),
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
    new ViewerRegistry(),
    new AllowAccess(),
    new NoopSync(),
    new TouchTracker(InventoryEvents),
    new AllowGive(),
    hooks,
    new ItemBehaviorRegistry(),
  )
  return { service, hooks }
}

describe('hooks: canMutate veto bus', () => {
  it('a hook returning false aborts the mutation — nothing changes', async () => {
    const { service, hooks } = makeService()
    hooks.register({ canMutate: () => false })
    const id = playerInventoryId('al')
    await service.open('player', id)

    await expect(service.addItem(id, 'water', 1)).rejects.toThrow()

    const inv = await service.open('player', id)
    expect(inv.getSlot(1)).toBeNull()
  })

  it('a throwing hook fails open — the mutation proceeds and the throw is logged loud', async () => {
    const { service, hooks } = makeService()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    hooks.register({
      canMutate: () => {
        throw new Error('boom')
      },
    })
    const id = playerInventoryId('bex')
    await service.open('player', id)

    await service.addItem(id, 'water', 1)

    const inv = await service.open('player', id)
    expect(inv.getSlot(1)?.count).toBe(1)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('hooks AND with short-circuit; a non-boolean return is a pass', async () => {
    const { service, hooks } = makeService()
    // First hook passes by returning a non-boolean (undefined); mutation must still proceed.
    hooks.register({ canMutate: () => undefined })
    const id = playerInventoryId('cy')
    await service.open('player', id)

    await service.addItem(id, 'water', 1)
    expect((await service.open('player', id)).getSlot(1)?.count).toBe(1)

    // Now a vetoing hook followed by a spy: the veto short-circuits, so the spy never runs.
    const after = vi.fn(() => true)
    hooks.register({ canMutate: () => false })
    hooks.register({ canMutate: after })

    await expect(service.addItem(id, 'water', 1)).rejects.toThrow()
    expect(after).not.toHaveBeenCalled()
  })

  it('a move vetoed by either side aborts the whole move atomically', async () => {
    const { service, hooks } = makeService()
    const src = playerInventoryId('dot')
    const dst = stashInventoryId('locker')
    await service.open('player', src)
    await service.open('stash', dst)
    await service.addItem(src, 'water', 2)

    // Veto keyed to the destination side only — yet the whole move must abort, leaving the
    // source stack untouched (atomic: neither side mutates).
    hooks.register({ filter: { inventoryId: dst }, canMutate: () => false })

    await expect(service.moveItem(src, dst, 1, 1, 2)).rejects.toThrow()

    expect((await service.open('player', src)).getSlot(1)?.count).toBe(2)
    expect((await service.open('stash', dst)).getSlot(1)).toBeNull()
  })

  it('a move veto keyed to the source side also aborts the whole move', async () => {
    const { service, hooks } = makeService()
    const src = playerInventoryId('eve')
    const dst = stashInventoryId('vault')
    await service.open('player', src)
    await service.open('stash', dst)
    await service.addItem(src, 'water', 2)

    // The symmetric half of "either side": filtering on the source must fire the veto too.
    hooks.register({ filter: { inventoryId: src }, canMutate: () => false })

    await expect(service.moveItem(src, dst, 1, 1, 2)).rejects.toThrow()

    expect((await service.open('player', src)).getSlot(1)?.count).toBe(2)
    expect((await service.open('stash', dst)).getSlot(1)).toBeNull()
  })
})
