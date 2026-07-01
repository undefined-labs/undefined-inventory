import { ItemDefinition } from '../types/item.types'
import { ItemName } from '../types/item-name'

/**
 * Resolves a static item template by canonical name. Abstract class so it survives as a DI
 * token. `name` is a branded {@link ItemName}: callers pass keys already canonicalised at an
 * ingress, and the impl registers under canonical keys, so no per-lookup case-folding.
 */
export abstract class ItemRegistryContract {
  abstract get(name: ItemName): ItemDefinition | null
}
