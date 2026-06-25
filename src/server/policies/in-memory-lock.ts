import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'

/** Default single-node lock backed by a `Set` of held ids. */
export class InMemoryInventoryLock extends InventoryLockContract {
  private held = new Set<string>()

  acquire(id: string): boolean {
    if (this.held.has(id)) return false
    this.held.add(id)
    return true
  }

  release(id: string): void {
    this.held.delete(id)
  }

  isLocked(id: string): boolean {
    return this.held.has(id)
  }
}
