/** Domain error for inventory rule violations (over-weight, no slot, unknown item, ...). */
export class InventoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryError'
  }
}
