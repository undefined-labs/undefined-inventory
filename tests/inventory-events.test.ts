import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InventoryEvents,
  configureInventoryEvents,
  emitInventoryEvicted,
} from '../src/server/events/inventory-events'

/**
 * `evicted` fires internally for every eviction (any subscriber may react), but crosses the
 * resource boundary only for drops — a drop resource is the one v1 external consumer, and it
 * needs the signal to despawn the world prop. Non-drop evictions stay off the wire.
 */
describe('emitInventoryEvicted external scoping', () => {
  afterEach(() => {
    configureInventoryEvents({ bridgeExternalEvents: false })
    vi.restoreAllMocks()
  })

  it('always emits the internal event regardless of type', () => {
    const internal = vi.fn()
    InventoryEvents.on('evicted', internal)

    emitInventoryEvicted({ inventoryId: 'stash:a', type: 'stash' })

    expect(internal).toHaveBeenCalledOnce()
    InventoryEvents.off('evicted', internal)
  })

  it('mirrors a drop eviction across the bridge when it is on', () => {
    configureInventoryEvents({ bridgeExternalEvents: true })
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    emitInventoryEvicted({ inventoryId: 'drop:1', type: 'drop' })

    expect(external).toHaveBeenCalledWith('evicted', {
      version: 1,
      inventoryId: 'drop:1',
      type: 'drop',
    })
  })

  it('does not cross the bridge for a non-drop eviction even when the bridge is on', () => {
    configureInventoryEvents({ bridgeExternalEvents: true })
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    emitInventoryEvicted({ inventoryId: 'stash:a', type: 'stash' })

    expect(external).not.toHaveBeenCalled()
  })

  it('does not cross the bridge for a drop eviction when the bridge is off', () => {
    const external = vi.spyOn(InventoryEvents, 'emitExternal').mockImplementation(() => {})

    emitInventoryEvicted({ inventoryId: 'drop:1', type: 'drop' })

    expect(external).not.toHaveBeenCalled()
  })
})
