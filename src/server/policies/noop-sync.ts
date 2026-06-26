import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'

/**
 * Default sync adapter: drops every push. A pure-core server with no UI pays nothing and
 * needs no FiveM net code. The integrator swaps in a real net adapter via `sync` to light
 * up live client updates (the FiveM adapter is framework-coupled, so it lives downstream —
 * same boundary as the store).
 */
export class NoopInventorySync extends InventorySyncContract {
  setInventory(): void {}
  updateSlots(): void {}
}
