import { randomUUID } from 'node:crypto'
import { ItemRegistryContract } from '../../shared/contracts/item-registry.contract'
import { ItemDefinition, WeaponMeta } from '../../shared/types/item.types'
import { asItemName } from '../../shared/types/item-name'
import { MetadataFactory } from './metadata-factory.registry'

/** Collaborators the weapon factory closes over; the clock and serial source are seams for tests. */
export interface WeaponFactoryDeps {
  /** Resolves component refs on load — a component absent here is dangling and gets pruned. */
  registry: ItemRegistryContract
  /** Epoch-ms clock, injectable so lazy decay is deterministic in plain Node. */
  now?: () => number
  /** Serial minter; the default is a random uid, overridable for a deterministic counter. */
  mintSerial?: () => string
}

/** Current durability given an elapsed-time decay from the last anchor. Never below zero. */
function decay(meta: WeaponMeta, def: ItemDefinition, now: number): number {
  if (!def.degrade || meta.durabilityAt === undefined) return meta.durability
  const elapsedMinutes = (now - meta.durabilityAt) / 60_000
  const lost = (elapsedMinutes / def.degrade) * 100
  return Math.max(0, meta.durability - lost)
}

/**
 * The `weapon` kind's metadata lifecycle. `create` mints a serial, full durability, zeroed ammo,
 * and the requested components; `validate` prunes dangling component refs against the registry and
 * re-anchors durability by the lazily-computed decay (no per-item tick). Its `stackKey` narrows
 * identity to the serial alone.
 *
 * ⚠️ Merge-loss invariant (the narrowing footgun): `stackKey` MUST project every identity-bearing
 * field, because stacking collapses N instances into one bag and any identity dropped here is
 * silently discarded on merge. A weapon's sole identity is its serial — two serials never collide,
 * so equal keys can only mean the same physical gun; durability/ammo/components are per-instance
 * state, never identity, and are correctly excluded.
 */
export function createWeaponFactory(deps: WeaponFactoryDeps): MetadataFactory<WeaponMeta> {
  const now = deps.now ?? (() => Date.now())
  const mintSerial = deps.mintSerial ?? randomUUID

  return {
    create(_def, input) {
      const meta: WeaponMeta = {
        serial: input?.serial ?? mintSerial(),
        durability: input?.durability ?? 100,
        ammo: input?.ammo ?? 0,
        components: input?.components ?? [],
        durabilityAt: input?.durabilityAt ?? now(),
      }
      if (input?.overrides) meta.overrides = input.overrides
      if (input?.extra) meta.extra = input.extra
      return meta
    },

    validate(meta, def) {
      const components = meta.components.filter((name) => deps.registry.get(asItemName(name)) !== null)
      return { ...meta, components, durability: decay(meta, def, now()), durabilityAt: now() }
    },

    stackKey: (meta) => meta.serial,
  }
}
