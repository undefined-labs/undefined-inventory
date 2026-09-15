# @undefined-labs/inventory

Headless inventory domain library for the [OpenCore](https://github.com/newcore-network/opencore) FiveM runtime.

Provides the inventory domain model, the store contract, capacity/access/give policies, containers, hooks and use-handlers, and a server-side module with the services, events and write-behind persistence that back a live inventory.

## Features

- Headless and store-agnostic — bring your own database behind one contract, proven correct by a runnable conformance kit.
- Server-authoritative mutations, with every move, give, drop and use validated before it commits.
- Write-behind persistence that survives transient database errors and drains cleanly on shutdown.
- Fully synchronised, so multiple players can view the same stash without desync.

### Items

- Stored per-slot, with a metadata envelope supporting item uniqueness and custom stacking identity.
- Per-kind metadata factories, with weapons and containers supported end-to-end.
- Use-handlers apply server-defined effects, consuming the item first so a vetoed use can never duplicate an effect.

### Storage

- Stashes, ground drops and player-to-player gives, including ephemeral drops that never touch the database.
- Item-backed containers (bags, wallets) with weight rollup and orphan collection.
- Idle inventories are evicted to bound memory, never while viewed or locked.

### Extension

- Hooks let external resources veto mutations without forking the core.
- An opt-in external bridge exposes changes to shops, crafting and logging over a versioned contract.

## Install

```bash
pnpm add @undefined-labs/inventory
```

### Peer dependencies

| Package | Range | Notes |
| --- | --- | --- |
| `@open-core/framework` | `^1.1.0` | The OpenCore runtime this library plugs into. |
| `reflect-metadata` | `^0.2.2` | Required for decorator metadata; import once at your entrypoint. |
| `tsyringe` | `^4.10.0` | DI container used by the server module. |
| `vitest` | `^2.1.0` | **Optional.** Only needed if you import `./shared/testing`. |

## Entry points

| Import | Contents |
| --- | --- |
| `@undefined-labs/inventory` | Re-exports `./shared`. |
| `@undefined-labs/inventory/shared` | Domain model, contracts, errors, event types, ID types and helpers. Safe on client and server. |
| `@undefined-labs/inventory/server` | Everything in `shared`, plus services, policies, registries, subscribers, the DI module and the plugin. Server only. |
| `@undefined-labs/inventory/client` | Everything in `shared`, plus the client-side inventory controller. |
| `@undefined-labs/inventory/shared/testing` | Store conformance kit. Requires `vitest`. |

## Usage

### Shared domain

```ts
import { Inventory, InventoryStoreContract, createInventoryId } from '@undefined-labs/inventory/shared'
```

The `shared` entry point carries no runtime dependency on the framework or the DI container, so it is safe to import from client-side code.

### Server module

```ts
import { InventoryModule } from '@undefined-labs/inventory/server'
```

The server entry point exposes the inventory service, the capacity and access
policies, the item/behaviour/metadata registries, the write-behind persistence
subscribers, and the plugin registration used by the runtime.

## Integrator-owned pieces

The library ships **contracts only** for the two pieces you own:

- **`InventoryStoreContract`** — your database. The in-memory store used by this
  repo's own tests is a fixture, not a shipped implementation.
- **`ItemRegistryContract`** — your item definitions.

## Testing your own store

Any implementation of `InventoryStoreContract` can be checked against the same
conformance suite the in-memory fake runs. It asserts the forbidden failure
modes: silent data loss or corruption, and half-written transactions.

```ts
import { runStoreConformance } from '@undefined-labs/inventory/shared/testing'
import { MyInventoryStore } from './my-inventory-store'

runStoreConformance('MyInventoryStore', {
  create: () => new MyInventoryStore(),
})
```

`runStoreConformance` calls `describe`, `test`, `beforeEach` and `expect` from
`vitest` at import time, so this entry point only works inside a vitest run.
Pass the optional `poison` factory to exercise the all-or-nothing `saveMany`
test against a store that can fail a write.

## Development

```bash
pnpm install
pnpm build      # tsc -p tsconfig.build.json
pnpm test       # vitest run
pnpm typecheck  # build + test projects, no emit
```

`prepublishOnly` runs a clean build, so a publish can never ship a stale `dist`.

## License

[Apache-2.0](./LICENSE)
