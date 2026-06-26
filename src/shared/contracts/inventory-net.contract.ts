import { NuiDownMessage, NuiUpMessage } from './nui-bridge.contract'

/**
 * Client→server transport for actions-up, and server→client for state-down on the client.
 * The Controller speaks this; the adapter carries it over FiveM net events. Swappable for a
 * different runtime's transport.
 */
export abstract class InventoryNetContract {
  /** Send an actions-up message to the server. */
  abstract sendToServer(message: NuiUpMessage): void

  /** Register the handler invoked when the server pushes state down to this client. */
  abstract onServerMessage(handler: (message: NuiDownMessage) => void): void
}
