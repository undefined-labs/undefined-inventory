import { CapacityPolicyContract } from '../../shared/contracts/capacity-policy.contract'
import { Capacity } from '../../shared/types/item.types'

/** Install-time per-type capacity defaults. */
export type TypeCapacityMap = Record<string, Capacity>

const DEFAULT_TYPES: TypeCapacityMap = {
  player: { slots: 50, maxWeight: 120_000 },
  stash: { slots: 50, maxWeight: 500_000 },
  trunk: { slots: 30, maxWeight: 200_000 },
  glovebox: { slots: 5, maxWeight: 10_000 },
  drop: { slots: 50, maxWeight: 1_000_000 },
  container: { slots: 10, maxWeight: 20_000 },
}

/**
 * Default capacity policy: a flat `type → capacity` map resolved on every open. Because
 * capacity is never persisted, bumping a value here resizes inventories with no migration.
 */
export class TypeMapCapacityPolicy extends CapacityPolicyContract {
  private readonly types: TypeCapacityMap

  constructor(types?: TypeCapacityMap) {
    super()
    this.types = { ...DEFAULT_TYPES, ...types }
  }

  resolve(type: string): Capacity {
    const capacity = this.types[type]
    if (!capacity) throw new Error(`no capacity configured for inventory type '${type}'`)
    return capacity
  }
}
