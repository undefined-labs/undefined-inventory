import type { OpenCorePlugin, PluginInstallContext } from '@open-core/framework/server'
import { AccessPolicyContract } from '../../shared/contracts/access-policy.contract'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'
import { HookContract } from '../../shared/contracts/hook.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { InventoryModule, InventoryModuleInstallOptions } from '../module/inventory.module'

type Constructor<T> = new (...args: any[]) => T
type Provider<T> = T | Constructor<T>

export interface InventoryServerPluginOptions extends InventoryModuleInstallOptions {
  store: Provider<InventoryStoreContract>
  items: Provider<ItemRegistryContract>
  capacityPolicy?: Provider<CapacityPolicyContract>
  lock?: Provider<InventoryLockContract>
  /** Authorises open (distance/ownership). Default: distance gate. */
  accessPolicy?: Provider<AccessPolicyContract>
  /** Server→client transport. Default: no-op (swap in a FiveM net adapter for live UI). */
  sync?: Provider<InventorySyncContract>
  /** Pre-commit veto bus. Default: empty (nothing vetoes). */
  hooks?: Provider<HookContract>
}

/**
 * The inventory plugin adds a `stop` lifecycle hook on top of the base plugin contract so
 * the host can trigger the shutdown flush on resource stop.
 */
export interface InventoryServerPlugin extends OpenCorePlugin {
  install(ctx?: PluginInstallContext): void
  stop(): Promise<void>
}

/** One-call install for the inventory library, mirroring `charactersServerPlugin`. */
export function inventoryServerPlugin(
  options: InventoryServerPluginOptions,
): InventoryServerPlugin {
  return {
    name: '@open-core/inventory/server',
    install(_ctx?: PluginInstallContext) {
      InventoryModule.setStore(options.store)
      InventoryModule.setItemRegistry(options.items)
      if (options.capacityPolicy) InventoryModule.setCapacityPolicy(options.capacityPolicy)
      if (options.lock) InventoryModule.setLock(options.lock)
      if (options.accessPolicy) InventoryModule.setAccessPolicy(options.accessPolicy)
      if (options.sync) InventoryModule.setSync(options.sync)
      if (options.hooks) InventoryModule.setHooks(options.hooks)

      InventoryModule.install({
        types: options.types,
        saveIntervalMs: options.saveIntervalMs,
        bridgeExternalEvents: options.bridgeExternalEvents,
        disableDefaultUi: options.disableDefaultUi,
      })
    },
    async stop() {
      await InventoryModule.shutdown()
    },
  }
}
