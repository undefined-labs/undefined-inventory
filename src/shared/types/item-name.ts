/**
 * Branded item key + the kind discriminant — the typed spine every other item slice imports.
 */
import { InventoryError } from '../errors'

declare const brand: unique symbol
/**
 * A canonical item key. Only constructable via {@link asItemName}, so internal code holds
 * canonical keys and a mistyped name literal is a compile error rather than a runtime miss.
 */
export type ItemName = string & { readonly [brand]: 'ItemName' }

/** The single item discriminant; `baseItem` is the plain default (and factory-dispatch fallback). */
export type ItemKind = 'baseItem' | 'weapon' | 'container'

/**
 * Canonicalise a raw name into an {@link ItemName} at an ingress boundary. Trims, case-folds to
 * lowercase, and uppercases `weapon_*` names to ox's `WEAPON_*` convention. Lossless: valid
 * non-canonical input is normalised, never rejected, so ox-compatible saves keep loading. An
 * empty/whitespace-only name is junk that could only miss the registry, so it throws.
 *
 * Called at exactly three ingresses — registry registration, store→domain hydration, and the
 * client→server command boundary — after which internal code never re-normalises.
 */
export function asItemName(raw: string): ItemName {
  const folded = raw.trim().toLowerCase()
  if (folded === '') throw new InventoryError('item name must not be empty')
  return (folded.startsWith('weapon_') ? folded.toUpperCase() : folded) as ItemName
}
