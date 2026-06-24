import { InventoryStoreContract } from '../src/shared/contracts/inventory-store.contract'
import { SerializedInventory } from '../src/shared/types/item.types'

/**
 * In-memory store adapter for tests. Crosses the same thin↔fat boundary a real MySQL store
 * crosses, minus the DB, and proves the conformance kit honest by passing it.
 */
export class InMemoryInventoryStore extends InventoryStoreContract {
  private snapshots = new Map<string, string>()

  async load(id: string): Promise<SerializedInventory | null> {
    const snapshot = this.snapshots.get(id)
    return snapshot ? (JSON.parse(snapshot) as SerializedInventory) : null
  }

  async saveMany(invs: SerializedInventory[]): Promise<void> {
    // validate the whole batch before any write → a poison entry can't half-commit
    for (const inv of invs) this.assertValid(inv)
    for (const inv of invs) this.snapshots.set(inv.id, JSON.stringify(inv))
  }

  private assertValid(inv: SerializedInventory): void {
    if (!inv.id) throw new Error('invalid inventory: missing id')
    for (const item of inv.items) {
      if (item.count < 0) throw new Error('invalid inventory: negative count')
    }
  }
}
