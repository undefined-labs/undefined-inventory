import { InventoryContext } from '../types/item.types'

/**
 * Authorises whether a player may OPEN an inventory at all (distance, ownership, faction).
 * Distinct from viewer tracking: this is the gate; the viewer set is who got through it and
 * is currently watching. Abstract class so it serves as a DI token; swap for ownership-based
 * or always-allow policies. Sync — runs in the open path, no external latency in the gate.
 */
export abstract class AccessPolicyContract {
  abstract canOpen(inventoryId: string, player: number, ctx?: InventoryContext): boolean
}
