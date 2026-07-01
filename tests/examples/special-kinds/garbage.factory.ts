import { randomUUID } from 'node:crypto'
import { MetaEnvelope } from '../../../src/shared/types/item.types'
import { MetadataFactory } from '../../../src/server/registry/metadata-factory.registry'

/**
 * Garbage metadata: worthless trash carries no identity, only a per-pickup tag in the fenced
 * `extra` channel. Because `extra` is excluded from stacking identity by construction, two pieces
 * of garbage picked up separately still merge into one stack — the counterpart proof to
 * identification: an external kind can attach open-ended scratch without ever fragmenting a stack.
 */
export interface GarbageMeta extends MetaEnvelope {
  extra?: { pickupId?: string }
}

/** Collaborators the garbage factory closes over; the pickup-id source is a seam for tests. */
export interface GarbageFactoryDeps {
  /** Per-pickup tag minter; the default is a random uid, overridable for a deterministic counter. */
  mintPickupId?: () => string
}

/**
 * The `garbage` kind, registered from an external example resource. `create` stamps a fresh pickup
 * tag into `extra` (fenced, never identity), `validate` is a passthrough, and no `stackKey` override
 * is supplied — the structural default drops `extra`, so all garbage stacks regardless of tag.
 */
export function createGarbageFactory(deps: GarbageFactoryDeps = {}): MetadataFactory<GarbageMeta> {
  const mintPickupId = deps.mintPickupId ?? randomUUID

  return {
    create(_def, input) {
      const meta: GarbageMeta = { extra: { ...input?.extra, pickupId: mintPickupId() } }
      if (input?.overrides) meta.overrides = input.overrides
      return meta
    },

    validate: (meta) => meta,
  }
}
