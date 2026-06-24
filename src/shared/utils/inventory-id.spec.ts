import {
  formatInventoryId,
  parseInventoryId,
  playerInventoryId,
  stashInventoryId,
  trunkInventoryId,
  gloveboxInventoryId,
  dropInventoryId,
  containerInventoryId,
} from './inventory-id'

describe('inventory ids (collision-proof identity)', () => {
  test('same local id under two types produces two DISTINCT ids', () => {
    // The free-dupe guard: a stash named "42" must never collide with the player
    // whose char id is "42".
    const asPlayer = playerInventoryId('42')
    const asStash = stashInventoryId('42')
    expect(asPlayer).not.toBe(asStash)
  })

  test('id carries its type so it round-trips through parse', () => {
    const id = trunkInventoryId('ABC123')
    expect(parseInventoryId(id)).toEqual({ type: 'trunk', local: 'ABC123' })
  })

  test('format and the per-type minters agree on the wire shape', () => {
    expect(playerInventoryId('1')).toBe(formatInventoryId('player', '1'))
    expect(containerInventoryId('uid-xyz')).toBe(formatInventoryId('container', 'uid-xyz'))
  })

  test('every type mints under a distinct namespace', () => {
    const local = 'shared-local'
    const ids = [
      playerInventoryId(local),
      stashInventoryId(local),
      trunkInventoryId(local),
      gloveboxInventoryId(local),
      dropInventoryId(local),
      containerInventoryId(local),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
