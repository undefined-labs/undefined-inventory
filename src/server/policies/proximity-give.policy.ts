import { GiveAccessContract } from '../../shared/contracts/give-access.contract'
import { InventoryLockContract } from '../../shared/contracts/inventory-lock.contract'
import { InventoryContext } from '../../shared/types/item.types'

export interface ProximityGivePolicyOptions {
  /** Max distance (game units) a giver may be from the receiver. Default 2. */
  maxDistance?: number
}

/**
 * Default give gate: a give lands iff the giver is within range and the target isn't busy.
 * Mirrors ox_inventory's give (proximity + not-busy), with can-carry left to the domain.
 * "Busy" maps to the target inventory's lock being held — a move/give already in flight —
 * reusing existing concurrency state rather than a separate busy flag. The caller supplies
 * the measured distance via `ctx.distance` (the lib can't read world positions); no distance
 * hint → range is not gated here (the call site didn't ask us to).
 */
export class ProximityGivePolicy extends GiveAccessContract {
  private readonly maxDistance: number

  constructor(
    private readonly locks: InventoryLockContract,
    options?: ProximityGivePolicyOptions,
  ) {
    super()
    this.maxDistance = options?.maxDistance ?? 2
  }

  canReceive(targetInvId: string, _actor: number, ctx?: InventoryContext): boolean {
    if (this.locks.isLocked(targetInvId)) return false
    const distance = ctx?.distance
    if (typeof distance === 'number' && distance > this.maxDistance) return false
    return true
  }
}
