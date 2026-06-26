import { describe, expect, it } from 'vitest'
import { DistanceAccessPolicy } from './distance-access.policy'

describe('DistanceAccessPolicy', () => {
  it('authorises a viewer within the open radius and denies one beyond it', () => {
    const policy = new DistanceAccessPolicy({ maxDistance: 2 })

    expect(policy.canOpen('stash:a', 1, { distance: 1.5 })).toBe(true)
    expect(policy.canOpen('stash:a', 1, { distance: 5 })).toBe(false)
  })

  it('authorises by default when the context carries no distance hint', () => {
    const policy = new DistanceAccessPolicy({ maxDistance: 2 })

    expect(policy.canOpen('stash:a', 1)).toBe(true)
  })
})
