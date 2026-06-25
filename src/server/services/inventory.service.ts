import { inject, injectable } from 'tsyringe'
import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { Inventory, moveItem } from '../../shared/domain/inventory'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { InventoryError } from '../../shared/errors'
import {
  ChangeReason,
  InventoryChangedEvent,
  SlotChange,
} from '../../shared/events/inventory-event.types'
import { InventoryContext, ItemDefinition, Meta } from '../../shared/types/item.types'
import { InventoryRegistry } from '../registry/inventory.registry'
import { INVENTORY_EVENTS } from '../events/inventory-events.token'

/**
 * Orchestrates inventory open and mutation. Memory is the source of truth; persistence is
 * write-behind (no per-action DB write).
 */
@injectable()
export class InventoryService {
  constructor(
    @inject(InventoryStoreContract as never) private readonly store: InventoryStoreContract,
    @inject(ItemRegistryContract as never) private readonly items: ItemRegistryContract,
    @inject(CapacityPolicyContract as never) private readonly capacity: CapacityPolicyContract,
    @inject(InventoryRegistry) private readonly registry: InventoryRegistry,
    @inject(InventoryLockContract as never) private readonly locks: InventoryLockContract,
    @inject(INVENTORY_EVENTS) private readonly events: OpenCoreServerLibrary,
  ) {}

  /**
   * Resolve the live inventory for `id`, loading it on first open. A load miss is normal:
   * the inventory is created born-fresh empty. Capacity always comes from policy.
   */
  async open(type: string, id: string, ctx?: InventoryContext): Promise<Inventory> {
    const live = this.registry.get(id)
    if (live) return live

    // capacity is re-resolved every open and never persisted → migration-free resize
    const serialized = await this.store.load(id)
    const capacity = this.capacity.resolve(type, id, ctx)
    const inv = serialized
      ? this.registry.from(serialized, capacity)
      : this.registry.create(type, id, capacity)

    this.registry.set(inv)
    return inv
  }

  /** Add `count` of an item to an open inventory. Emits `inventory:changed`. */
  async addItem(id: string, itemName: string, count: number, metadata?: Meta): Promise<void> {
    const def = this.requireItem(itemName)
    await this.mutate(id, 'add', (inv) => inv.addItem(def, count, metadata))
  }

  /** Remove `count` of an item from an open inventory. Emits `inventory:changed`. */
  async removeItem(id: string, itemName: string, count: number, metadata?: Meta): Promise<void> {
    const def = this.requireItem(itemName)
    await this.mutate(id, 'remove', (inv) => inv.removeItem(def, count, metadata))
  }

  /**
   * Move/split/swap/merge between two slots, within one inventory or across two. Locks are
   * taken in sorted, deduped id order so concurrent moves on overlapping ids serialize
   * without deadlock. Cross-inventory writes go straight to `saveMany` in one transaction —
   * a crash can't leave one side moved and the other not (write-behind would risk that).
   */
  async moveItem(
    fromId: string,
    toId: string,
    fromSlot: number,
    toSlot: number,
    count: number,
  ): Promise<void> {
    const ids = [...new Set([fromId, toId])].sort()
    const acquired: string[] = []
    try {
      for (const id of ids) {
        if (!this.locks.acquire(id)) throw new InventoryError(`inventory '${id}' is locked`)
        acquired.push(id)
      }

      const from = this.requireOpen(fromId)
      const to = this.requireOpen(toId)
      const { fromChanged, toChanged } = moveItem(
        from,
        to,
        fromSlot,
        toSlot,
        count,
        (name) => this.requireItem(name),
      )

      this.emitChanged(from, [fromChanged], 'move')
      if (to !== from) this.emitChanged(to, [toChanged], 'move')

      // Persist both sides atomically. Same-inv → one snapshot (dedupe via the live set).
      const snapshots = [...new Set([from, to])].map((inv) => inv.serialize())
      await this.store.saveMany(snapshots)
    } finally {
      for (const id of acquired.reverse()) this.locks.release(id)
    }
  }

  /**
   * Run a single-inventory domain mutation and emit `inventory:changed`. The lock is held
   * across awaits so a concurrent mutation on the same id can't interleave. Persistence is
   * left to the DirtySet subscriber listening on the event.
   */
  private async mutate(
    id: string,
    reason: ChangeReason,
    op: (inv: Inventory) => number[],
  ): Promise<void> {
    if (!this.locks.acquire(id)) throw new InventoryError(`inventory '${id}' is locked`)
    try {
      const inv = this.requireOpen(id)
      const changed = op(inv)
      this.emitChanged(inv, changed, reason)
    } finally {
      this.locks.release(id)
    }
  }

  /** Translate domain-returned slot numbers into authoritative `SlotChange`s. */
  private toSlotChanges(inv: Inventory, slots: number[]): SlotChange[] {
    return slots.map((slot) => ({ slot, item: inv.getSlot(slot) }))
  }

  private emitChanged(inv: Inventory, changed: number[], reason: ChangeReason): void {
    const event: InventoryChangedEvent = {
      inventoryId: inv.id,
      type: inv.type,
      changes: this.toSlotChanges(inv, changed),
      weight: inv.weight,
      reason,
    }
    this.events.emit('changed', event)
  }

  private requireOpen(id: string): Inventory {
    const inv = this.registry.get(id)
    if (!inv) throw new InventoryError(`inventory '${id}' is not open`)
    return inv
  }

  private requireItem(name: string): ItemDefinition {
    const def = this.items.get(name)
    if (!def) throw new InventoryError(`unknown item '${name}'`)
    return def
  }
}
