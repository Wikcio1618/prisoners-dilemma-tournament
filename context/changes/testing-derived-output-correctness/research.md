---
date: 2026-08-01T20:42:17+0200
researcher: Claude (Opus 5)
git_commit: 87af7eeb1d5b33175401c095c0ed15a4ab94412e
branch: master
repository: 10xdevs
topic: "Runner bootstrap and derived-output correctness (test-plan Phase 1) — Risks #1 and #5"
tags: [research, codebase, testing, vitest, fast-check, scoring, statistics, state-machine, pairing, oracle-problem]
status: complete
last_updated: 2026-08-01
last_updated_by: Claude (Opus 5)
---

# Research: Runner bootstrap and derived-output correctness

**Date**: 2026-08-01T20:42:17+0200
**Researcher**: Claude (Opus 5)
**Git Commit**: `87af7eeb1d5b33175401c095c0ed15a4ab94412e` (local `master`, 11 commits ahead of `origin/master` — not pushed, so no permalinks)
**Branch**: master
**Repository**: 10xdevs

## Research Question

Ground rollout Phase 1 of `context/foundation/test-plan.md` against current code:

- **Risk #1** — scores or behavioral statistics silently miscalculated. Locate the computation, locate the PRD definitions, and report the gap. The oracle must come from the PRD, not the implementation.
- **Risk #5** — a tournament reaches a state it cannot leave. Map the state machine, hunt reachable dead ends, check idempotency under retry.
- **Runner bootstrap** — what Vitest ^4.1.0 + fast-check need in this repo, and which modules are importable without a database or Workers runtime.

Sequencing constraint to respect: this phase must land before S-04 (`tournament-results-and-stats`).

## Summary

**Phase 1 rests on three premises. All three are false, each in a different and consequential way.**

| Premise in the test plan | Reality |
|---|---|
| The PRD defines scores and statistics well enough to derive an oracle | **No payoff matrix exists anywhere in the repo.** "Zero-balanced" was explicitly deferred for formalization and never formalized. "Forgiveness" and "initial aggression" appear only as `e.g.` examples, never defined. The oracle Phase 1 is required to use does not exist and cannot be derived — it must be *decided*. |
| There is scoring/statistics code to test | **There is none.** Not a stub, not a placeholder — zero code representation. Worse: the round-by-round move history that statistics would read **is never persisted to Postgres at all**, and prior research already recorded that nobody owns building that persistence ("None is designed"). |
| Pairing is unit-testable ("unit, property-based") | **Pairing is 100% SQL-resident** inside `start_tournament()`. There has never been a TypeScript implementation. An in-process Vitest test can prove *nothing* about it. Porting it to TS to test it would be the oracle problem in its purest form. |

**Risk #5 is not speculative — it is live, confirmed, and worse than the test plan assumed.** The instruction was to challenge "that state is unreachable by design." The finding is the inverse of what was expected: the dead ends are not edge cases, they are **the main path**. Once a tournament starts it can never end, never be deleted, never be left, and its players are pinned to it permanently (D1). Every match is permanently `pending`; three of four `matches_status_check` values have no writer anywhere (D2). A match room seals forever after one round and can be seated by any authenticated user (D3). `rounds_per_match` accepts 1–20 but the room structurally holds exactly one round (D4).

Critically: **these dead ends are unbuilt features, not regressions.** S-03 and S-04 do not exist. A test asserting "every state has a route out" fails today *correctly*. That reframes what Phase 1 can honestly deliver.

**The one premise that holds is the runner bootstrap**, and it is genuinely straightforward — standalone Vitest config, one path alias, one ESLint override, one CI step. Section 6 has the specifics.

**The highest-leverage thing this phase can do is not a test.** It is to write the scoring specification *before* S-04 exists, and encode it as executable tests that S-04 must then satisfy. That is what the "must land before S-04" constraint was actually protecting, and it survives intact even though the rest of the phase's assumptions did not. §3.4 drafts that specification.

## Detailed Findings

### 1. Risk #1 — the oracle does not exist

#### 1.1 Nothing computes a score

An exhaustive sweep of `src/` and `supabase/migrations/` for `score|payoff|points|rank|tally|forgiv|aggress|niceness|retaliat|cooperat|sabota|defect|statist|metric|leaderboard|standings` returns exactly three categories of hit: the `Move` union and its Polish UI labels, SVG `points=` attributes in `Welcome.astro` (false positives), and comments deferring the work to S-04.

Arithmetic sweep (`.reduce(`, `+=`, `Math.`, `sum(`) across `src/` returns two hits: a timestamp slice at `src/pages/dev/match-room.astro:73` and a poll-failure counter at `src/components/tournament/LobbyRoster.tsx:63`. Neither is derived-value logic.

The complete database object inventory contains no views and no materialized views (`src/db/database.types.ts:141-143` — `Views: [_ in never]: never`), confirming no scoreboard view exists.

The **only** derived-value logic in the entire codebase is the circle-method pairing arithmetic at `supabase/migrations/20260801170219_pairing_set_based.sql:87-104`.

#### 1.2 There is no move history to compute from

This is the finding that reframes Risk #1 entirely. The test plan listed "where round-by-round move history is persisted" as context to ground. The answer is: **nowhere.**

There is no `rounds` table, no `moves` table, and no move column on any table. The four tables (`tournaments`, `tournament_players`, `matches`, `profiles`) are the complete schema.

The only move storage that exists is Durable Object KV — `src/durable/match-room.ts:35-38`:

```ts
const moveKey = (seat: Seat) => `move:${seat}`;
const playerKey = (seat: Seat) => `player:${seat}`;
```

`MatchRoom` imports only `cloudflare:workers` (`src/durable/match-room.ts:1`). It holds no Supabase client and no database credential. Its abandon alarm calls `ctx.storage.deleteAll()` (`src/durable/match-room.ts:208`), destroying an unfinished round's moves with no record anywhere.

Prior research already identified this as unowned work — `context/changes/generate-round-robin-pairing/research.md:146`:

> S-04 needs the complete round-by-round move sequence for forgiveness and initial aggression. The DO is the only component that knows the moves and it holds **no database client and no credential**. The three conceivable routes are: give the DO a service credential (does not exist), have each client write its own move under RLS (reintroduces the hidden-move problem at the database layer), or broker through a trusted Astro route. **None is designed.**

**Trap for anyone writing a statistics query:** `matches.round_number` is *not* a round-within-a-match ordinal. It is the round-robin **schedule ordinal**. `supabase/migrations/20260731174617_pairing_schema.sql:32` states it exactly — *"Circle-method round ordinal. Ordering only -- it never gates play."* One `matches` row = one pairing between two people, who play `tournaments.rounds_per_match` rounds. Reading `round_number` as "which of the 10 rounds is this" produces a silently wrong statistic — precisely the Risk #1 failure mode.

#### 1.3 The PRD cannot supply the oracle

`context/changes/testing-derived-output-correctness/change.md:18` requires the oracle be "derived independently from the PRD's Business Logic and FR-008." Those are, in full:

- `context/foundation/prd.md:77` — FR-008: *"Player can see the final statistics and scoreboard after the tournament concludes. Priority: must-have"*
- `context/foundation/prd.md:93` — *"Statistics produce a set of calculated metrics per player: a zero-balanced score (weighted so that playing more matches doesn't itself confer an advantage) and behavioral classifications derived from move patterns (e.g., forgiveness, initial aggression)."*

There is no payoff matrix. No numeric values (`T/R/P/S`, `3/3`, `5/0`) appear anywhere under `context/`, `src/`, or `supabase/`. "Zero-balanced" is asserted four times (`prd.md:89,93`, `shape-notes.md:44,133`, `roadmap.md:131`) and defined zero times.

The formalization was explicitly deferred and then dropped. `context/foundation/shape-notes.md:43-44`:

> topic: "scoring balance" / decision: "scores must be **zero-balanced** — playing more matches must not itself give a player an advantage; **to be formalized in Business Logic**"

Business Logic (`prd.md:87-95`) restates the shape-note verbatim without formalizing it. Both behavioral metrics are hedged with "e.g." every time they appear, so **even the metric set is not closed.**

The nearest thing to a decision is the domain grounding at `context/foundation/shape-notes.md:61`, which cites Axelrod and says *"per-player **cumulative** score across all pairings determines the tournament outcome"* — in unreconciled tension with the PRD's *"zero-balanced / weighted."*

#### 1.4 The zero-balance requirement is load-bearing, not decorative

`context/changes/generate-round-robin-pairing/research.md:47`:

> **The zero-balanced score requirement presupposes uneven completion.** In a completed round-robin everyone plays n−1 matches and that weighting is a no-op — it is only meaningful if players finish **different numbers** of matches, which is what one-shot generation plus no-forfeit produces.

So the normalization denominator is exactly what decides whether the score is right, and it is entirely undecided. This is the single most likely place for "reasonable and correct to diverge silently."

### 2. Risk #5 — confirmed dead ends, and they are the main path

The full transition map is in §5. The dead ends, all **CONFIRMED** by code tracing:

#### D1 — `tournaments.status = 'started'` is absolutely terminal

Reached by the ordinary happy path: create → two players join → start.

No route out exists:
- UPDATE: policy `tournaments_update_creator_in_lobby` was **dropped** (`supabase/migrations/20260731174617_pairing_schema.sql:192`) and `revoke update (status) on public.tournaments from authenticated` (`:194`). **No UPDATE policy exists on `tournaments` at all.** No `service_role` key is configured (`supabase/migrations/20260731181103_player_profiles.sql:5-7`).
- DELETE: `tournaments_delete_creator_in_lobby` requires `status = 'lobby'` (`supabase/migrations/20260729174939_tournament_rls.sql:108-115`).
- Members cannot leave: `tournament_players_delete_self_in_lobby` requires `t.status = 'lobby'` (`supabase/migrations/20260731163754_creator_cannot_leave_own_tournament.sql:21-29`).
- The creator can never leave regardless (`:28`).
- New players cannot join (`supabase/migrations/20260729192744_join_tournament_membership_shortcircuit.sql:54-57`).

`'finished'` is reachable by **no code path**. The `tournament_finished` branch inside `start_tournament` (`supabase/migrations/20260801170219_pairing_set_based.sql:59-62`) is dead code — the only two reachable statuses are `lobby` and `started`, and `started` short-circuits at `:52-57`.

User-visible consequence: `src/pages/tournaments/[id].astro:146` renders *"Poczekaj na zakończenie turnieju"* — a wait that can never end.

This is the known-and-accepted half of `tournament-data-model` F1 (`context/changes/tournament-data-model/reviews/impl-review.md:36-53`), whose bricking path was fixed while the unreachable terminal state was deliberately left for S-04.

#### D2 — every match is permanently `pending`

The only `.from("matches")` in the entire codebase is a SELECT at `src/pages/tournaments/[id].astro:74`. No SQL function, no policy, and no application code writes `matches.status`. `matches` has exactly one policy — `matches_select_member` (`supabase/migrations/20260729174939_tournament_rls.sql:152-156`), SELECT only — so all DML from `authenticated` is denied.

`'in_progress'`, `'finished'` and `'abandoned'` are all unreachable. `supabase/migrations/20260731174617_pairing_schema.sql:36-37` acknowledges it: *"Nothing writes it yet — the Durable Object knows about expiry but holds no database credential."*

Compounding: the query at `src/pages/tournaments/[id].astro:71-81` filters `.in("status", ["pending","in_progress"]).order("round_number").limit(1)`, so every player is permanently shown their round-1 opponent and the `nextMatch === null` branch (`:143-148`) is unreachable. This also silently defuses `generate-round-robin-pairing` F1 — the schedule can never advance, so the mutuality divergence never materializes.

#### D3 — the match room seals permanently, and any authenticated user can seat it

`src/worker.ts:36-64` validates only that the path segment is a UUID (`:41`) and that a session exists (`:53-58`). It never reads `matches`, never checks the caller is `player_a_id` or `player_b_id`, and never checks the room UUID corresponds to a real match. **It authenticates but does not authorize.**

Once two arbitrary signed-in users seat a room and commit, `seatFor` (`src/durable/match-room.ts:232-238`) returns `null` for everyone else and `fetch` returns 410 "Round already complete" (`:97-101`) forever. `alarm()` returns early on a complete room without rescheduling (`:199-203`), so `deleteAll()` at `:208` never runs. Nothing can delete a Durable Object's storage from outside.

This is the still-open remainder of `realtime-match-scaffold` F10 (`context/changes/realtime-match-scaffold/reviews/impl-review.md:158`): *"NOT closed: any logged-in user can still join any room UUID, because match-membership checking stays deferred."*

The same shape hits honest players: whoever reaches a room first takes a seat and the seat is **never released** (`src/durable/match-room.ts:211-216`).

#### D4 — `rounds_per_match` is 1–20 but a room holds exactly one round

Validated to 1–20 (`src/lib/schemas.ts:22`, `src/lib/tournament.ts:21-24`) and rendered at `src/pages/tournaments/[id].astro:152`. But `MatchRoom` stores exactly one `move:a`/`move:b` pair, seals on the first complete pair (`src/durable/match-room.ts:64-70`), and has no round counter, no reset, and no per-round key namespace. No code mints a per-round room id. A tournament configured for 10 rounds per match has rooms that terminate after round 1.

#### Cases checked and found safe

- **Started with too few players** — blocked at `supabase/migrations/20260801170219_pairing_set_based.sql:69-73`. Note `coalesce(array_length(v_players, 1), 0)` is load-bearing: `array_agg` over an empty set returns NULL, which would otherwise make the count NULL and skip the guard.
- **Odd player count** — correct, no bye row, no self-pair (proof in §4).
- **Last player / everyone leaving** — impossible; the creator is pinned by `20260731163754:28`, so the lobby roster floor is 1.
- **Zero-player lobby tournament** (create succeeds, join RPC fails, compensating delete fails) — reachable but **recoverable**: the creator can still see it, re-join via the rendered join code, and delete it while in lobby.

#### D6 — cascade vs RESTRICT ordering (SUSPECTED, needs a real Postgres)

`tournament_players.user_id` → `auth.users` is `ON DELETE CASCADE` (`supabase/migrations/20260729164628_tournament_tables.sql:49`), while `matches (tournament_id, player_a_id)` → `tournament_players` is `ON DELETE RESTRICT` (`supabase/migrations/20260731174617_pairing_schema.sql:54-64`). Deleting one `auth.users` row fires both. Trigger firing order for sibling cascades from one parent delete is not guaranteed.

Note `generate-round-robin-pairing` F2 probed *part* of this against the live DB and dismissed it — `delete from auth.users` was PERMITTED, bare membership delete BLOCKED with 23503. That probe covered the account-deletion direction. The tournament-cascade direction, and the interaction once matches exist in quantity, remains unverified. **Phase 2 territory.**

#### Idempotency

Better than expected. Quoted guards:

| Operation | Second call | Verdict |
|---|---|---|
| `POST /api/tournaments` (create) | Creates a **second tournament** + membership. No dedupe key. `src/pages/api/tournaments/index.ts:42-61` | **NOT IDEMPOTENT** |
| `join_tournament` | Membership short-circuit *before* the lobby and capacity gates (`20260729192744:45-52`), plus `on conflict do nothing` (`:72`) | IDEMPOTENT |
| `start_tournament` | Status short-circuit returning existing match count (`20260801170219:52-57`) | IDEMPOTENT |
| **Concurrent** double-start | `select … for update` (`20260801170219:38-41`) serializes; loser sees `started` and short-circuits. Backstop: `matches_tournament_pair_uniq` would raise 23505. Whole function is one transaction. | IDEMPOTENT — the strongest part of the machine |
| `POST /…/leave` | Zero rows deleted → **"Nie można opuścić tego turnieju."** A user whose first request succeeded but whose response was lost is told it failed. `src/pages/api/tournaments/[id]/leave.ts:30-39` | NOT IDEMPOTENT (spurious error) |
| Duplicate WS `commit` | No-op (`src/durable/match-room.ts:170-176`). Note a *different* move on the second frame is silently ignored with no error. | IDEMPOTENT |

### 3. What Phase 1 can honestly deliver

#### 3.1 Unit-testable today, with real signal

- `generateJoinCode()` (`src/lib/tournament.ts:65-71`) — property test: always 6 chars, always matches `/^[0-9]{6}$/`, **leading zeros preserved** (the obvious implementation bug), distribution not catastrophically skewed. Imports nothing; runs in plain Node.
- `isJoinTournamentError` / `isStartTournamentError` (`src/lib/tournament.ts:94-96,120-122`).
- The three Zod schemas (`src/lib/schemas.ts:19-35`) — boundary coverage on `rounds_per_match`: `0`, `1`, `20`, `21`, `10.5`, `""`. Note **`rounds_per_match` has no DB CHECK by explicit decision** (`supabase/migrations/20260729164628_tournament_tables.sql:12-13`), so this schema is the *only* enforcement anywhere. Any future write path bypassing it can write 2 billion rounds. That makes these the highest-value pure unit tests in the repo.
- `safeRedirect` (`src/lib/safe-redirect.ts`) — zero imports, pure URL logic.

#### 3.2 Drift tests — a documented, recurring defect class

The same bound is restated in two or three places repeatedly, held together only by comments. `context/changes/tournament-data-model/plan.md:333` names it: *"Two DB↔TS invariant pairs held together only by comments."* F3 and F6 in prior reviews were both instances.

| Invariant | SQL | TS |
|---|---|---|
| Player cap 50 | `20260729192744:65` | `src/lib/tournament.ts:18` |
| Display name 40 | `20260731181103:21`, `20260801170309:27` | `src/lib/tournament.ts:37` |
| Join code format | `20260730203114:22` | `src/lib/tournament.ts:48` |
| Error tokens | `join_tournament` / `start_tournament` DETAIL strings | `src/lib/tournament.ts:84-89,110-115` |
| Match status vocabulary | `20260731174617:43` CHECK | **nothing** — see below |

A test that reads the migration files as text fixtures and asserts the literals match the TS constants catches this whole class **with no database**. Cheap, fast, and it targets a defect class this repo has actually shipped twice.

**The worst case in that table:** `matches.status` is typed as bare `string` in `src/db/database.types.ts:24` (the enum was dropped for a text+CHECK at `20260729193532`). The four legal values exist **only** in the SQL CHECK and are invisible to TypeScript. `src/pages/tournaments/[id].astro:77` hardcodes `["pending","in_progress"]` with no shared constant and no compile-time check. A typo compiles clean. `LobbyRoster.tsx:16` types `initialStatus: string`, discarding the tournament enum at the component boundary.

#### 3.3 What is *not* unit-testable, contrary to the plan

- **Pairing** — §4. Needs Postgres.
- **Every RLS policy, every CHECK, both definer functions** — Phase 2.
- **D1 as an executable assertion** ("after start, no operation available to `authenticated` changes status or deletes the row") — Phase 2; it is a statement about policies.
- **Hibernation, seat races, `alarm()` semantics, D3** — Phase 3, needs `workerd`.
- `MatchRoom.seatFor` / `isComplete` / `committedFlags` / `parse` are pure functions on plain objects but are `private` instance methods in a class whose module imports `cloudflare:workers` (`src/durable/match-room.ts:1`). Testing them in plain Vitest requires extracting them to a separate module first — worth doing for `parse`, which is the only input-validation boundary on the WebSocket and currently returns an object carrying a client-supplied `playerId` field not declared on `ClientMessage` (`:283-288` vs `:10-13`).

#### 3.4 Draft scoring specification (for ratification, not for silent adoption)

This is the deliverable that the "before S-04" constraint exists to protect. It is **drafted here, not decided here** — §"Open Questions" carries the decisions. Anchored in the Axelrod grounding the project already cites (`shape-notes.md:61`), since that is the only domain authority the documents name.

**Payoff matrix.** Axelrod's standard values, satisfying the two constraints that make it a Prisoner's Dilemma (`T > R > P > S`: 5 > 3 > 1 > 0 ✓, and `2R > T + S`: 6 > 5 ✓ — the latter is what makes sustained mutual cooperation beat alternating exploitation):

| Own move | Opponent move | Own points | Axelrod name |
|---|---|---|---|
| Współpraca (cooperate) | Współpraca | **3** | R — Reward |
| Sabotaż (sabotage) | Współpraca | **5** | T — Temptation |
| Współpraca | Sabotaż | **0** | S — Sucker |
| Sabotaż | Sabotaż | **1** | P — Punishment |

**Zero-balanced score.** Three readings of the PRD phrase, which are not equivalent:

- **(A) Mean points per round played** — `total_points / rounds_played`. Satisfies the stated purpose clause exactly. Matches how Axelrod reported results, so debrief comparison against published strategy averages (TIT FOR TAT ≈ 2.5) becomes possible — which is the pedagogical payload. Does not literally sum to zero.
- **(B) Mean differential per round** — `(own_points − opponent_points) / rounds_played`. Centred on zero, so "zero-balanced" is literal. Harder to explain to a 15-year-old at debrief.
- **(C) Total differential** — sums to exactly zero across all players, but more matches means more magnitude, which **fails the PRD's stated purpose clause**. Rejected.

**Recommendation: (A).** The purpose clause ("playing more matches doesn't itself confer an advantage") is normative and points at a mean; prior research notes the rule that *"Success Criteria plus Functional Requirements should win over Business Logic prose"* (`generate-round-robin-pairing/research.md:174`). Per-*round* rather than per-*match* also survives abandoned matches, which the no-forfeit design guarantees will exist.

**Behavioral statistics.** Both need an explicit undefined case — this is exactly where "reasonable" and "correct" diverge silently:

- **Initial aggression** = (matches where the player's **first** move was Sabotaż) / (matches with ≥1 round played). Range 0–1. A value of 0 is Axelrod's "nice". **Undefined when the denominator is 0** — must not render as 0, which would read as "perfectly non-aggressive."
- **Forgiveness** = among all rounds *i* where the opponent played Sabotaż at round *i−1* **within the same match** and round *i* exists, the fraction where the player plays Współpraca at round *i*. **Undefined when never provoked** — must not render as 1.0, which would crown a never-provoked player the most forgiving in the tournament. This is the single most likely silent-wrong statistic in the product.

Note the last round of a match is never a provocation, because no round follows it.

**Worked reference example.** Derived from the definitions above, computed by hand, touching every payoff cell and both undefined-adjacent edges. A 5-round match:

| Round | Alice | Bob | Alice pts | Bob pts |
|---|---|---|---|---|
| 1 | C | S | 0 | 5 |
| 2 | C | C | 3 | 3 |
| 3 | S | C | 5 | 0 |
| 4 | S | S | 1 | 1 |
| 5 | C | S | 0 | 5 |

- Totals: **Alice 9**, **Bob 14**. Deliberately asymmetric — a symmetric-swap bug would pass an equal-totals fixture.
- Zero-balanced (A): Alice **9/5 = 1.8**, Bob **14/5 = 2.8**.
- Initial aggression: Alice R1 = C → **0/1 = 0**. Bob R1 = S → **1/1 = 1.0**.
- Forgiveness — Alice: Bob sabotaged at R1 and R4; Alice answered C and C → **2/2 = 1.0**. Bob's R5 Sabotaż is not a provocation (no R6).
- Forgiveness — Bob: Alice sabotaged at R3 and R4; Bob answered S and S → **0/2 = 0.0**.

Every number above traces to the definitions, not to any implementation — which is the entire point.

### 4. Pairing — correct, and untestable in-process

**Location:** the body of `public.start_tournament(uuid)`. Current definition `supabase/migrations/20260801170219_pairing_set_based.sql:16-119`; superseded loop version at `supabase/migrations/20260731174617_pairing_schema.sql:70-179`. `git log --all -S"circle" -- src/` and `-S"round_number" -- src/` return only view and generated-type commits. **There has never been a TypeScript implementation.** `src/pages/api/tournaments/[id]/start.ts:35` is a pure RPC shim.

**Algorithm** (`20260801170219:64-106`): roster read as `array_agg(user_id order by user_id)` — fully deterministic, no randomization. `v_slots := v_count + (v_count % 2)`; `v_rounds := v_slots - 1` (always odd). Full schedule generated in one `INSERT … SELECT`, in the same transaction as the `lobby → started` flip. Standard circle method: position 1 pinned, positions 2..slots rotate. Odd rosters get a phantom slot dropped by `where pos_a <= v_count and pos_b <= v_count` — **no bye row is ever written**, deliberately, because `least()/greatest()` ignore NULLs so two byes for one player would collide on `matches_tournament_pair_uniq` (`:80-83`).

**Guardrails — proven, not merely observed.** Verified exhaustively for n = 2..50 and analytically:

- **Self-pairing impossible.** For `i=0`, `pos_a=1` and `pos_b>=2`. For `i>0`, `pos_a = pos_b` requires `2i ≡ 0 (mod v_rounds)`; `v_rounds` is odd and `1 <= i <= (v_rounds−1)/2`, so it cannot hold. Satisfied **by the algorithm**, not by the CHECK.
- **No repeat pair.** Offset sum `u+v ≡ 2(r−1)` determines `r` uniquely (2 is invertible mod odd `v_rounds`); `|u−v| = 2i` determines `i` uniquely.
- **No player twice in one round.** The offsets in round `r` are `R` consecutive residues mod `R`, all distinct, plus fixed position 1.
- Yields `n(n−1)/2` matches. At the 50-player cap: 1225 matches over 49 rounds.

**Where the guarantee is weakest:** "no player twice in the same round" has **no database backstop at all**. `round_number` participates in no constraint or index; `matches_tournament_pair_uniq` is lifetime-scoped. If the modular arithmetic were wrong, that specific corruption would land silently. And the set-based rewrite (F8) was done **without measuring first** and verified only by *"re-running the four-session check end to end"* — a 4-player manual pass. The 50-player timeout scenario that motivated the rewrite was never exercised. Prior hand-tracing (`generate-round-robin-pairing/reviews/impl-review.md:227-229`) covered n = 3, 4, 6 — **against the loop version, before the rewrite.**

So the highest-value pairing test in the project is "for every n in 2..50, the generated schedule is a correct round robin," and **it requires a database.**

**Testability verdict:** there is no pure function taking a player list and returning pairs. An in-process Vitest test can prove nothing about pairing today. Porting the algorithm to TypeScript to unit-test it would prove the TypeScript is a correct round robin and prove **nothing** about the SQL that ships — the oracle problem exactly. The two would drift on the next migration, and this repo has a documented history of precisely that drift class.

**The defensible use of a TS implementation is as a differential oracle:** property-test the TS version for the invariants above, then run the same roster through real Postgres and assert the two schedules are set-equal. That still needs a database, so it belongs in Phase 2 — but the pure TS oracle *can* be written in Phase 1, where it is honest about being an oracle rather than a test.

### 5. State machine reference

**Status vocabularies.** `tournaments.status` is a real Postgres enum `('lobby','started','finished')` (`20260729164628:19`), correctly mirrored in `database.types.ts:149`. `matches.status` is text + CHECK `('pending','in_progress','finished','abandoned')` (`20260731174617:38-43`) with **no TS representation at all**. `tournament_players` has **no status column** — membership is binary, row present or absent, no `left_at`, no soft delete. The Durable Object has no status field; state is derived from the presence of `move:a`/`move:b` and `player:a`/`player:b` keys.

**Transitions.**

| Transition | Owner | Guard |
|---|---|---|
| ∅ → tournament `lobby` | `src/pages/api/tournaments/index.ts:44-53` + policy `tournaments_insert_own` | `creator_id = auth.uid() and status = 'lobby'` |
| `lobby` → `started` | **`start_tournament()` only** (`20260801170219:108-110`) | creator check `:45-48`; `status='lobby'` `:59-62`; `count >= 2` `:69-73` |
| `lobby` → ∅ | policy `tournaments_delete_creator_in_lobby` | `creator_id = auth.uid() and status = 'lobby'` |
| `started` → anything | **NOTHING** | — |
| → `finished` | **NO CODE PATH EXISTS** | — |
| ∅ → member | **`join_tournament()` only** (`20260729192744:70-72`) | lobby for newcomers; count < 50; `on conflict do nothing` |
| member → ∅ | policy `tournament_players_delete_self_in_lobby` | self, lobby, **and not the creator** |
| ∅ → match `pending` | **`start_tournament()` only** (`20260801170219:87-104`) | in-function; no INSERT policy on `matches` |
| match `pending` → anything | **NOTHING** | — |
| room seat claim | Durable Object (`match-room.ts:121-123`) | — |
| room → wiped | `alarm()` (`match-room.ts:199-209`) | **only when the round is incomplete** |
| room complete → anything | **NOTHING** | — |

**Double-owned transitions (flagged):**
- **Match visibility** — RLS `matches_select_member` grants *all* matches in your tournament, and the app-side `.or()` filter at `src/pages/tournaments/[id].astro:78` is what actually scopes it. The comment at `:66-69` says so outright: *"The `.or()` filter below is therefore what keeps a player from seeing other pairs — application code, not the policy."* Any query path that forgets the filter leaks the whole bracket — and this is what makes D3 exploitable, since a member can read every co-member match `id` and squat those rooms.
- **Membership cascade** — `ON DELETE CASCADE` from `auth.users` vs `ON DELETE RESTRICT` from `matches` (D6).
- **`rounds_per_match` bounds** — owned *only* by `src/lib/schemas.ts:22`; the DB deliberately has no CHECK.

### 6. Runner bootstrap — the one premise that holds

**Baseline.** No `vitest.config.*`, no `test` script, no runner in `devDependencies`, zero `*.test.ts`. `@astrojs/check` is a dependency but **has no npm script** — nothing in the repo ever runs `tsc` or `astro check`; typechecking today happens only via ESLint's type-aware rules and the editor.

**Versions verified against the registry.** `vitest@4.1.0` declares `peerDependencies.vite: "^6 || ^7 || ^8.0.0-0"` and `engines.node: "^20 || ^22 || >=24"`. Installed vite is **7.3.3**, pinned by the `overrides` in `package.json` — compatible, and the override helps by preventing a second vite copy. Local Node 24.18.0 ✓, CI Node 22 ✓, `.nvmrc` 22.14.0 ✓. `fast-check` latest is **4.9.0**, `engines.node: ">=12.17.0"` — unconstrained.

**Config shape: standalone `vitest.config.ts`, not `getViteConfig`.** `getViteConfig` exists in astro 6.3.1 (`node_modules/astro/dist/config/index.js:4-43`) but calls `runHookConfigSetup`/`runHookConfigDone`, executing the Cloudflare adapter's `astro:config:setup` hook (`node_modules/@astrojs/cloudflare/dist/index.js:69-230`). That injects `@cloudflare/vite-plugin`, a `cloudflare:*` externalizer, and `optimizeDeps` forcing for the ssr/prerender environments, and depends on `astro sync` having created the route list. For a Phase 1 suite of pure functions that drags a workerd/Miniflare-backed Vite environment into every run for no benefit.

The only cost of standalone is duplicating the `@/*` alias (`tsconfig.json:9-11`), which is used in ~30 files including `src/lib/schemas.ts:2-7`. One line:

```ts
resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }
```

**Import purity — verified empirically** with `node --experimental-strip-types`:

| Module | Verdict |
|---|---|
| `src/lib/tournament.ts` | ✅ zero imports; `generateJoinCode()` ran in plain Node |
| `src/lib/safe-redirect.ts` | ✅ zero imports |
| `src/lib/utils.ts` | ✅ clsx + tailwind-merge |
| `src/lib/schemas.ts` | ✅ **once the `@` alias exists** — fails today only on `Cannot find package '@/lib'` |
| `src/lib/supabase-worker.ts` | ✅ importable (type-only `@/db/database.types`), but needs `@supabase/ssr` — integration target |
| `src/lib/config-status.ts:1` | ❌ `astro:env/server` → *"Received protocol 'astro:'"*; **also has top-level side effects** at `:11-21` |
| `src/lib/supabase.ts:3` | ❌ `astro:env/server` |
| `src/middleware.ts:1` | ❌ `astro:middleware` |
| `src/durable/match-room.ts:1` | ❌ `cloudflare:workers` → *"Received protocol 'cloudflare:'"* |
| `src/worker.ts:1-3` | ❌ `@astrojs/cloudflare/handler` + transitive |

**No Supabase client is constructed at module scope anywhere** — both `src/lib/supabase.ts:6` and `src/lib/supabase-worker.ts:17` are factories returning `null` when config is absent. A useful safety property for Phases 2–3.

**Lint and typecheck.** `tsconfig.json` `include: ["**/*"]` already covers any test path — **no include change needed**. ESLint's only ignores are `.gitignore` contents plus two generated files (`eslint.config.js:76`), so `eslint .` picks up test files automatically, and `lint-staged` already covers `*.test.ts`. Gotchas:

1. `strictTypeChecked` applies to tests — `no-unsafe-assignment`, `no-non-null-assertion`, `no-explicit-any` will fire on ordinary test scaffolding. A `files: ["**/*.test.ts"]` override block is required or `npm run lint` fails.
2. Prefer `globals: false` + explicit `import { describe, it, expect } from "vitest"` — adding `types: ["vitest/globals"]` to tsconfig **turns off the implicit all-@types behavior**, so it would have to become `["vitest/globals","node","react","react-dom"]` or React/Node globals vanish.
3. **Do not disable `skipLibCheck`** — it is what keeps `worker-configuration.d.ts` (`declare const console/crypto`, `declare function setTimeout` at `:223,421,393`) from colliding with `@types/node` 25.6.2.
4. Add `coverage/` to **both** `.gitignore` and `.prettierignore` — neither has it, so ESLint would lint coverage output and Prettier would rewrite it.

**CI.** `.github/workflows/ci.yml` runs `npm ci` → `npx astro sync` → `npm run lint` → `npm run build`, then a separate `deploy` job with `needs: ci`. A `npm run test` step belongs between `lint` and `build`: steps are sequential, a non-zero exit fails the job, and `deploy` is skipped entirely when `ci` fails — so **a failing test blocks the deploy** with no further wiring. There is no `continue-on-error` anywhere. Phase 1 tests need no `SUPABASE_*` env.

**Conventions** (`AGENTS.md:18`): everything under `src/`, kebab-case for lib modules, PascalCase for components, `@/` imports always (never deep relatives), heavy JSDoc-explaining-*why* culture. No colocation precedent exists — no `__tests__`, no fixtures. A `*.test.ts` sibling in `src/lib/` fits the naming grain. **`AGENTS.md:29` currently states "No test runner is configured in this project yet"** — that line, the command list at `:20-29`, and the CI Gate paragraph at `:37` all need updating when Vitest lands.

## Code References

- `src/lib/tournament.ts:18,21-27,37,48,65-71,84-89,110-115` — constants, `generateJoinCode`, error token vocabularies. Zero imports; the ideal Phase 1 target.
- `src/lib/schemas.ts:19-35` — the three Zod schemas; `:22` is the **only** enforcement of `rounds_per_match` bounds anywhere.
- `src/lib/safe-redirect.ts` — zero imports, pure URL logic.
- `src/durable/match-room.ts:1` — `cloudflare:workers`, the import that puts the whole module out of plain Vitest's reach.
- `src/durable/match-room.ts:35-38,170-176,199-209,232-238,261-263,269-294` — move storage keys, commit idempotency guard, alarm, seat resolution, `parse`.
- `src/worker.ts:36-64` — authenticates but does not authorize (D3).
- `src/pages/tournaments/[id].astro:66-69,71-81,143-148` — the app-side `.or()` filter that owns match scoping; the query that pins every player to round 1.
- `src/pages/api/tournaments/index.ts:42-61` — the only non-idempotent write.
- `src/pages/api/tournaments/[id]/leave.ts:30-39` — reports failure on retry.
- `src/pages/api/tournaments/[id]/start.ts:35` — pure RPC shim.
- `src/db/database.types.ts:24,149` — `matches.status` as bare `string` vs the typed tournament enum.
- `supabase/migrations/20260801170219_pairing_set_based.sql:16-119` — current pairing; `:64-106` the algorithm; `:38-41` the `FOR UPDATE`; `:52-57` idempotent short-circuit; `:69-73` the `>= 2` gate with the load-bearing `coalesce`.
- `supabase/migrations/20260731174617_pairing_schema.sql:32,36-37,38-43,54-64,192-194` — `round_number` semantics, the `abandoned` acknowledgement, the status CHECK, composite FKs, the dropped UPDATE policy.
- `supabase/migrations/20260729174939_tournament_rls.sql:108-115,152-156` — delete policy, the sole `matches` policy.
- `supabase/migrations/20260729192744_join_tournament_membership_shortcircuit.sql:45-52,65,70-72` — the membership short-circuit that makes join idempotent.
- `supabase/migrations/20260731163754_creator_cannot_leave_own_tournament.sql:21-29` — leave gate, creator pinned.
- `supabase/migrations/20260729164628_tournament_tables.sql:12-13,49,71,80-85` — the deliberate absence of a `rounds_per_match` CHECK, the cascade, distinct-players, the normalized pair index.
- `.github/workflows/ci.yml` — `needs: ci` on deploy is what makes a test step a real gate.

## Architecture Insights

**The project has a consistent and deliberate architecture: domain logic lives in PL/pgSQL `SECURITY DEFINER` functions, and TypeScript is a shim.** `join_tournament` and `start_tournament` both hold *all* their logic in SQL, including the entire circle-method arithmetic. `src/lib/` contains constants, type guards, and Zod schemas — no algorithms.

This is a defensible choice, and prior research argued it well (`generate-round-robin-pairing/research.md`: a per-row `WITH CHECK` is *"structurally incapable of expressing 'this is a complete, correct round-robin over the roster'"*). But it has a direct and unacknowledged consequence for the test plan: **the layer where this project's correctness actually lives is the layer plain Vitest cannot reach.** `context/foundation/test-plan.md:58` presumes Risk #1's cheapest layer is *"unit + property-based on pure functions"*. On current evidence that presumption does not hold for pairing, and there is active pressure for it not to hold for statistics either — `supabase/migrations/20260729192557_tighten_tournament_update_policy.sql:14-17` already commits to concluding a tournament via *"a SECURITY DEFINER function (following the join_tournament precedent)."*

**If S-04 follows the precedent its three predecessors set, the scoring logic will be PL/pgSQL and unreachable from Vitest entirely.** That is a live design decision, not a discovered fact — and Phase 1 is the last cheap moment to influence it. Deriving scores in a pure TypeScript module and having the definer function call *nothing but* persistence would keep Risk #1's cheapest layer viable. Recommending that trade is arguably a more valuable Phase 1 output than any individual test.

**Terminality is implicit throughout, and that is the shape of Risk #5.** A room is terminal because move keys are present, not because anything says so (`realtime-match-scaffold` F2's fix deliberately made it so). A tournament is terminal because no policy permits leaving `started`. A match is terminal because nothing can write its status. In each case the state is inferred from the absence of a transition rather than declared — which is exactly why dead ends keep being found by review rather than by construction.

**The review culture is unusually strong and is doing the job tests would do.** Four impl-reviews found 30+ findings including several criticals, with empirical verification against production in at least three cases (F2's rolled-back `DO` probes, F2's live second-reveal reproduction, F4's confirmed zero-player start). The reviews repeatedly flag their own blind spots (*"Not reproduced live; the reasoning is from the code path"*). This is why the codebase is in better shape than "zero tests" suggests — and it is also why the first test suite should target what review *cannot* catch: exhaustive input spaces (n = 2..50), regression on already-fixed bugs, and drift between duplicated constants.

## Historical Context (from prior changes)

- `context/changes/tournament-data-model/reviews/impl-review.md:36-53` — F1: `'finished'` unreachable through the policy layer. Bricking path fixed; **the unreachable terminal state deliberately left for S-04**. This is D1's origin.
- `context/changes/tournament-data-model/reviews/impl-review.md:148-156` — F10: account deletion silently rewrites *finished* standings, since `'finished'` confers no immutability. **DEFERRED to S-04** — a Risk #1 concern with an owner already assigned.
- `context/changes/realtime-match-scaffold/reviews/impl-review.md:49-61` — F2: rooms were infinitely replayable, *"for an iterated Prisoner's Dilemma that is a scoring exploit."* Fixed by making persisted moves the terminality marker.
- `context/changes/realtime-match-scaffold/reviews/impl-review.md:158` — F10: **NOT closed** — *"any logged-in user can still join any room UUID, because match-membership checking stays deferred."* This is D3.
- `context/changes/generate-round-robin-pairing/reviews/impl-review.md:30-79` — F1: the mutual-opponent invariant holds only at t=0. **Deferred to S-03 as an undecided design choice** (rounds-as-barriers vs live matching). Includes a pre-written test requirement: *"Any S-03 test of this must start from an uneven completion count."* The review deliberately overrode its own rubric (critical → REJECTED) because F1 is *"latent, not live"* — it is unreachable precisely because of D2.
- `context/changes/generate-round-robin-pairing/reviews/impl-review.md:187-203` — F8: the pairing generator was rewritten set-based **without measuring first**, verified only by a 4-player manual pass. The strongest argument for an exhaustive n = 2..50 schedule test.
- `context/changes/generate-round-robin-pairing/research.md:45,47,49,88-97,144-148,173,190-197` — the richest prior source: zero-balance presupposes uneven completion; irreversibility concentrates at `started`; move persistence has no owner; `matches.status` is provisional and *"this is the last cheap moment"*; and the unanswered question of whether a 50-player tournament (490–980 exchanges per player) is playable at all.
- `context/changes/create-and-join-tournament/reviews/impl-review.md:93-101,113-130` — F5 and F7, both error-swallowing, both fixed. F7's fix (re-read status after a zero-row update to distinguish idempotent success from policy refusal) is itself untested inference logic.
- **"No test runner is configured"** appears verbatim in all four plans: `tournament-data-model/plan.md:269`, `create-and-join-tournament/plan.md:310`, `realtime-match-scaffold/plan.md:285`, `generate-round-robin-pairing/plan.md:294`.
- `context/changes/realtime-match-scaffold/plan-brief.md:69` — *"The reveal guarantee has no automated coverage. Two `grep` checks stand in for the failure modes that survive a manual test."*
- `context/archive/` contains only `README.md` — **nothing has been archived**; all four changes remain live at `status: impl_reviewed`.

## Related Research

- `context/changes/generate-round-robin-pairing/research.md` — the repo's only prior research artifact. Directly load-bearing for §1.4, §2 and §4 here.
- `context/foundation/test-plan.md` §2 Risk Response Guidance and §3 Phased Rollout — the document this research is grounding, and the one §"Open Questions" recommends amending.
- `context/foundation/infrastructure.md` — risk register noting deploys drop live WebSockets (Phase 3 context).

## Open Questions

**Blocking for the plan — these are product decisions, not research gaps:**

1. **Ratify the payoff matrix.** §3.4 proposes Axelrod's 5/3/1/0. Nothing in the repo has ever named a number. Until this is decided, no scoring test can exist.
2. **Ratify the zero-balance formula.** §3.4 recommends (A) mean points per round, over (B) mean differential per round; (C) total differential is rejected as failing the PRD's own purpose clause. The three readings give *different rankings for the same tournament*, so this is not cosmetic.
3. **Ratify the forgiveness and initial-aggression definitions, including the undefined cases.** A never-provoked player must not score 1.0 forgiveness. Also: is the metric set closed at these two, or is "e.g." meant literally?
4. **Does S-04 compute statistics in TypeScript or in PL/pgSQL?** The three prior slices set a strong SQL precedent, and `20260729192557:14-17` already commits to a definer function for concluding. If scoring follows, Risk #1's cheapest test layer disappears. See Architecture Insights.

**Scope decisions for the plan:**

5. **Should Phase 1 write failing/pending tests against the ratified spec for code that does not exist yet?** This is the cleanest possible answer to the oracle problem — the test provably cannot have been derived from an implementation that has not been written — and it is what the "before S-04" constraint implies. But it means Phase 1 ships a red suite, which conflicts with §5's "required after §3 Phase 1" gate. A `.todo`/`.skip`-with-spec approach, or gating on only the green subset, would need deciding.
6. **Move pairing correctness from Phase 1 to Phase 2** in `test-plan.md` §3, since it needs Postgres. The pure TS round-robin *oracle* can still be written in Phase 1 and consumed by Phase 2's differential test.
7. **How should Risk #5's confirmed dead ends (D1–D4) be recorded?** They are unbuilt features owned by S-03/S-04, not regressions. Filing them as roadmap/change-folder findings is more honest than encoding them as tests that fail by design.
8. **Should `parse`, `seatFor`, `isComplete` and `committedFlags` be extracted from `match-room.ts`** into a pure module so Phase 1 can test the WebSocket input-validation boundary? Currently blocked only by the module's `cloudflare:workers` import.

**Deferred to a later phase:**

9. **D6** — the cascade-vs-RESTRICT ordering question. Cheap to settle against a real Postgres; currently unknown. Phase 2.
10. Whether a 50-player tournament is playable at all (`generate-round-robin-pairing/research.md:196`: 490–980 hidden-move exchanges per player). Not a test question, but it bears on whether the n=50 pairing test is exercising a real configuration.
