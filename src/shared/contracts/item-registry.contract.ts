import { ItemDefinition } from '../types/item.types'

/**
 * Resolves a static item template by name. Abstract class so it survives as a DI token.
 */
export abstract class ItemRegistryContract {
  abstract get(name: string): ItemDefinition | null
}
