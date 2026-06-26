import { AccessPolicyContract } from '../../shared/contracts/access-policy.contract'
import { InventoryContext } from '../../shared/types/item.types'

export interface DistanceAccessPolicyOptions {
  /** Max distance (game units) a player may open an inventory from. Default 2. */
  maxDistance?: number
}

/**
 * Default access gate: authorise iff the player is within `maxDistance` of the inventory.
 * The caller supplies the measured distance via `ctx.distance` (the lib can't read world
 * positions — that's the framework adapter's job). No distance hint → authorise (the open
 * site didn't ask us to range-check, e.g. a player's own inventory).
 */
export class DistanceAccessPolicy extends AccessPolicyContract {
  private readonly maxDistance: number

  constructor(options?: DistanceAccessPolicyOptions) {
    super()
    this.maxDistance = options?.maxDistance ?? 2
  }

  canOpen(_inventoryId: string, _player: number, ctx?: InventoryContext): boolean {
    const distance = ctx?.distance
    if (typeof distance !== 'number') return true
    return distance <= this.maxDistance
  }
}
