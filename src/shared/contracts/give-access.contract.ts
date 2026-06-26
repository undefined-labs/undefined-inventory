import { InventoryContext } from '../types/item.types'

/**
 * Authorises a player-to-player `give` — a *push* into an inventory the actor explicitly
 * cannot open. This is why it is NOT `AccessPolicyContract.canOpen`: a player's pockets are
 * owner-only, so `canOpen(targetPlayerInv, otherActor)` is correctly false and would reject
 * every give. The give gate is its own question — proximity + target-not-busy — and is the
 * seam a future accept/decline prompt would live behind. Can-carry is left to the domain
 * (`addItem` rejects on over-weight / no free slot), not duplicated here.
 */
export abstract class GiveAccessContract {
  abstract canReceive(targetInvId: string, actor: number, ctx?: InventoryContext): boolean
}
