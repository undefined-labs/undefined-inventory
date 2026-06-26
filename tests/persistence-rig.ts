import { ItemRegistryContract } from '../src/shared/contracts/item-registry.contract'
import { CapacityPolicyContract } from '../src/shared/contracts/capacity-policy.contract'
import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { ItemDefinition } from '../src/shared/types/item.types'
import { InventoryRegistry } from '../src/server/registry/inventory.registry'
import { ViewerRegistry } from '../src/server/registry/viewer.registry'
import { InMemoryInventoryLock } from '../src/server/policies/in-memory-lock'
import { DistanceAccessPolicy } from '../src/server/policies/distance-access.policy'
import { NoopInventorySync } from '../src/server/transport/noop-sync'
import { InventoryEvents } from '../src/server/events/inventory-events'
import { DirtySet } from '../src/server/subscribers/dirty-set'
import { SaveScheduler } from '../src/server/subscribers/save-scheduler'
import { TouchTracker } from '../src/server/subscribers/touch-tracker'
import { InventoryService } from '../src/server/services/inventory.service'

export const ITEMS: Record<string, ItemDefinition> = {
  water: { name: 'water', label: 'Water', weight: 100, stack: true },
}

export class StaticItemRegistry extends ItemRegistryContract {
  get(name: string): ItemDefinition | null {
    return ITEMS[name] ?? null
  }
}

export class FixedCapacityPolicy extends CapacityPolicyContract {
  resolve(): { slots: number; maxWeight: number } {
    return { slots: 10, maxWeight: 5000 }
  }
}

/**
 * A full persistence rig wired the way the module wires it, but constructed by hand
 * over a caller-supplied store (share one store across a restart boundary, or pass a
 * fake that fails/blocks).
 */
export interface RigOptions {
  /** Idle threshold for eviction; also lets a test inject a deterministic clock. */
  idleMs?: number
  clock?: () => number
}

export function makeRig(store: InventoryStoreContract, options?: RigOptions) {
  const registry = new InventoryRegistry()
  const dirty = new DirtySet(InventoryEvents)
  const touch = new TouchTracker(InventoryEvents, options?.clock)
  const viewers = new ViewerRegistry()
  const locks = new InMemoryInventoryLock()
  const service = new InventoryService(
    store,
    new StaticItemRegistry(),
    new FixedCapacityPolicy(),
    registry,
    locks,
    InventoryEvents,
    viewers,
    new DistanceAccessPolicy(),
    new NoopInventorySync(),
    touch,
  )
  const scheduler = new SaveScheduler(store, registry, dirty, viewers, locks, touch, {
    idleMs: options?.idleMs,
  })
  return { store, registry, dirty, touch, viewers, locks, scheduler, service }
}
