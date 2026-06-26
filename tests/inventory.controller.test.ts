import { describe, expect, it } from 'vitest'
import {
  NuiBridgeContract,
  NuiDownMessage,
  NuiUpMessage,
} from '../src/shared/contracts/nui-bridge.contract'
import { InventoryNetContract } from '../src/shared/contracts/inventory-net.contract'
import { InventoryController } from '../src/client/inventory.controller'
import { SerializedInventory } from '../src/shared/types/item.types'

/** Fake NUI bridge: records sends, exposes a trigger to simulate the NUI raising an action. */
class FakeNuiBridge extends NuiBridgeContract {
  sent: NuiDownMessage[] = []
  private handler?: (m: NuiUpMessage) => void
  send(message: NuiDownMessage): void {
    this.sent.push(message)
  }
  onMessage(handler: (m: NuiUpMessage) => void): void {
    this.handler = handler
  }
  raise(message: NuiUpMessage): void {
    this.handler?.(message)
  }
}

/** Fake net transport: records server-bound actions, exposes a trigger to simulate a push. */
class FakeNet extends InventoryNetContract {
  toServer: NuiUpMessage[] = []
  private handler?: (m: NuiDownMessage) => void
  sendToServer(message: NuiUpMessage): void {
    this.toServer.push(message)
  }
  onServerMessage(handler: (m: NuiDownMessage) => void): void {
    this.handler = handler
  }
  push(message: NuiDownMessage): void {
    this.handler?.(message)
  }
}

function makeController() {
  const nui = new FakeNuiBridge()
  const net = new FakeNet()
  const controller = new InventoryController(net, nui)
  controller.start()
  return { controller, nui, net }
}

const INV: SerializedInventory = { id: 'stash:a', type: 'stash', items: [] }

describe('InventoryController — state down', () => {
  it('forwards a server setInventory push into the NUI', () => {
    const { net, nui } = makeController()

    net.push({ kind: 'setInventory', version: 1, inventory: INV })

    expect(nui.sent).toEqual([{ kind: 'setInventory', version: 1, inventory: INV }])
  })

  it('forwards a server updateSlots push into the NUI', () => {
    const { net, nui } = makeController()
    const changes = [{ slot: 1, item: null }]

    net.push({ kind: 'updateSlots', version: 1, inventoryId: 'stash:a', changes })

    expect(nui.sent).toEqual([
      { kind: 'updateSlots', version: 1, inventoryId: 'stash:a', changes },
    ])
  })
})

describe('InventoryController — actions up', () => {
  it('forwards a NUI move action to the server', () => {
    const { net, nui } = makeController()
    const move: NuiUpMessage = {
      kind: 'move',
      fromInv: 'stash:a',
      fromSlot: 1,
      toInv: 'stash:b',
      toSlot: 2,
      count: 3,
    }

    nui.raise(move)

    expect(net.toServer).toEqual([move])
  })

  it('forwards NUI use and close actions to the server', () => {
    const { net, nui } = makeController()

    nui.raise({ kind: 'use', inv: 'stash:a', slot: 1 })
    nui.raise({ kind: 'close', inv: 'stash:a' })

    expect(net.toServer).toEqual([
      { kind: 'use', inv: 'stash:a', slot: 1 },
      { kind: 'close', inv: 'stash:a' },
    ])
  })
})
