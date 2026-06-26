import { inject, injectable } from 'tsyringe'
import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { Inventory, moveItem } from '../../shared/domain/inventory'
import { AccessPolicyContract } from '../../shared/contracts/access-policy.contract'
import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryStoreContract } from '../../shared/contracts/inventory-store.contract'
import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'
import { GiveAccessContract } from '../../shared/contracts/give-access.contract'
import { HookContract } from '../../shared/contracts/hook.contract'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { InventoryError } from '../../shared/errors'
import { dropInventoryId, containerInventoryId, parseInventoryId } from '../../shared/utils/inventory-id'
import { randomUUID } from 'node:crypto'
import {
  ChangeReason,
  InventoryChangedEvent,
  SlotChange,
} from '../../shared/events/inventory-event.types'
import { InventoryContext, ItemDefinition, Meta, Slot } from '../../shared/types/item.types'
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
    @inject(GiveAccessContract as never) private readonly giveAccess: GiveAccessContract,
    @inject(HookContract as never) private readonly hooks: HookContract,
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
    // A container is never itself a holder (depth 1), so only non-container inventories roll up
    // contained weight — this also stops the rollup from recursing past one level.
    const options =
      type === 'container' ? undefined : { extraWeightOf: this.containerWeightOf }
    const inv = serialized
      ? this.registry.from(serialized, capacity, options)
      : this.registry.create(type, id, capacity, options)
    this.registry.set(inv)
    // Seed the idle clock so a just-opened, never-mutated inventory isn't instantly
    // eviction-eligible before it has ever been touched.
    this.touch.touch(id)
    return inv
  }

  /**
   * Rolled-up weight a holder slot contributes beyond its own stack: the live weight of the
   * container it backs (depth 1). Zero unless the slot holds a container item whose row is
   * currently open. An unopened container contributes nothing here — its weight only counts
   * once it (and thus its contents) is hydrated, matching ox's open-to-weigh behaviour.
   */
  private readonly containerWeightOf = (slot: Slot): number => {
    const def = this.items.get(slot.name)
    const uid = slot.metadata?.uid as string | undefined
    if (!def?.container || !uid) return 0
    const container = this.registry.get(containerInventoryId(uid))
    return container ? container.weight : 0
  }

  /** Add `count` of an item to an open inventory. Emits `inventory:changed`. */
  async addItem(id: string, itemName: string, count: number, metadata?: Meta): Promise<void> {
    const def = this.requireItem(itemName)
    // A container item gets a freshly-minted uid so its contents row is keyed to THIS instance
    // alone — a brand-new bag can never alias a destroyed one's lingering row (the dupe guard).
    const meta = def.container ? { ...metadata, uid: metadata?.uid ?? randomUUID() } : metadata
    await this.mutate(id, 'add', (inv) => inv.addItem(def, count, meta), {
      kind: 'add',
      item: itemName,
      count,
      metadata: meta,
    })
  }

  /**
   * Open the container backed by the item in `holderId`'s `holderSlot`, hydrating its own row
   * (`container:<uid>`). Capacity comes from the item's `container.size`. Depth is capped at 1:
   * a container item may not be opened from inside another container.
   */
  async openContainer(
    holderId: string,
    holderSlot: number,
    viewer?: number,
  ): Promise<string> {
    const holder = this.requireOpen(holderId)
    if (parseInventoryId(holderId).type === 'container')
      throw new InventoryError('container nesting is not allowed (depth 1)')

    const item = holder.getSlot(holderSlot)
    if (!item) throw new InventoryError(`holder slot ${holderSlot} is empty`)
    const def = this.requireItem(item.name)
    if (!def.container) throw new InventoryError(`item '${item.name}' is not a container`)
    const uid = item.metadata?.uid as string | undefined
    if (!uid) throw new InventoryError(`container item '${item.name}' has no uid`)

    const id = containerInventoryId(uid)
    await this.open('container', id, { size: def.container.size }, viewer)
    return id
  }

  /** Remove `count` of an item from an open inventory. Emits `inventory:changed`. */
  async removeItem(id: string, itemName: string, count: number, metadata?: Meta): Promise<void> {
    const def = this.requireItem(itemName)
    await this.mutate(id, 'remove', (inv) => inv.removeItem(def, count, metadata), {
      kind: 'remove',
      item: itemName,
      count,
      metadata,
    })
  }

  /**
   * Tear down the container parent at `holderId/holderSlot`: remove the parent item and
   * cascade-delete the container's own row, evicting its live instance (orphan-GC) — without
   * this, a destroyed bag's contents would linger as an unreachable junk row. Done under the
   * holder's lock so the destroy and cascade can't interleave with a concurrent mutation.
   * Scoped to containers; destroying arbitrary items is intentionally out of scope.
   */
  async destroyContainer(holderId: string, holderSlot: number): Promise<void> {
    if (!this.locks.acquire(holderId))
      throw new InventoryError(`inventory '${holderId}' is locked`)
    try {
      const holder = this.requireOpen(holderId)
      const item = holder.getSlot(holderSlot)
      if (!item) throw new InventoryError(`holder slot ${holderSlot} is empty`)
      const def = this.requireItem(item.name)
      const uid = item.metadata?.uid as string | undefined
      if (!def.container || !uid)
        throw new InventoryError(`item '${item.name}' at slot ${holderSlot} is not a container`)

      holder.setSlot(holderSlot, def, 0)
      this.emitChanged(holder, [holderSlot], 'remove')

      // Cascade the container row only after the parent is gone from the holder.
      const containerId = containerInventoryId(uid)
      this.registry.evict(containerId)
      await this.store.delete(containerId)
    } finally {
      this.locks.release(holderId)
    }
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

      // Pre-commit veto inside the critical section. The event carries both ends, so a hook
      // filtered to either side fires; a veto aborts the whole move before anything mutates.
      // An empty source has no item to gate, so the bus is skipped — `moveItem` rejects it anyway.
      const moving = from.getSlot(fromSlot)
      if (
        moving &&
        !this.hooks.canMutate({
          kind: 'move',
          from: { inventoryId: fromId, type: from.type },
          to: { inventoryId: toId, type: to.type },
          item: moving.name,
          count,
        })
      )
        throw new InventoryError(`move from '${fromId}' to '${toId}' was vetoed`)

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
      // Ephemeral sides (a drop) are skipped — they never touch the store, even mid-move.
      const snapshots = [...new Set([from, to])]
        .filter((inv) => !inv.ephemeral)
        .map((inv) => inv.serialize())
      if (snapshots.length > 0) await this.store.saveMany(snapshots)
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
   * Drop `count` units from `fromSlot` onto the ground: mint an ephemeral `drop:` inventory,
   * move the stack into it, and return its id. The drop is never persisted (ephemeral) but is
   * fully evictable — its eventual eviction emits the drop-scoped `evicted` signal a drop
   * resource uses to despawn the world prop. World placement is the resource's job, not ours.
   */
  async drop(fromId: string, fromSlot: number, count: number, actor?: number): Promise<string> {
    const id = dropInventoryId(randomUUID())
    const capacity = this.capacity.resolve('drop', id)
    const drop = this.registry.createEphemeral('drop', id, capacity)
    this.registry.set(drop)
    this.touch.touch(id)
    // Land in the drop's first slot — a freshly-minted drop is empty, so slot 1 is free.
    await this.moveItem(fromId, id, fromSlot, 1, count, actor)
    return id
  }

  /**
   * Give `count` units from `fromSlot` to a nearby player's inventory. The destination slot
   * is resolved server-side (the target's first free slot) — never trusted from the actor,
   * who can't see into an inventory they may not open. Gated by `canReceive` (proximity +
   * target-not-busy); a rejected give re-asserts the source slot to the actor so their
   * optimistic prediction snaps back. Can-carry is enforced by the domain move, not here.
   */
  async give(
    fromId: string,
    fromSlot: number,
    count: number,
    targetId: string,
    actor: number,
    ctx?: InventoryContext,
  ): Promise<void> {
    const target = this.requireOpen(targetId)

    // A give rejected before the move emits no `changed`, so — like a rejected move — the
    // actor's optimistic prediction is never corrected. Snap the source slot back to them.
    const rejectGive = (message: string): never => {
      this.reassert(actor, [{ id: fromId, slot: fromSlot }])
      throw new InventoryError(message)
    }

    if (!this.giveAccess.canReceive(targetId, actor, ctx))
      return rejectGive(`player '${actor}' may not give to '${targetId}'`)

    const toSlot = target.firstFreeSlot()
    if (toSlot === null) return rejectGive(`target inventory '${targetId}' is full`)

    await this.moveItem(fromId, targetId, fromSlot, toSlot, count, actor)
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
    event: { kind: 'add' | 'remove'; item: string; count: number; metadata?: Meta },
  ): Promise<void> {
    if (!this.locks.acquire(id)) throw new InventoryError(`inventory '${id}' is locked`)
    try {
      const inv = this.requireOpen(id)
      // Pre-commit veto, inside the critical section: an external policy hook can abort the
      // mutation before anything changes. Fail-open semantics live in the bus, not here.
      if (!this.hooks.canMutate({ ...event, inventoryId: id, type: inv.type }))
        throw new InventoryError(`mutation '${event.kind}' on '${id}' was vetoed`)
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
