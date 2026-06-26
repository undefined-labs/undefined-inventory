import { Hook, HookContract, HookFilter, MutationEvent } from '../../shared/contracts/hook.contract'

/**
 * Default in-process veto bus. Holds registered hooks and ANDs them with short-circuit:
 * the first explicit `false` aborts. A throwing hook fails open (counts as a pass) and is
 * logged loudly so a buggy plugin is noisy but never bricks inventory.
 */
export class HookBus extends HookContract {
  private hooks: Hook[] = []

  register(hook: Hook): void {
    this.hooks.push(hook)
  }

  canMutate(event: MutationEvent): boolean {
    for (const hook of this.hooks) {
      if (!matches(hook.filter, event)) continue
      let verdict: unknown
      try {
        verdict = hook.canMutate(event)
      } catch (error) {
        // Fail open: a buggy hook must never brick a mutation. Loud so it gets fixed.
        console.error('[inventory] canMutate hook threw; failing open', error)
        continue
      }
      if (verdict === false) return false
    }
    return true
  }
}

/** A hook with no filter matches everything; otherwise every set facet must match. */
function matches(filter: HookFilter | undefined, event: MutationEvent): boolean {
  if (!filter) return true
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.item !== undefined && filter.item !== event.item) return false

  const sides =
    event.kind === 'move'
      ? [event.from, event.to]
      : [{ inventoryId: event.inventoryId, type: event.type }]
  if (filter.inventoryId !== undefined && !sides.some((s) => s.inventoryId === filter.inventoryId))
    return false
  if (filter.type !== undefined && !sides.some((s) => s.type === filter.type)) return false
  return true
}
