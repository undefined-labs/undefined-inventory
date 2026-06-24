/**
 * Inventory identity. An `InventoryId` carries a `<type>:` prefix, so the same local id
 * under two types can never collide. Within-type uniqueness is the caller's local key.
 */
import { InventoryError } from '../errors'

export type InventoryType =
  | 'player'
  | 'stash'
  | 'trunk'
  | 'glovebox'
  | 'drop'
  | 'container'

const TYPES: readonly InventoryType[] = [
  'player',
  'stash',
  'trunk',
  'glovebox',
  'drop',
  'container',
]

declare const brand: unique symbol
/** Only constructable via the minters / `formatInventoryId`. */
export type InventoryId = string & { readonly [brand]: 'InventoryId' }

export function formatInventoryId(type: InventoryType, local: string): InventoryId {
  return `${type}:${local}` as InventoryId
}

export function parseInventoryId(id: string): { type: InventoryType; local: string } {
  const separator = id.indexOf(':')
  if (separator === -1) throw new InventoryError('malformed inventory id')
  const type = id.slice(0, separator)
  if (!TYPES.includes(type as InventoryType))
    throw new InventoryError('unknown inventory type')
  return { type: type as InventoryType, local: id.slice(separator + 1) }
}

export const playerInventoryId = (charId: string): InventoryId =>
  formatInventoryId('player', charId)

export const stashInventoryId = (name: string): InventoryId =>
  formatInventoryId('stash', name)

export const trunkInventoryId = (plate: string): InventoryId =>
  formatInventoryId('trunk', plate)

export const gloveboxInventoryId = (plate: string): InventoryId =>
  formatInventoryId('glovebox', plate)

export const dropInventoryId = (uuid: string): InventoryId =>
  formatInventoryId('drop', uuid)

export const containerInventoryId = (itemInstanceId: string): InventoryId =>
  formatInventoryId('container', itemInstanceId)
