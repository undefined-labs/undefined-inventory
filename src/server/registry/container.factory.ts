import { randomUUID } from 'node:crypto'
import { InventoryError } from '../../shared/errors'
import { ContainerMeta, ItemDefinition } from '../../shared/types/item.types'
import { MetadataFactory } from './metadata-factory.registry'

/** Collaborators the container factory closes over; the uid source is a seam for tests. */
export interface ContainerFactoryDeps {
  /** Container-id minter; the default is a random uid, overridable for a deterministic counter. */
  mintUid?: () => string
}

/** The definition's container size, or a loud failure — a container kind without `container` is misconfigured. */
function sizeOf(def: ItemDefinition): number {
  if (!def.container) throw new InventoryError(`container item '${def.name}' has no container.size`)
  return def.container.size
}

/**
 * The `container` kind's metadata lifecycle. `create` mints a unique `uid` and reads `size` from
 * the definition; contents live in an own inventory row keyed `container:<uid>`, never nested
 * here. `validate` re-reads `size` so a definition resize applies on load. Its `stackKey` projects
 * the `uid`, so each freshly-minted container owns a distinct slot — non-stackable by construction.
 *
 * ⚠️ Merge-loss invariant: `stackKey` MUST project every identity-bearing field. A container's
 * sole identity is its `uid` (two uids never collide → equal keys mean the same physical
 * container); `size` is definition-derived state, correctly excluded.
 */
export function createContainerFactory(deps: ContainerFactoryDeps = {}): MetadataFactory<ContainerMeta> {
  const mintUid = deps.mintUid ?? randomUUID

  return {
    create(def, input) {
      const meta: ContainerMeta = {
        uid: input?.uid ?? mintUid(),
        size: input?.size ?? sizeOf(def),
      }
      if (input?.overrides) meta.overrides = input.overrides
      if (input?.extra) meta.extra = input.extra
      return meta
    },

    validate(meta, def) {
      return { ...meta, size: sizeOf(def) }
    },

    stackKey: (meta) => meta.uid,
  }
}
