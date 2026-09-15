# Changelog

All notable changes to this project are documented in this file.

## 0.0.2 - 2026-09-15

### Build

- Ship src alongside dist so consumers can compile from source

### Features

- Typed WeaponMeta narrowing guards
- Typed InventoryEventBus subscription facade
- MutateItemMeta service API for in-place metadata edits ([#43](https://github.com/undefined-labs/undefined-inventory/pull/43))

## 0.0.1 - 2026-09-15

### Bug fixes

- Guard moveItem against item duplication; sharpen tests

### Chores

- Emit dist build for consumable lib

### Documentation

- Add instruction for PR format

### Features

- Foundation domain, thin store contract, ids + conformance kit
- Branded ItemName + kind discriminant
- Skeleton orchestration — open/add/remove/emit/persist + plugin ([#2](https://github.com/undefined-labs/undefined-inventory/pull/2))
- MoveItem — move/split/swap/merge within and across inventories ([#3](https://github.com/undefined-labs/undefined-inventory/pull/3))
- Shutdown drain awaits in-flight save before final flush ([#4](https://github.com/undefined-labs/undefined-inventory/pull/4))
- Viewers + sync targeting + client↔NUI protocol ([#5](https://github.com/undefined-labs/undefined-inventory/pull/5))
- Eviction predicate (idle, zero-viewers, no-locks)
- Drop + give + ephemeral drop lifecycle
- Item-backed containers (own-row, weight rollup, orphan-GC, depth 1)
- CanMutate veto bus for pre-commit mutation hooks
- Consume-first-then-effect use handlers
- Route changed mutations through external bridge
- Metadata envelope + default stackKey (baseItem stacking identity)
- Per-kind MetadataFactory registry + baseItem default
- Consume factory stackKey override in the stacking path
- Run factory validate on the hydration load path
- Weapon kind end-to-end (factory + narrowed serial stackKey)
- Container kind end-to-end (factory mints uid + own row)
- External special-kinds example resource (factory-registry seam)
- Reserved (hotbar) slots de-prioritised in auto-placement

### Refactors

- Move noop-sync to transport/; tighten ViewerRegistry helper generics
- Extract TouchTracker; emit evicted; harden eviction guard
- Scope destroyItem to container teardown
- Test source-side move veto, trim hook JSDoc
- Trim use() JSDoc, drop speculative ctx passthrough

### Tests

- Cover asItemName canonicalisation + kind default
- Brand existing item fixtures through asItemName
- Extract shared persistence rig; tidy ControllableStore
- Assert OFF builds no DTO, not just no external emit

