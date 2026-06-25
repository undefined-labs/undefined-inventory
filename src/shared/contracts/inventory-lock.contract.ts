/**
 * Per-inventory mutual exclusion. `acquire` MUST be synchronous so the lock is taken
 * atomically in JS, then held across the awaits of an orchestration to close the TOCTOU
 * window. Abstract class so it survives as a DI token; a Redis lock can swap in here.
 */
export abstract class InventoryLockContract {
  /** Take the lock for `id`. Returns `false` if already held (caller must not proceed). */
  abstract acquire(id: string): boolean
  /** Release a held lock. */
  abstract release(id: string): void
  /** Whether `id` is currently locked (used by the eviction predicate). */
  abstract isLocked(id: string): boolean
}
