/**
 * Tracks who is currently watching each inventory, so the sync subscriber can push changes
 * to exactly that set. Server-side infra, sibling to {@link InventoryRegistry} — viewer
 * state is session state, never a domain invariant, so it stays out of the pure aggregate.
 */
export class ViewerRegistry {
  private byInventory = new Map<string, Set<number>>()
  // reverse index: player → inventories they view, so disconnect cleanup is O(their opens),
  // not a scan of every inventory in the world.
  private byPlayer = new Map<number, Set<string>>()

  /** Register `player` as a viewer of `inventoryId`. */
  add(inventoryId: string, player: number): void {
    this.index(this.byInventory, inventoryId, player)
    this.index(this.byPlayer, player, inventoryId)
  }

  /** Drop `player` from `inventoryId`'s viewer set. */
  remove(inventoryId: string, player: number): void {
    this.deindex(this.byInventory, inventoryId, player)
    this.deindex(this.byPlayer, player, inventoryId)
  }

  /** Drop `player` from every inventory they were viewing (disconnect cleanup). */
  removePlayer(player: number): void {
    const inventories = this.byPlayer.get(player)
    if (!inventories) return
    for (const inventoryId of inventories) this.deindex(this.byInventory, inventoryId, player)
    this.byPlayer.delete(player)
  }

  /** The players currently viewing `inventoryId` (empty set if none). */
  get(inventoryId: string): ReadonlySet<number> {
    return this.byInventory.get(inventoryId) ?? new Set()
  }

  private index<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
    }
    set.add(value)
  }

  private deindex<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    const set = map.get(key)
    if (!set) return
    set.delete(value)
    if (set.size === 0) map.delete(key)
  }
}
