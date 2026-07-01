import { describe, expect, it } from 'vitest'
import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { AccessPolicyContract } from '../src/shared/contracts/access-policy.contract'
import { GiveAccessContract } from '../src/shared/contracts/give-access.contract'
import { InventorySyncContract } from '../src/shared/contracts/inventory-sync.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { ItemName, asItemName } from '../src/shared/types/item-name'
import { SlotChange } from '../src/shared/events/inventory-event.types'
import { playerInventoryId } from '../src/shared/utils/inventory-id'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'
import { ItemBehaviorRegistry } from '../src/server/registry/item-behavior.registry'
import { InMemoryInventoryStore } from './in-memory.store'
import { HookBus } from '../src/server/policies/hook-bus'

const ITEMS: Record<string, ItemDefinition> = {
  water: { name: asItemName('water'), label: 'Water', weight: 100, stack: true },
  // A bandage consumes one unit per use and carries a server-defined effect.
  bandage: { name: asItemName('bandage'), label: 'Bandage', weight: 50, stack: true, consume: 1 },
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

/** Records every slot pushed to an actor so a test can assert a reassert happened. */
class RecordingSync extends InventorySyncContract {
  reasserts: { actor: number; id: string; changes: SlotChange[] }[] = []
  setInventory(): void {}
  updateSlots(actors: number[], id: string, changes: SlotChange[]): void {
    for (const actor of actors) this.reasserts.push({ actor, id, changes })
  }
}

class AllowGive extends GiveAccessContract {
  canReceive(): boolean {
    return true
  }
}

function makeService(hooks = new HookBus(), behaviors = new ItemBehaviorRegistry()) {
  const registry = new InventoryRegistry()
  const sync = new RecordingSync()
  const service = new InventoryService(
    new InMemoryInventoryStore(),
    new StaticItemRegistry(),
    new TypeCapacity(),
    registry,
    new InMemoryInventoryLock(),
    InventoryEvents,
    new ViewerRegistry(),
    new AllowAccess(),
    sync,
    new TouchTracker(InventoryEvents),
    new AllowGive(),
    hooks,
    behaviors,
  )
  return { service, hooks, behaviors, sync }
}

describe('use: consume-first-then-effect', () => {
  it('consumes item.consume before running the handler effect', async () => {
    const { service, behaviors } = makeService()
    const id = playerInventoryId('hank')
    await service.open('player', id)
    await service.addItem(id, 'bandage', 3)

    // The effect reads the live count at the moment it runs; if consume ran first the slot
    // holds 2, proving consume-before-effect ordering rather than the reverse.
    let countSeenByEffect: number | null = null
    behaviors.register('bandage', async () => {
      countSeenByEffect = (await service.open('player', id)).getSlot(1)?.count ?? 0
    })

    await service.use(id, 1)

    expect(countSeenByEffect).toBe(2)
    expect((await service.open('player', id)).getSlot(1)?.count).toBe(2)
  })

  it('a vetoed consume runs no effect, removes nothing, and re-asserts the slot to the actor', async () => {
    const { service, behaviors, hooks, sync } = makeService()
    const id = playerInventoryId('ivy')
    const actor = 7
    await service.open('player', id, undefined, actor)
    await service.addItem(id, 'bandage', 3)

    let effectRan = false
    behaviors.register('bandage', async () => {
      effectRan = true
    })
    // A safe-zone style veto on the consume's remove.
    hooks.register({ filter: { item: 'bandage' }, canMutate: () => false })
    sync.reasserts.length = 0

    await expect(service.use(id, 1, actor)).rejects.toThrow()

    expect(effectRan).toBe(false)
    expect((await service.open('player', id)).getSlot(1)?.count).toBe(3)
    expect(sync.reasserts).toEqual([
      { actor, id, changes: [{ slot: 1, item: expect.objectContaining({ name: 'bandage', count: 3 }) }] },
    ])
  })

  it('using a slot with too few units to consume runs no effect and re-asserts', async () => {
    const { service, behaviors, sync } = makeService()
    const id = playerInventoryId('jay')
    const actor = 9
    await service.open('player', id, undefined, actor)
    // consume is 1 here; use a multi-consume item to force the not-enough path.
    ITEMS.medkit = { name: asItemName('medkit'), label: 'Medkit', weight: 200, stack: true, consume: 5 }
    await service.addItem(id, 'medkit', 2)

    let effectRan = false
    behaviors.register('medkit', async () => {
      effectRan = true
    })
    sync.reasserts.length = 0

    await expect(service.use(id, 1, actor)).rejects.toThrow()

    expect(effectRan).toBe(false)
    expect((await service.open('player', id)).getSlot(1)?.count).toBe(2)
    expect(sync.reasserts).toHaveLength(1)
  })

  it('registering two handlers for one item throws', () => {
    const { behaviors } = makeService()
    behaviors.register('bandage', async () => {})
    expect(() => behaviors.register('bandage', async () => {})).toThrow()
  })

  it('using a non-usable item (no consume) runs no effect and changes nothing', async () => {
    const { service } = makeService()
    const id = playerInventoryId('kit')
    await service.open('player', id)
    await service.addItem(id, 'water', 2)

    await expect(service.use(id, 1)).rejects.toThrow()
    expect((await service.open('player', id)).getSlot(1)?.count).toBe(2)
  })

  it('consuming fires the remove hook (canMutate{kind:remove}) — vetoable per item', async () => {
    const { service, hooks } = makeService()
    const id = playerInventoryId('lou')
    await service.open('player', id)
    await service.addItem(id, 'bandage', 2)

    const seen: string[] = []
    hooks.register({
      canMutate: (e) => {
        seen.push(e.kind)
        return true
      },
    })

    await service.use(id, 1)

    expect(seen).toContain('remove')
  })

  it('an item with no registered handler still consumes (empty default, no crash)', async () => {
    const { service } = makeService()
    const id = playerInventoryId('mae')
    await service.open('player', id)
    await service.addItem(id, 'bandage', 2)

    await service.use(id, 1)

    expect((await service.open('player', id)).getSlot(1)?.count).toBe(1)
  })
})
