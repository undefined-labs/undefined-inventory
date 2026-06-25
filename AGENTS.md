This project is an inventory library for Opencore, a TypeScript-first framework built for FiveM.

## Project layout

- Headless, hexagonal TS library. `shared/` is pure (no framework imports, no I/O); `server/` holds orchestration, DI wiring, and the framework-coupled edges.
- Tests: `*.spec.ts` beside source for pure domain; `tests/` for service & plugin integration over a fake store.
- Naming is descriptive over terse (e.g. `itemInstanceId`, not `iid`).
- The library ships contracts only for integrator-owned pieces (DB store, item registry). The in-memory store is a test fixture in `tests/`, never shipped.

## Comments

- Keep JSDoc lean: summarise *what* a function does, not *how*. Don't narrate internals — the code shows those.
- Use targeted inline comments only for the non-obvious "why" (an invariant, a trap, a deliberate divergence from ox_inventory).

## Pull requests

- Keep the PR body lean — a general overview of what changed and why, not a detailed walkthrough. Skip exhaustive file-by-file or line-by-line narration to keep output minimal.
- Link related issues with the `Closes #n` convention.
