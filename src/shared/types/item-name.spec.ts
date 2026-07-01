import { asItemName } from './item-name'

describe('asItemName (normalise-at-ingress)', () => {
  it('case-folds a plain name to lowercase', () => {
    expect(asItemName('Water')).toBe('water')
    expect(asItemName('WATER')).toBe('water')
  })

  it('trims surrounding whitespace', () => {
    expect(asItemName('  Water ')).toBe('water')
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(() => asItemName('')).toThrow()
    expect(() => asItemName('   ')).toThrow()
  })

  it('resolves the two weapon casings to one canonical WEAPON_* key', () => {
    expect(asItemName('weapon_pistol')).toBe(asItemName('WEAPON_PISTOL'))
    expect(asItemName('weapon_pistol')).toBe('WEAPON_PISTOL')
  })

  it('is idempotent — canonical input round-trips unchanged', () => {
    expect(asItemName(asItemName('Water'))).toBe('water')
    expect(asItemName(asItemName('WEAPON_PISTOL'))).toBe('WEAPON_PISTOL')
  })
})
