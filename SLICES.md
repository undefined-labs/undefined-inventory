# Slices — what each step enables / prevents

Vertical tracer-bullet slices for opencore-inventory (see PRD, issue #1). Each slice cuts
end-to-end through the layers for one capability. Read top-to-bottom as a spine:

> **1–2 stand it up · 3–4 make it correct + durable · 5–6 make it live + bounded · 7–8 add the player-facing surfaces · 9–11 open the ecosystem seams.**

Every "Prevents" is a silent **dupe / desync / data-loss / DoS** — the same bar tests are held to.
The "Prevents" column IS the critical-path testing target for a slice: assert those failure
modes are impossible, not implementation details.

| # | Slice | Enables | Prevents |
|---|---|---|---|
| 1 | **Foundation** | Bring-your-own DB store, proven correct by a runnable conformance kit; stackable items with caps; collision-proof ids | Store impls that silently lose/corrupt data; cross-type id collisions (a free dupe); stack caps that never actually enforce |
| 2 | **Skeleton orchestration** | Install via one plugin; add/remove items; new players born-fresh; capacity from config; lossless planned restart | Per-action DB writes (throughput death); load-miss crashing new players; capacity drift / migration on resize |
| 3 | **moveItem** | Drag, move, split, swap, merge — within and across inventories (stash storage) | Half-moves and cross-inventory dupes under concurrent timing; ambiguous partial swaps |
| 4 | **Persistence hardening** | Reliable write-behind that survives DB hiccups and shutdown | Data loss on a transient DB error; a re-dirty lost mid-save; double-write corruption at shutdown |
| 5 | **Viewers + sync + client edge** | Live UI updates; multiple players viewing one stash; responsive optimistic UI; swap/disable the NUI | Permanent UI desync on a rejected action (optimism leak); leaking updates to players who can't see the inventory |
| 6 | **Eviction** | Bounded memory on a busy server (idle inventories swept) | Evicting a watched/locked inventory → dropping the live instance out from under viewers/locks → dupe/desync |
| 7 | **give + drop + ephemeral** | Drop on the ground; give to a nearby player; ground pickups | Ghost pickups (drop evicted while its world prop lives); giving into slots the sender can't see |
| 8 | **Containers** | Bags/wallets/mail-packages holding items; weight rollup | Junk DB rows from destroyed bags; a new bag inheriting a dead bag's loot (free dupe); container weight cheat |
| 9 | **Hooks** | External policy veto (safe zones, RP gates) without touching core | One buggy plugin bricking all inventory (fail-open); policy masquerading as a security invariant |
| 10 | **Use-handlers** | Consumables/tools with server-defined effects | Free-effect dupe (effect applied but item never consumed); vetoed use leaving the client desynced |
| 11 | **External bridge** | Shops/crafting/logging observing changes via a frozen, versioned contract | Pure-core servers paying cross-resource cost (off by default); breaking downstream resources on upgrade |

## Dependency order

```
1 ─┬─ 2 ─┬─ 3 ─┬─ 5 ─┬─ 6 ─┬─ 7
   │      │     │     │
   │      ├─ 4 ─┘     ├─ 8
   │      │           │
   │      └─ 11       ├─ 9 ─ 10
```

- 1 → 2 (everything)
- 3, 4, 11 ← 2
- 5 ← 2, 3
- 6 ← 4, 5
- 7 ← 5, 6
- 8 ← 3, 5
- 9 ← 3
- 10 ← 5, 9

HITL (human freeze-review before downstream depends on the contract): **5** (NUI message protocol), **11** (public `toPublic` contract). Rest AFK.
