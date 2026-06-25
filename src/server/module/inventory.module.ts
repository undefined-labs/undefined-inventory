import { GLOBAL_CONTAINER } from '@open-core/framework/kernel'
import type { DependencyContainer } from 'tsyringe'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { configureInventoryEvents, InventoryEvents } from '../events/inventory-events'
import { INVENTORY_EVENTS } from '../events/inventory-events.token'
import { InMemoryInventoryLock } from '../policies/in-memory-lock'
import { TypeMapCapacityPolicy, TypeCapacityMap } from '../policies/type-map-capacity.policy'
import { InventoryRegistry } from '../registry/inventory.registry'
import { InventoryService } from '../services/inventory.service'
import { DirtySet } from '../subscribers/dirty-set'
import { SaveScheduler } from '../subscribers/save-scheduler'

type Constructor<T> = new (...args: any[]) => T
type Provider<T> = T | Constructor<T>

export interface InventoryModuleInstallOptions {
  /** Per-type default capacity for the built-in capacity policy. */
  types?: TypeCapacityMap
  /** Write-behind flush interval (ms). Default 300_000. */
  saveIntervalMs?: number
  /** Mirror `inventory:changed` to a cross-resource event. Default OFF. */
  bridgeExternalEvents?: boolean
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

    // Internal wiring — always installed.
    container.register(INVENTORY_EVENTS, { useValue: InventoryEvents })
    container.registerSingleton(InventoryRegistry, InventoryRegistry)
    container.registerSingleton(InventoryService, InventoryService)

    const dirty = new DirtySet(InventoryEvents)
    container.register(DirtySet, { useValue: dirty })
    const scheduler = new SaveScheduler(
      container.resolve(InventoryStoreContract as never) as InventoryStoreContract,
      container.resolve(InventoryRegistry),
      dirty,
      { saveIntervalMs: options?.saveIntervalMs },
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
    this.reset()
  }

  /** Reset module + container registrations. Primarily for tests. */
  static reset(): void {
    if (this.installed) {
      const container = this.container()
      if (container.isRegistered(SaveScheduler)) container.resolve(SaveScheduler).dispose()
      if (container.isRegistered(DirtySet)) container.resolve(DirtySet).dispose()
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
