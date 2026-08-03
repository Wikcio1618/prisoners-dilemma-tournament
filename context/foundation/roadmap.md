---
project: "Prisoner's Dilemma Tournament"
version: 1
status: draft
created: 2026-07-28
updated: 2026-07-28
prd_version: 1
main_goal: speed
top_blocker: skills
---

# Roadmap: Prisoner's Dilemma Tournament

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

A youth-camp counselor wants to teach game theory experientially by running a live, iterated Prisoner's Dilemma tournament instead of a slow, error-prone paper-and-whiteboard version. The product's wedge — the one trait that, if removed, makes it just a generic scorekeeping app — is that moves stay hidden until both players commit and then reveal simultaneously, with post-tournament behavioral statistics (forgiveness, initial aggression) surfacing the strategic patterns that make the debrief worth having.

## North star

**S-01: Player creates a tournament and others join via code/link** — the smallest end-to-end slice that proves the tournament "shell" works before the riskier hidden-move-reveal mechanic is attempted.

> "North star" here means the smallest end-to-end slice whose successful delivery proves the core product hypothesis — placed as early as its Prerequisites allow, because everything else only matters once this works.

## At a glance

| ID   | Change ID                    | Outcome (user can …)                                                          | Prerequisites | PRD refs                  | Status   |
| ---- | ----------------------------- | ------------------------------------------------------------------------------ | -------------- | -------------------------- | -------- |
| F-01 | tournament-data-model          | (foundation) tournament + membership schema, plus an empty matches table       | —              | Access Control, FR-001, FR-002 | planned  |
| S-01 | create-and-join-tournament     | create a tournament and have others join via code/link                        | F-01           | FR-001, FR-002              | proposed |
| S-02 | generate-round-robin-pairing   | start the tournament and see automatically generated round-robin pairing      | S-01           | FR-003                      | proposed |
| F-02 | realtime-match-scaffold        | (foundation) minimal live-room infra exists for one hidden-then-revealed round | F-01           | NFR (stakes/rivalry), NFR (pace resilience) | proposed |
| S-03 | hidden-move-match-play         | play a match round with hidden, simultaneous move reveal and live history      | S-02, F-02      | US-01, FR-004, FR-005, FR-006, FR-007 | proposed |
| S-04 | tournament-results-and-stats   | see final statistics and scoreboard once the tournament concludes             | S-03           | FR-008, Success Criteria (Secondary) | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                | Chain                          | Note                                                                 |
| ------ | --------------------- | ------------------------------- | --------------------------------------------------------------------- |
| A      | Tournament shell       | `F-01` → `S-01` → `S-02`        | Ships first per `main_goal: speed` — proves the simplest usable flow. |
| B      | Hidden-reveal mechanic | `F-02` → `S-03` → `S-04`        | `F-02` now branches off Stream A at `F-01` (rooms key on real match ids, decided 2026-07-28); `S-03` joins Stream A at `S-02`. Contains the project's biggest unknown (`top_blocker: skills`). No longer runs parallel to Stream A. |

## Baseline

What's already in place in the codebase as of `2026-07-28` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** partial — Astro 6 + React 19 + Tailwind + shadcn/ui scaffold wired (`package.json`, `components.json`), no tournament-domain UI yet.
- **Backend / API:** partial — Astro API-route convention wired (`src/pages/api/auth/*.ts`), only auth endpoints exist; no Durable Object or WebSocket scaffolding.
- **Data:** absent — Supabase SSR client wired (`src/lib/supabase.ts`), no `supabase/migrations/`, no tournament-domain types.
- **Auth:** present — full email/password flow live (Supabase Auth, `src/middleware.ts` route protection), verified against the real Supabase project during deployment.
- **Deploy / infra:** present — `wrangler.jsonc` configured, CI (`.github/workflows/ci.yml`) runs lint+build+deploy on push to `master`, verified live at `prisoners-dilemma-tournament.ciolekwiktor.workers.dev`.
- **Observability:** absent — no logging library, no error tracking; only Cloudflare's default `observability.enabled` flag. Not required by any PRD NFR, so no Foundation opens for it here.

## Foundations

### F-01: Minimal tournament data model

- **Outcome:** (foundation) A tournament can be created and stores a fixed round-count, players can be recorded as members of it via a join code, and a structural `matches` table exists (created but unpopulated). No pairing logic, no move/score/statistics storage; those are introduced by the slices that need them.

  > Scope amended 2026-07-28 during `/10x-plan tournament-data-model`: the original wording excluded match tables entirely, which conflicted with F-02's decision to key match rooms on real match ids. The table is created here; S-02's pairing writes the first rows.
- **Change ID:** tournament-data-model
- **PRD refs:** Access Control ("any logged-in user can start a tournament or join one"), FR-001, FR-002
- **Unlocks:** S-01, F-02
- **Prerequisites:** — (Auth is already present per Baseline)
- **Parallel with:** — (was F-02; F-02 now depends on this item)
- **Blockers:** —
- **Unknowns:** — (resolved 2026-07-28: the ~50-player cap is a hardcoded server-side constant, not configurable; round count is 1–20 with a default of 10, validated in application code)
- **Risk:** Scoped deliberately narrow (tournament + membership + an empty matches table) so it doesn't turn into a full-schema-upfront project. The live risk is that policy behaviour is deliberately unverified until S-01 — recursion and grant mistakes fail at query time, not migration time.
- **Status:** planned — see `context/changes/tournament-data-model/plan.md`

### F-02: Realtime match-room scaffolding

- **Outcome:** (foundation) A minimal live-room mechanism exists that can hold two players' state for one round and reveal both moves only once both have committed — the smallest working version of the hidden-move-reveal primitive, not the full match/tournament game loop.
- **Change ID:** realtime-match-scaffold
- **PRD refs:** NFR (round outcomes must feel immediate/high-stakes), NFR (tournament stays usable across very different player paces)
- **Unlocks:** S-03
- **Prerequisites:** F-01 — decided 2026-07-28 during `/10x-plan realtime-match-scaffold`: rooms are keyed on real tournament match ids rather than throwaway strings, so the tournament data model must exist first. This replaces the original "no prerequisites / runs in parallel" sequencing.
- **Parallel with:** — (was S-01, S-02; no longer parallel after the F-01 dependency above)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** This is where `top_blocker: skills` concentrates — the project's own infrastructure research flagged that Cloudflare's official Astro adapter doesn't cover WebSockets out of the box, and the working pattern (Durable Objects + WebSocket hibernation) needs deliberate, first-time implementation. Scoped to the smallest working version (one round, two players) specifically so the learning cost is paid once, early enough to still change course, and isolated from the rest of the match-play logic in S-03. Also must satisfy the PRD guardrail that a player can never see the opponent's choice before both have committed.
- **Status:** ready

## Slices

### S-01: Player creates a tournament and others join via code/link

- **Outcome:** user can create a tournament (setting a fixed round count) and share a join code/link that lets other logged-in players join before it starts.
- **Change ID:** create-and-join-tournament
- **PRD refs:** FR-001, FR-002
- **Prerequisites:** F-01
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Straightforward CRUD-shaped slice on top of F-01; main risk is scope creep into pairing/match concerns that belong to S-02/S-03.
- **Status:** proposed

### S-02: Tournament creator starts the tournament and pairing is generated

- **Outcome:** user (as creator) can manually start the tournament once players have joined, and every player then sees their automatically generated round-robin pairing.
- **Change ID:** generate-round-robin-pairing
- **PRD refs:** FR-003
- **Prerequisites:** S-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Round-robin generation must guarantee no self-pairing and close the join window on start (both explicit PRD guardrails/FRs) — logic bugs here are hard to spot without a test tournament of realistic size.
- **Status:** proposed

### S-03: Two players play a match round with hidden, simultaneous move reveal

- **Outcome:** user can start a match against their paired opponent, submit a hidden move each round, see the opponent's move only after both have committed, and see the current match's round-by-round history live.
- **Change ID:** hidden-move-match-play
- **PRD refs:** US-01, FR-004, FR-005, FR-006, FR-007
- **Prerequisites:** S-02, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Socket authentication is deliberately absent from F-02 (small single event, no adversarial users assumed) and must be added here before real players use it. The F-02 protocol carries a `playerId` field, so this is adding *verification*, not restructuring the handshake. — Owner: user. Block: no.
  - **Move persistence to Postgres is undesigned and unowned.** Moves live only in Durable Object storage; the DO holds no database credential. S-04 cannot compute any statistic from data that was never persisted, so S-03 must decide who writes move history and when. — Owner: user. Block: **yes for S-04**.
- **Dead ends this slice must close** (from `testing-derived-output-correctness`, 2026-08-01; evidence in that change's `research.md`, encoded as `test.todo` cases in `src/lib/state-machine.test.ts`):
  - **D2 — three of four match statuses have no writer.** `start_tournament()` writes every match as `pending` and nothing moves them, so a match can never be in progress or finished. (`abandoned` stays deliberately unwritten until forfeit/timeout handling exists, which FR-004 defers out of MVP.)
  - **D3 — the match room authenticates without authorizing.** `src/worker.ts` resolves the caller with `getUser()` but never checks that their id appears on the match whose id keys the room, so any signed-in user can take a seat in any room whose UUID they know. This is the same slice as the socket-authentication unknown above.
  - **D4 — a room holds exactly one round** while `rounds_per_match` accepts 1–20, and the room's committed moves are what make it terminal. There is no second round to play.
- **Pacing model is a prerequisite for marking any match `finished`.** `generate-round-robin-pairing`'s review (F1) deferred the choice between rounds-as-barriers and live matching; the opponent view's mutuality only holds while every player has completed the same number of matches. Carried requirement from that review: **any test of mutuality must start from an uneven completion count** — equal counts are the one state where the property holds trivially, which is why the original verification passed while the invariant was false.
- **Risk:** Depends entirely on F-02 having produced a working reveal primitive. Deploys mid-tournament will disconnect live WebSocket sessions (per `infrastructure.md`'s risk register) — this slice must include reconnect handling, not just the happy path, or a routine hotfix during a live camp session could strand players mid-round.
- **Status:** proposed

### S-04: Players see final statistics and scoreboard when the tournament concludes

- **Outcome:** user can view the concluded tournament's final scoreboard, their own zero-balanced score, and behavioral statistics (e.g., forgiveness, initial aggression) once all matches are complete.
- **Change ID:** tournament-results-and-stats
- **PRD refs:** FR-008, Success Criteria (Secondary — "players can see their own match history/results after the tournament concludes")
- **Prerequisites:** S-03
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - **Move persistence is undesigned and blocks this whole slice.** Round-by-round moves live only in Durable Object storage; the DO holds no database credential and nothing writes move history to Postgres. Statistics cannot be computed from data that was never persisted. Owner: user. Block: **yes** — S-03 must resolve it.
- **Inherited decisions** (from `testing-derived-output-correctness`, 2026-08-01 — do not re-derive):
  - **The scoring specification is ratified in the PRD** under Business Logic → *Scoring specification*: the Axelrod payoff matrix (3/5/0/1), score as a plain sum, matches-played displayed alongside it, and the operational definitions of initial aggression and forgiveness including their undefined cases. The "zero-balanced" weighting requirement was **deliberately withdrawn**, not lost.
  - **Compute scoring and statistics in a pure TypeScript module under `src/lib/`**, deliberately departing from the PL/pgSQL precedent set by `join_tournament` and `start_tournament` (and from the definer-function intent noted in `20260729192557_tighten_tournament_update_policy.sql`). The reason is testability: SQL-resident logic is unreachable from the unit suite, which is exactly why pairing needed a separate oracle. The definer function owns persistence and the status flip only.
  - **Turn on the `test.todo` cases in `src/lib/scoring.test.ts`** rather than writing new expectations. Their values were derived by hand from the PRD specification *before* any implementation existed, which is the only thing that makes them a real oracle — regenerating them from the implementation would make the tests tautological.
  - **S-04 also owns D1**, the `tournaments.status` dead end: `started` has no exit transition and `finished` has no writer, so a started tournament can never conclude. See `context/changes/testing-derived-output-correctness/research.md`.
- **Risk:** Needs a reliable "tournament concluded" signal (all pairings' matches complete) derived from S-02+S-03 data — getting that detection wrong either locks the scoreboard open too early or never fires.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                    | Suggested issue title                                              | Ready for `/10x-plan` | Notes |
| ---------- | ----------------------------- | -------------------------------------------------------------------- | ---------------------- | ----- |
| F-01       | tournament-data-model          | Foundation: tournament + membership data model                       | planned                | Plan written — run `/10x-implement tournament-data-model phase 1` |
| S-01       | create-and-join-tournament     | Player can create a tournament and others can join via code/link     | no                     | Waits on F-01 landing first |
| S-02       | generate-round-robin-pairing   | Creator starts tournament; round-robin pairing generated             | no                     | Waits on S-01 landing first |
| F-02       | realtime-match-scaffold        | Foundation: minimal realtime hidden-move-reveal room                 | no                     | Waits on F-01 landing first (rooms key on real match ids). Partial planning + research already captured in `context/changes/realtime-match-scaffold/change.md`. |
| S-03       | hidden-move-match-play         | Players play a match round with hidden, simultaneous move reveal     | no                     | Waits on S-02 and F-02 both landing |
| S-04       | tournament-results-and-stats   | Players see final scoreboard and behavioral statistics               | no                     | Waits on S-03 landing |

## Open Roadmap Questions

1. ~~**Is the ~50-concurrent-player tournament cap configurable (e.g. via a flag) or hardcoded for MVP?**~~ — **Resolved 2026-07-28** during `/10x-plan tournament-data-model`: hardcoded server-side constant (50). Note it lives in two places — a literal inside the `join_tournament` database function and a TypeScript constant — which must be kept in sync.

## Parked

- **Tournaments larger than ~50 players** — Why parked: PRD Non-Goal; product targets a single camp-group scale, not large or public tournaments.
- **Cross-tournament global leaderboards** — Why parked: PRD Non-Goal; statistics and rankings stay scoped to a single tournament.
- **Spectator mode for non-players** — Why parked: PRD Non-Goal; only participants can view live match state.
- **In-app chat or messaging between players** — Why parked: PRD Non-Goal; the only player-to-player communication is the move choices themselves.

## Done

