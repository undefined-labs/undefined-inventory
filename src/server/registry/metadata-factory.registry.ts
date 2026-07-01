import { InventoryError } from '../../shared/errors'
import { ItemDefinition, Meta } from '../../shared/types/item.types'
import { ItemKind } from '../../shared/types/item-name'

/**
 * Per-kind metadata lifecycle, colocated in one object. Replaces name-aware generation in core:
 * a kind supplies how its metadata is minted, repaired on load, and (optionally) projected to a
 * stacking identity. `M` is the kind's envelope type.
 */
export interface MetadataFactory<M extends object = Meta> {
  /** Mint fresh metadata for a new instance, seeding from any caller-supplied `input`. */
  create(def: ItemDefinition, input?: Partial<M>): M
  /** Load-time repair: prune stale fields and apply lazy decay, returning valid metadata. */
  validate(meta: M, def: ItemDefinition): M
  /**
   * Optional narrower stacking-identity projection. Absent → the structural envelope default
   * (identity = envelope − `overrides` − `extra`) owns identity, which is already safe.
   */
  stackKey?(meta: M): string
}

/**
 * The default `baseItem` factory: create/validate are passthroughs (a plain item mints exactly
 * the metadata it is handed and needs no load-time repair), and it ships no `stackKey`, so the
 * structural envelope default decides stacking.
 */
export const baseItemFactory: MetadataFactory = {
  create: (_def, input) => ({ ...input }),
  validate: (meta) => meta,
}

/**
 * `def.kind → MetadataFactory` registry. Single-axis dispatch on the definition's kind, with the
 * `baseItem` factory seeded as the dispatch default — so core never names an item and adding a
 * kind is a `register(kind, factory)` call, never a core edit.
 */
export class MetadataFactoryRegistry {
  // Heterogeneous by kind — each factory owns its own metadata type `M`, so the map is stored at
  // `any` and dispatch hands the service a `MetadataFactory<Meta>` view.
  private factories = new Map<ItemKind, MetadataFactory<any>>()

  constructor() {
    this.factories.set('baseItem', baseItemFactory)
  }

  /** Register the factory for a kind. Re-registering an occupied kind throws. */
  register(kind: ItemKind, factory: MetadataFactory<any>): void {
    if (this.factories.has(kind))
      throw new InventoryError(`kind '${kind}' already has a metadata factory`)
    this.factories.set(kind, factory)
  }

  /** Resolve the factory for a definition, falling back to `baseItem` when its kind is unregistered. */
  resolve(def: ItemDefinition): MetadataFactory {
    return this.factories.get(def.kind ?? 'baseItem') ?? this.factories.get('baseItem')!
  }
}
