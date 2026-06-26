import { GLOBAL_CONTAINER } from '@open-core/framework/kernel'
import type { DependencyContainer } from 'tsyringe'
import { AccessPolicyContract } from '../../shared/contracts/access-policy.contract'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { configureInventoryEvents, InventoryEvents } from '../events/inventory-events'
import { INVENTORY_EVENTS } from '../events/inventory-events.token'
import { DistanceAccessPolicy } from '../policies/distance-access.policy'
import { InMemoryInventoryLock } from '../policies/in-memory-lock'
import { NoopInventorySync } from '../transport/noop-sync'
import { TypeMapCapacityPolicy, TypeCapacityMap } from '../policies/type-map-capacity.policy'
import { InventoryRegistry } from '../registry/inventory.registry'
import { ViewerRegistry } from '../registry/viewer.registry'
import { InventoryService } from '../services/inventory.service'
import { DirtySet } from '../subscribers/dirty-set'
import { InventorySyncSubscriber } from '../subscribers/inventory-sync.subscriber'
import { SaveScheduler } from '../subscribers/save-scheduler'

type Constructor<T> = new (...args: any[]) => T
type Provider<T> = T | Constructor<T>

export interface InventoryModuleInstallOptions {
  /** Per-type default capacity for the built-in capacity policy. */
  types?: TypeCapacityMap
  /** Write-behind flush interval (ms). Default 300_000. */
  saveIntervalMs?: number
  /** Idle threshold (ms) before an unwatched, unlocked inventory is eviction-eligible. */
  idleMs?: number
  /** Mirror `inventory:changed` to a cross-resource event. Default OFF. */
  bridgeExternalEvents?: boolean
  /** Skip wiring the default sync subscriber, to ship a UI that drives the protocol itself. */
  disableDefaultUi?: boolean
}

/**
 * Idempotent three-tier DI installer: required ports (store, item registry) throw if
 * absent, optional ports (capacity, lock) get a default, internal wiring is always set up.
 */
export class InventoryModule {
  private static installed = false

  static setStore(provider: Provider<InventoryStoreContract>): void {
    this.bind(InventoryStoreContract, provider)
  }

  static setItemRegistry(provider: Provider<ItemRegistryContract>): void {
    this.bind(ItemRegistryContract, provider)
  }

  static setCapacityPolicy(provider: Provider<CapacityPolicyContract>): void {
    this.bind(CapacityPolicyContract, provider)
  }

  static setLock(provider: Provider<InventoryLockContract>): void {
    this.bind(InventoryLockContract, provider)
  }

  static setAccessPolicy(provider: Provider<AccessPolicyContract>): void {
    this.bind(AccessPolicyContract, provider)
  }

  static setSync(provider: Provider<InventorySyncContract>): void {
    this.bind(InventorySyncContract, provider)
  }

  static install(options?: InventoryModuleInstallOptions): void {
    if (this.installed) return
    const container = this.container()

    configureInventoryEvents({ bridgeExternalEvents: options?.bridgeExternalEvents })

    // Required ports — fail loudly if the integrator forgot them.
    if (!container.isRegistered(InventoryStoreContract as never))
      throw new Error(
        'InventoryModule requires an InventoryStoreContract. Use setStore(...) before install().',
      )
    if (!container.isRegistered(ItemRegistryContract as never))
      throw new Error(
        'InventoryModule requires an ItemRegistryContract. Use setItemRegistry(...) before install().',
      )

    // Optional ports — default unless overridden.
    if (!container.isRegistered(CapacityPolicyContract as never))
      container.register(CapacityPolicyContract as never, {
        useValue: new TypeMapCapacityPolicy(options?.types),
      })
    if (!container.isRegistered(InventoryLockContract as never))
      container.register(InventoryLockContract as never, { useValue: new InMemoryInventoryLock() })
    if (!container.isRegistered(AccessPolicyContract as never))
      container.register(AccessPolicyContract as never, { useValue: new DistanceAccessPolicy() })
    if (!container.isRegistered(InventorySyncContract as never))
      container.register(InventorySyncContract as never, { useValue: new NoopInventorySync() })

    // Internal wiring — always installed. The registry subscribes to `inventory:changed`
    // to stamp `lastTouchedAt`, so it's constructed with the event bus rather than
    // auto-resolved.
    container.register(INVENTORY_EVENTS, { useValue: InventoryEvents })
    container.register(InventoryRegistry, { useValue: new InventoryRegistry(InventoryEvents) })
    container.registerSingleton(ViewerRegistry, ViewerRegistry)
    container.registerSingleton(InventoryService, InventoryService)

    // Sync subscriber — wired by default; `disableDefaultUi` opts a custom-UI server out of
    // the built-in broadcast so it can drive the protocol itself.
    if (!options?.disableDefaultUi) {
      const sync = new InventorySyncSubscriber(
        InventoryEvents,
        container.resolve(ViewerRegistry),
        container.resolve(InventorySyncContract as never) as InventorySyncContract,
      )
      container.register(InventorySyncSubscriber, { useValue: sync })
    }

    const dirty = new DirtySet(InventoryEvents)
    container.register(DirtySet, { useValue: dirty })
    const scheduler = new SaveScheduler(
      container.resolve(InventoryStoreContract as never) as InventoryStoreContract,
      container.resolve(InventoryRegistry),
      dirty,
      container.resolve(ViewerRegistry),
      container.resolve(InventoryLockContract as never) as InventoryLockContract,
      { saveIntervalMs: options?.saveIntervalMs, idleMs: options?.idleMs },
    )
    container.register(SaveScheduler, { useValue: scheduler })
    scheduler.start()

    this.installed = true
  }

  static resolveService(): InventoryService {
    if (!this.installed) this.install()
    return this.container().resolve(InventoryService)
  }

  static resolveScheduler(): SaveScheduler {
    return this.container().resolve(SaveScheduler)
  }

  /** Tear down installed wiring (timers, subscribers) and clear the container scope. */
  static async shutdown(): Promise<void> {
    if (!this.installed) return
    const container = this.container()
    const scheduler = container.resolve(SaveScheduler)
    await scheduler.flushAll()
    container.resolve(DirtySet).dispose()
    if (container.isRegistered(InventorySyncSubscriber))
      container.resolve(InventorySyncSubscriber).dispose()
    this.reset()
  }

  /** Reset module + container registrations. Primarily for tests. */
  static reset(): void {
    if (this.installed) {
      const container = this.container()
      if (container.isRegistered(SaveScheduler)) container.resolve(SaveScheduler).dispose()
      if (container.isRegistered(DirtySet)) container.resolve(DirtySet).dispose()
      if (container.isRegistered(InventoryRegistry)) container.resolve(InventoryRegistry).dispose()
      if (container.isRegistered(InventorySyncSubscriber))
        container.resolve(InventorySyncSubscriber).dispose()
    }
    this.container().clearInstances?.()
    this.container().reset?.()
    this.installed = false
  }

  private static bind<T>(token: unknown, provider: Provider<T>): void {
    const container = this.container()
    if (typeof provider === 'function') {
      container.registerSingleton(token as never, provider as never)
      return
    }
    container.register(token as never, { useValue: provider })
  }

  private static container(): DependencyContainer {
    return (globalThis as any).oc_container ?? GLOBAL_CONTAINER
  }
}
