import type { OpenCoreServerLibrary } from '@open-core/framework/server'
import { InventorySyncContract } from '../../shared/contracts/inventory-sync.contract'
import { InventoryChangedEvent } from '../../shared/events/inventory-event.types'
import { ViewerRegistry } from '../registry/viewer.registry'

/**
 * Pushes authoritative slot changes to viewers. Subscribes to `inventory:changed` and
 * broadcasts `updateSlots` to exactly the current viewer set — never to players who can't
 * see the inventory. Pure-split: sync is just a subscriber, the viewer set is its lookup.
 */
export class InventorySyncSubscriber {
  private readonly handler = (event?: unknown): void => {
    const changed = event as InventoryChangedEvent
    const players = this.viewers.get(changed.inventoryId)
    if (players.size === 0) return
    this.sync.updateSlots(players, changed.inventoryId, changed.changes)
  }

  constructor(
    private readonly events: OpenCoreServerLibrary,
    private readonly viewers: ViewerRegistry,
    private readonly sync: InventorySyncContract,
  ) {
    this.events.on('changed', this.handler)
  }

  dispose(): void {
    this.events.off('changed', this.handler)
  }
}
