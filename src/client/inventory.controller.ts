import { InventoryNetContract } from '../shared/contracts/inventory-net.contract'
import { NuiBridgeContract } from '../shared/contracts/nui-bridge.contract'

/**
 * The client edge. Pumps state DOWN (server → NUI: `setInventory`/`updateSlots`) and actions
 * UP (NUI → server: `move`/`use`/`close`). It holds no state and makes no decisions — the
 * server is authoritative; optimism and rendering live in the NUI. Two transport ports in,
 * so the protocol is testable with fakes and the wire (FiveM, RedM, …) stays swappable.
 */
export class InventoryController {
  constructor(
    private readonly net: InventoryNetContract,
    private readonly nui: NuiBridgeContract,
  ) {}

  /** Wire both hops. Call once on client boot. */
  start(): void {
    this.net.onServerMessage((message) => this.nui.send(message))
    this.nui.onMessage((message) => this.net.sendToServer(message))
  }
}
