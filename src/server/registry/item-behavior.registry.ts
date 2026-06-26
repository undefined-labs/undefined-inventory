import { InventoryError } from '../../shared/errors'
import { InventoryContext } from '../../shared/types/item.types'

/** Context handed to a use-effect: who used it, which slot, and the open-context hints. */
export interface UseContext {
  inventoryId: string
  slot: number
  actor?: number
  ctx?: InventoryContext
}

/**
 * A server-defined use-effect, run AFTER the item is consumed and the lock released. Pure
 * behaviour: it never re-enters core under the lock and may not assume the stack still exists.
 */
export type ItemBehaviorHandler = (ctx: UseContext) => Promise<void>

/**
 * `itemName → use-effect` map. The data side of a use (how much to consume) lives on the item
 * definition; this registry holds only the behaviour. Empty by default — an item with no
 * registered handler still consumes, it just runs no effect.
 */
export class ItemBehaviorRegistry {
  private handlers = new Map<string, ItemBehaviorHandler>()

  /** Register the effect for an item. Re-registering the same item throws — effects are unique. */
  register(itemName: string, handler: ItemBehaviorHandler): void {
    if (this.handlers.has(itemName))
      throw new InventoryError(`item '${itemName}' already has a use handler`)
    this.handlers.set(itemName, handler)
  }

  /** The effect for an item, or `undefined` if none is registered. */
  get(itemName: string): ItemBehaviorHandler | undefined {
    return this.handlers.get(itemName)
  }
}
