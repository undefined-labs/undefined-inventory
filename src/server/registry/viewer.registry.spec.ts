import { describe, expect, it } from 'vitest'
import { ViewerRegistry } from './viewer.registry'

describe('ViewerRegistry', () => {
  it('returns the players currently viewing an inventory', () => {
    const viewers = new ViewerRegistry()

    viewers.add('stash:a', 1)
    viewers.add('stash:a', 2)

    expect([...viewers.get('stash:a')].sort()).toEqual([1, 2])
  })

  it('removing one viewer leaves the others watching', () => {
    const viewers = new ViewerRegistry()
    viewers.add('stash:a', 1)
    viewers.add('stash:a', 2)

    viewers.remove('stash:a', 1)

    expect([...viewers.get('stash:a')]).toEqual([2])
  })

  it('drops every viewer entry for a disconnected player', () => {
    const viewers = new ViewerRegistry()
    viewers.add('stash:a', 1)
    viewers.add('stash:b', 1)
    viewers.add('stash:a', 2)

    viewers.removePlayer(1)

    expect([...viewers.get('stash:a')]).toEqual([2])
    expect([...viewers.get('stash:b')]).toEqual([])
  })
})
