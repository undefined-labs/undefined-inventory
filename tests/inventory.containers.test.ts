import { describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { playerInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { HookBus } from '../src/server/policies/hook-bus'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'
import { InMemoryInventoryStore } from './in-memory.store'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: 'water', label: 'Water', weight: 100, stack: true },
  // A bag: a container-backing item. Non-stackable; holds its contents in an own row.
  bag: { name: 'bag', label: 'Bag', weight: 500, stack: false, container: { size: 10 } },
}

class StaticItemRegistry extends ItemRegistryContract {
  get(name: string): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

class TypeCapacity extends CapacityPolicyContract {
  resolve(type: string, _id: string, ctx?: Record<string, unknown>) {
    if (type === 'container') {
      const size = (ctx?.size as number | undefined) ?? 10
      return { slots: size, maxWeight: size * 10_000 }
    }
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

function makeService(store = new InMemoryInventoryStore()): {
  service: InventoryService
  store: InMemoryInventoryStore
  registry: InventoryRegistry
} {
  const registry = new InventoryRegistry()
  const service = new InventoryService(
    store,
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
    new HookBus(),
    new ItemBehaviorRegistry(),
  )
  return { service, store, registry }
}

describe('containers: fresh-container dupe guard', () => {
  it('a brand-new bag is always empty, even when a prior bag stocked the same holder slot', async () => {
    const { service, store } = makeService()
    const holder = playerInventoryId('alice')
    await service.open('player', holder)

    // Mint a bag in slot 1, open its container, stock it, persist.
    await service.addItem(holder, 'bag', 1)
    const first = await service.openContainer(holder, 1)
    await service.addItem(first, 'water', 5)
    await store.saveMany([
      (await service.open('player', holder)).serialize(),
      (await service.open('container', first)).serialize(),
    ])

    // Destroy the parent item — leave the container row in the store as if GC lagged.
    const firstMeta = (await service.open('player', holder)).getSlot(1)!.metadata
    await service.removeItem(holder, 'bag', 1, firstMeta)

    // A brand-new bag lands in the now-empty slot 1. Its uid is freshly minted, so its
    // container id differs from the lingering row — it must hydrate EMPTY.
    await service.addItem(holder, 'bag', 1)
    const second = await service.openContainer(holder, 1)

    expect(second).not.toBe(first)
    const live = await service.open('container', second)
    expect(live.getItems()).toEqual([])
  })
})

describe('containers: own-row hydrate + persistence', () => {
  it('hydrates a stored container row on open and stores items back to that same row', async () => {
    const { service, store } = makeService()
    const holder = playerInventoryId('bob')
    await service.open('player', holder)
    await service.addItem(holder, 'bag', 1)
    const containerId = await service.openContainer(holder, 1)

    // Store into the container, then persist the container's own row.
    await service.addItem(containerId, 'water', 4)
    await store.saveMany([(await service.open('container', containerId)).serialize()])

    // The row lives under the container id (not nested in the holder's snapshot).
    const row = await store.load(containerId)
    expect(row).not.toBeNull()
    expect(row!.type).toBe('container')
    expect(row!.items).toEqual([{ slot: 1, name: 'water', count: 4 }])

    // A fresh service re-opening the same uid hydrates those contents from the row.
    const reopened = makeService(store)
    await reopened.service.open('player', holder) // holder need not be persisted for this
    const uid = containerId.slice('container:'.length)
    const rehydrated = await reopened.service.open('container', containerId, { size: 10 })
    expect(rehydrated.countItem('water')).toBe(4)
    expect(uid.length).toBeGreaterThan(0)
  })
})

describe('containers: weight rollup (depth 1)', () => {
  it("a stocked container's contents count toward the holder's load", async () => {
    const { service } = makeService()
    const holder = playerInventoryId('carol')
    const inv = await service.open('player', holder)
    await service.addItem(holder, 'bag', 1) // 500g empty bag

    const weightWithEmptyBag = inv.weight
    expect(weightWithEmptyBag).toBe(500)

    const containerId = await service.openContainer(holder, 1)
    await service.addItem(containerId, 'water', 3) // 300g of contents

    // The holder's load now reflects the bag's own weight PLUS its contents — no weight cheat.
    expect(inv.weight).toBe(500 + 300)
  })

  it('a holder is blocked from over-weight once container contents are counted', async () => {
    // A holder whose maxWeight only fits the empty bag, not its loaded contents.
    const tight = new (class extends CapacityPolicyContract {
      resolve(type: string, _id: string, ctx?: Record<string, unknown>) {
        if (type === 'container') return { slots: 10, maxWeight: 100_000 }
        return { slots: 50, maxWeight: 600 } // empty bag (500) fits; +water must not
      }
    })()
    const store = new InMemoryInventoryStore()
    const registry = new InventoryRegistry()
    const service = new InventoryService(
      store,
      new StaticItemRegistry(),
      tight,
      registry,
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
    const holder = playerInventoryId('dave')
    const inv = await service.open('player', holder)
    await service.addItem(holder, 'bag', 1)
    const containerId = await service.openContainer(holder, 1)
    await service.addItem(containerId, 'water', 1) // 100g — now holder load = 600

    // Adding directly to the holder would push past 600 once the bag's rolled-up weight counts.
    await expect(service.addItem(holder, 'water', 1)).rejects.toThrow()
    expect(inv.countItem('water')).toBe(0)
  })
})

describe('containers: depth 1 (no nesting)', () => {
  it('refuses to open a container from a bag that itself sits inside a container', async () => {
    const { service } = makeService()
    const holder = playerInventoryId('erin')
    await service.open('player', holder)
    await service.addItem(holder, 'bag', 1)
    const outer = await service.openContainer(holder, 1)

    // Put a second bag INSIDE the first container, then try to open it — nesting is blocked.
    await service.addItem(outer, 'bag', 1)
    await expect(service.openContainer(outer, 1)).rejects.toThrow()
  })
})

describe('containers: orphan GC on destroy', () => {
  it("destroying a bag cascade-deletes its container:uid row and drops the live instance", async () => {
    const { service, store, registry } = makeService()
    const holder = playerInventoryId('frank')
    await service.open('player', holder)
    await service.addItem(holder, 'bag', 1)
    const containerId = await service.openContainer(holder, 1)
    await service.addItem(containerId, 'water', 2)
    await store.saveMany([(await service.open('container', containerId)).serialize()])

    // The row and the live instance both exist before destroy.
    expect(await store.load(containerId)).not.toBeNull()
    expect(registry.get(containerId)).not.toBeNull()

    await service.destroyContainer(holder, 1)

    // Parent item gone from the holder; container row and live instance cascade-deleted.
    const inv = await service.open('player', holder)
    expect(inv.getSlot(1)).toBeNull()
    expect(await store.load(containerId)).toBeNull()
    expect(registry.get(containerId)).toBeNull()
  })

  it('destroying a non-container item is rejected', async () => {
    const { service } = makeService()
    const holder = playerInventoryId('grace')
    await service.open('player', holder)
    await service.addItem(holder, 'water', 3)

    await expect(service.destroyContainer(holder, 1)).rejects.toThrow(/not a container/)
  })
})
