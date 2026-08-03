# Realtime Match Scaffold — Plan Brief

> Full plan: `context/changes/realtime-match-scaffold/plan.md`
> Locked decisions + Cloudflare research: `context/changes/realtime-match-scaffold/change.md`

## What & Why

Build the smallest working version of the product's core mechanic: a live room holding two players' moves for one round, revealing both only once both have committed. This is roadmap F-02. It exists as its own change specifically to isolate the project's biggest unknown — Cloudflare Durable Objects with WebSocket hibernation — so the learning cost is paid once, early enough to change course, and separately from S-03's match-loop logic.

## Starting Point

Deployment and auth are live in production; the realtime layer is absent entirely. `wrangler.jsonc` points at the adapter's own entrypoint, there is no Durable Object in the repo, and `src/pages/api/` holds only the three auth routes. F-01 landed the `matches` table but it is empty — S-02 owns pairing, so no match ids exist yet.

## Desired End State

Two browser tabs open the same room URL, get distinct seats, and each submit a move. Neither can see the other's move — not on screen, not on the wire — until both have committed, at which point both reveal at once. Room state survives the object hibernating between the two commits. It works locally under `astro dev` and on the deployed Worker, and every existing route behaves exactly as before.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| WebSocket transport | Custom worker entrypoint, not an Astro API route | The adapter appends `Set-Cookie` to every response and a DO stub response has immutable headers, so an API route would fail intermittently on token refresh. | Research |
| Room addressing | Real tournament match id | Chosen over a throwaway string; this is what created F-02's dependency on F-01. | Change notes |
| Socket authentication | None in this scaffold | Small single event, no adversarial users assumed; the protocol carries `playerId` so S-03 adds verification, not a new handshake. | Change notes |
| Rounds played | Exactly one, then terminal | Matches the roadmap outcome verbatim and gives unambiguous pass/fail on the reveal. | Change notes |
| Verification method | Throwaway page, two browser tabs | No test runner exists; two tabs make the guarantee directly observable. | Change notes |
| Match-existence check | None — any well-formed UUID is a valid room | Keeps F-02 independent of S-02's pairing, at the cost of leaving "keyed on real match ids" unproven until S-03. | Plan |
| Deploy target | Production, fully open | Validates the real Cloudflare DO path early, including the one-way SQLite decision. | Plan |
| Entrypoint gate | Path prefix **and** `Upgrade: websocket` | Confines the blast radius of a bug in the new front door to one route; all other traffic keeps today's code path. | Plan |
| Abuse containment | UUID validation, two-socket cap, storage wipe when terminal | Bounds what an anonymous caller can consume without introducing auth. | Plan |
| Round state | Persisted in `ctx.storage`, never in instance fields | Hibernation can land between the two commits; in-memory moves would be lost and the reveal would misfire. | Plan |
| Reveal gating | Server-side only | A client that hides a received value is defeated by devtools and violates the PRD guardrail. | Plan |
| On reconnect | Server sends a state snapshot (commit flags only); no client retry | A reloaded tab recovers its own view without leaking the opponent's move; retry policy is S-03's. | Plan |

## Scope

**In scope:** custom worker entrypoint with a narrow gate; `MatchRoom` Durable Object with SQLite-backed migration; typed `Env`; seat assignment; durable commit and simultaneous reveal; state snapshot on connect; structural containment; throwaway two-tab verification page; deploy via CI.

**Out of scope:** socket auth; verifying the player belongs to the match; multi-round loop; client reconnect/backoff; scoring, statistics, or any Postgres write; round timers; real match UI; rate limiting.

## Architecture / Approach

```
Request → src/worker.ts
            ├─ /ws/match/<uuid> + Upgrade: websocket → MATCH_ROOM stub (idFromName) → MatchRoom DO
            └─ everything else                        → handle() from @astrojs/cloudflare/handler
```

`MatchRoom` accepts sockets via `ctx.acceptWebSocket` (hibernation-capable), assigns seat `a`/`b` through `serializeAttachment`, writes each commit to `ctx.storage`, and re-reads storage after every commit — broadcasting `reveal` only when both keys exist, otherwise `state`. The DO's single-threaded execution makes the both-committed check race-free with no locking.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Worker entrypoint & DO binding | Custom entrypoint, SQLite-backed DO registration, typed `Env`, echo-only room | A file of ours now fronts every production request, including live auth flows |
| 2. Room protocol & hidden reveal | Seats, durable commits, server-gated simultaneous reveal, containment | In-memory state or `ws.accept()` both pass a manual test but break under hibernation |
| 3. Verification page & two-tab test | Throwaway page; the guarantee becomes observable | A rendered UI can look correct while the move is already on the wire |
| 4. Deploy & validate on Cloudflare | Live on the Worker, namespace confirmed SQLite-backed | `new_sqlite_classes` is one-way — a KV-backed first deploy needs a renamed class |

**Prerequisites:** F-01 landed (done — `matches` exists); two Supabase accounts are *not* needed, since no match-existence check is performed; Cloudflare deploy pipeline already live.
**Estimated effort:** ~2-3 sessions across 4 phases; Phase 2 carries most of the unfamiliar work.

## Open Risks & Assumptions

- **The endpoint ships unauthenticated to production by explicit decision.** Containment is structural, not identity-based, so anyone can open rooms on random UUIDs; storage self-wipes when a round finishes. S-03 must add auth before real players use it.
- **`new_sqlite_classes` is irreversible.** Local `astro dev` will not catch a missing migration block — it creates local state either way. Phase 4's dashboard check is the only real verification.
- **Deploys drop live WebSockets** by documented Cloudflare design. Accepted here; a routine hotfix during a live session would strand players mid-round until S-03 adds reconnect.
- **The reveal guarantee has no automated coverage.** Two `grep` checks stand in for the failure modes that survive a manual test, but nothing regression-tests the timing property itself.

## Success Criteria (Summary)

- Two tabs on one room show distinct seats; committing in one leaves the other's raw message log free of any move value; the second commit reveals both at once.
- Room state survives hibernation between the two commits, and a reloaded tab recovers its own view without leaking the opponent's move.
- Every existing route — all auth flows, `/dashboard` gating, static pages — behaves exactly as it did before the entrypoint change, locally and in production.
