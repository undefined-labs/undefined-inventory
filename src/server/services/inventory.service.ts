import { inject, injectable } from 'tsyringe'
import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { Inventory, moveItem } from '../../shared/domain/inventory'
import { AccessPolicyContract } from '../../shared/contracts/access-policy.contract'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { InventoryError } from '../../shared/errors'
import {
  ChangeReason,
  InventoryChangedEvent,
  SlotChange,
} from '../../shared/events/inventory-event.types'
import { InventoryContext, ItemDefinition, Meta } from '../../shared/types/item.types'
import { InventoryRegistry } from '../registry/inventory.registry'
import { ViewerRegistry } from '../registry/viewer.registry'
import { TouchTracker } from '../subscribers/touch-tracker'
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
    @inject(ViewerRegistry) private readonly viewers: ViewerRegistry,
    @inject(AccessPolicyContract as never) private readonly access: AccessPolicyContract,
    @inject(InventorySyncContract as never) private readonly sync: InventorySyncContract,
    @inject(TouchTracker) private readonly touch: TouchTracker,
  ) {}

  /**
   * Resolve the live inventory for `id`, loading it on first open. A load miss is normal:
   * the inventory is created born-fresh empty. Capacity always comes from policy.
   */
  async open(
    type: string,
    id: string,
    ctx?: InventoryContext,
    viewer?: number,
  ): Promise<Inventory> {
    // Access gates the open — distance/ownership/faction. A denied viewer never registers
    // and never receives state; access (can-open) is distinct from viewing (currently-watching).
    if (viewer !== undefined && !this.access.canOpen(id, viewer, ctx))
      throw new InventoryError(`player '${viewer}' may not open inventory '${id}'`)

    const live = this.registry.get(id) ?? (await this.hydrate(type, id, ctx))

    if (viewer !== undefined) {
      this.viewers.add(id, viewer)
      this.sync.setInventory(viewer, live.serialize())
    }
    return live
  }

  /** Close a viewer's session — drops them from the viewer set so sync stops targeting them. */
  close(id: string, viewer: number): void {
    this.viewers.remove(id, viewer)
  }

  /** Drop a disconnected player from every inventory they were viewing (O(their opens)). */
  disconnect(player: number): void {
    this.viewers.removePlayer(player)
  }

  /** Load-or-create the live aggregate. Capacity is re-resolved every time, never persisted. */
  private async hydrate(type: string, id: string, ctx?: InventoryContext): Promise<Inventory> {
    const serialized = await this.store.load(id)
    const capacity = this.capacity.resolve(type, id, ctx)
    const inv = serialized
      ? this.registry.from(serialized, capacity)
      : this.registry.create(type, id, capacity)
    this.registry.set(inv)
    // Seed the idle clock so a just-opened, never-mutated inventory isn't instantly
    // eviction-eligible before it has ever been touched.
    this.touch.touch(id)
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
    actor?: number,
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
    } catch (error) {
      // A rejected move emits no `changed`, so the actor's optimistic prediction is never
      // corrected by the broadcast path. Re-assert the slots it named, per-inventory, to the
      // actor — closing the optimism-leak desync.
      if (actor !== undefined)
        this.reassert(actor, [
          { id: fromId, slot: fromSlot },
          { id: toId, slot: toSlot },
        ])
      throw error
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

  /**
   * Unicast the current truth of the given (inventory, slot) refs to one actor, grouped per
   * inventory. Used after a rejected action: re-pushes real slot state so the actor's
   * optimistic prediction snaps back. Refs in unopened inventories are skipped — nothing to
   * assert. A duplicate (id, slot) ref collapses to one re-asserted change.
   */
  private reassert(actor: number, refs: { id: string; slot: number }[]): void {
    const slotsByInventory = new Map<string, Set<number>>()
    for (const { id, slot } of refs) {
      const slots = slotsByInventory.get(id) ?? new Set<number>()
      slots.add(slot)
      slotsByInventory.set(id, slots)
    }
    for (const [id, slots] of slotsByInventory) {
      const inv = this.registry.get(id)
      if (!inv) continue
      this.sync.updateSlots([actor], id, this.toSlotChanges(inv, [...slots]))
    }
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
