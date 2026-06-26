import { Meta } from '../types/item.types'

/**
 * A mutation about to happen, handed to a veto hook *before* it commits. Discriminated by
 * `kind`. A move carries both ends (`from`/`to`); add/remove carry the single inventory they
 * target. `type` is the inventory type (e.g. `player`, `container`) for type-scoped filtering.
 */
export type MutationEvent =
  | { kind: 'add'; inventoryId: string; type: string; item: string; count: number; metadata?: Meta }
  | { kind: 'remove'; inventoryId: string; type: string; item: string; count: number; metadata?: Meta }
  | {
      kind: 'move'
      from: { inventoryId: string; type: string }
      to: { inventoryId: string; type: string }
      item: string
      count: number
    }

/** Narrows which events a hook is consulted for. An omitted facet matches everything. */
export interface HookFilter {
  /** Only consult for these mutation kinds. */
  kinds?: ReadonlyArray<MutationEvent['kind']>
  /** Only consult when an involved inventory has this id (either side of a move). */
  inventoryId?: string
  /** Only consult when an involved inventory has this type (either side of a move). */
  type?: string
  /** Only consult when the mutated item has this name. */
  item?: string
}

/** A registered veto hook: an optional filter plus the predicate consulted pre-commit. */
export interface Hook {
  filter?: HookFilter
  /**
   * Return `false` to veto. Any non-`false` (including non-boolean) is a pass. A throw is
   * caught upstream and treated as a pass (fail-open) — a buggy hook must never brick a
   * mutation.
   */
  canMutate(event: MutationEvent): unknown
}

/**
 * Pre-commit veto bus. External resources register hooks to gate mutations by policy (safe
 * zones, RP gates) without touching core. The contract is fail-open by design: this is a
 * policy seam, not a security invariant — core invariants live in the domain and locks.
 *
 * - Only an explicit `false` vetoes; non-boolean returns pass.
 * - Hooks are ANDed with short-circuit: the first `false` aborts and stops evaluation.
 * - A throwing hook fails open (the mutation proceeds) and is logged loudly.
 * - A move fires if either side matches a hook's filter; a veto aborts the whole move.
 */
export abstract class HookContract {
  /** Register a veto hook. */
  abstract register(hook: Hook): void

  /** Consult all matching hooks. Returns `false` if any vetoes; `true` otherwise. */
  abstract canMutate(event: MutationEvent): boolean
}
