import { Capacity, InventoryContext } from '../types/item.types'

/**
 * Resolves an inventory's capacity (`slots` + `maxWeight`) from config/policy. Capacity is
 * never persisted, so resizing needs no migration. Abstract class so it serves as a DI token.
 */
export abstract class CapacityPolicyContract {
  abstract resolve(type: string, id: string, ctx?: InventoryContext): Capacity
}
