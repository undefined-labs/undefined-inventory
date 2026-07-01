import { MetaEnvelope } from '../../../src/shared/types/item.types'
import { InventoryError } from '../../../src/shared/errors'
import { MetadataFactory } from '../../../src/server/registry/metadata-factory.registry'

/**
 * An ID card's metadata: the owner's identity, minted at issue and never mutated. Every field is
 * identity — the whole point of an ID is *whose* it is — so the kind rides the structural envelope
 * default (`stackKey` omitted): distinct owner data yields a distinct key and two cards never merge.
 *
 * Defined in the example resource, not in core `item.types.ts` — this type is not shipped library
 * API, it lives with the resource that registers the kind.
 */
export interface IdentificationMeta extends MetaEnvelope {
  citizenid: string
  firstname: string
  lastname: string
  dob: string
  sex: string
}

const OWNER_FIELDS = ['citizenid', 'firstname', 'lastname', 'dob', 'sex'] as const

/**
 * The `identification` kind, registered from an external example resource — proof that a kind's
 * meaning can be added without editing core. `create` requires the owner identity (an ID with no
 * owner is nonsense, so it throws), `validate` is a passthrough (owner data never decays), and no
 * `stackKey` override is supplied: the structural default already keeps distinct owners apart.
 */
export function createIdentificationFactory(): MetadataFactory<IdentificationMeta> {
  return {
    create(def, input) {
      for (const field of OWNER_FIELDS)
        if (input?.[field] === undefined)
          throw new InventoryError(`identification '${def.name}' requires owner field '${field}'`)

      const meta: IdentificationMeta = {
        citizenid: input!.citizenid!,
        firstname: input!.firstname!,
        lastname: input!.lastname!,
        dob: input!.dob!,
        sex: input!.sex!,
      }
      if (input?.overrides) meta.overrides = input.overrides
      if (input?.extra) meta.extra = input.extra
      return meta
    },

    validate: (meta) => meta,
  }
}
