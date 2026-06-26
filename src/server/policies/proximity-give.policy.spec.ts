import { describe, expect, it } from 'vitest'
import { InMemoryInventoryLock } from './in-memory-lock'
import { ProximityGivePolicy } from './proximity-give.policy'

const TARGET = 'player:receiver'

describe('ProximityGivePolicy', () => {
  it('allows a give within range to a free target', () => {
    const policy = new ProximityGivePolicy(new InMemoryInventoryLock())
    expect(policy.canReceive(TARGET, 1, { distance: 1.5 })).toBe(true)
  })

  it('allows a give with no distance hint (the call site did not ask us to range-check)', () => {
    const policy = new ProximityGivePolicy(new InMemoryInventoryLock())
    expect(policy.canReceive(TARGET, 1)).toBe(true)
  })

  it('rejects a give beyond max distance', () => {
    const policy = new ProximityGivePolicy(new InMemoryInventoryLock(), { maxDistance: 2 })
    expect(policy.canReceive(TARGET, 1, { distance: 3 })).toBe(false)
  })

  it('rejects a give to a busy (locked) target', () => {
    const locks = new InMemoryInventoryLock()
    locks.acquire(TARGET)
    const policy = new ProximityGivePolicy(locks)
    expect(policy.canReceive(TARGET, 1, { distance: 1 })).toBe(false)
  })
})
