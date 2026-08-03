# Runner Bootstrap and Derived-Output Correctness — Implementation Plan

## Overview

Stand up the project's first test runner (Vitest + fast-check), test everything that is genuinely
testable in-process today, and — the reason this phase is sequenced before S-04 — write the scoring
oracle down as a ratified PRD specification and as executable expectations, so that the statistics
implementation cannot later supply the oracle to its own tests.

This is rollout Phase 1 of `context/foundation/test-plan.md`, covering Risk #1 (silently
miscalculated scores/statistics) and Risk #5 (a tournament reaches a state it cannot leave).

## Current State Analysis

Established by `research.md` (same change folder, 2026-08-01):

- **No test infrastructure exists.** No runner, no config, no test files, no `test` script.
  `@astrojs/check` is a dependency with no script, so nothing runs `tsc` either — typechecking today
  happens only through ESLint's type-aware rules.
- **No scoring or statistics code exists**, and no payoff matrix is defined anywhere in the
  repository. `"zero-balanced"` was deferred for formalization in `shape-notes.md:44` and never
  formalized; `"forgiveness"` and `"initial aggression"` appear only as `e.g.` examples.
- **Round-by-round move history is never persisted to Postgres.** Moves live in Durable Object KV
  (`src/durable/match-room.ts:35-38`); the DO holds no database credential. Who writes moves to
  Postgres is undesigned (`generate-round-robin-pairing/research.md:146`).
- **Pairing is 100% SQL-resident** inside `start_tournament()`
  (`supabase/migrations/20260801170219_pairing_set_based.sql:16-119`). No TypeScript implementation
  has ever existed.
- **Risk #5's dead ends are confirmed, and they are the main path, not edge cases.** D1: a started
  tournament can never end, be deleted, or be left — no UPDATE policy exists on `tournaments` at all.
  D2: every match is permanently `pending`; three of four status values have no writer. D3: rooms
  seal permanently and `src/worker.ts:36-64` authenticates without authorizing. D4: `rounds_per_match`
  accepts 1–20 but a room structurally holds one round. All four are **unbuilt features owned by
  S-03/S-04**, not regressions.
- **The importable surface is small and clean.** `src/lib/tournament.ts` and `src/lib/safe-redirect.ts`
  import nothing and run in plain Node. `src/lib/schemas.ts` needs only the `@/*` alias. Everything
  else in `src/lib/` reaches `astro:env/server`, and `src/durable/match-room.ts` reaches
  `cloudflare:workers`.

## Desired End State

`npm run test` runs a green Vitest suite locally and in CI, gating deploy through the existing
`needs: ci` dependency. The suite covers every pure function and every duplicated DB↔TS constant in
the repo. The PRD carries a complete, unambiguous scoring specification, and that specification
exists as `test.todo` cases that S-04 must turn on rather than reinterpret. `test-plan.md` §6 answers
"how do I add a test for X here?" for the two unit categories, and §5's unit gate reads
`required (wired)`.

Verify by: `npm run test` passes; `npm run lint` passes; `npm run build` passes; CI shows a test step
between lint and build; `test-plan.md` §3 Phase 1 can be marked `complete`.

### Key Discoveries

- Vitest 4.1 declares `vite: "^6 || ^7 || ^8.0.0-0"` and `node: "^20 || ^22 || >=24"`. Installed Vite
  is 7.3.3 (pinned by the `overrides` in `package.json:60-62`), local Node 24.18.0, CI Node 22 — all
  compatible, and the override prevents a second Vite copy.
- `getViteConfig` from `astro/config` would execute the Cloudflare adapter's `astro:config:setup`
  hook, dragging `@cloudflare/vite-plugin` and an `astro sync` dependency into every run. A standalone
  config avoids this at the cost of duplicating one path alias.
- `tsconfig.json:5` already has `include: ["**/*"]`, and `eslint.config.js:76` ignores only two
  generated files — so test files are picked up by typecheck and lint with **no** include changes.
- `strictTypeChecked` (`eslint.config.js`) will fire `no-unsafe-*` and `no-non-null-assertion` on
  ordinary test scaffolding; an override block is required or `npm run lint` fails.
- `.gitignore` and `.prettierignore` have no `coverage/` entry.
- `.github/workflows/ci.yml` runs steps sequentially and `deploy` declares `needs: ci`, so a test step
  gates deploy with no further wiring.
- `AGENTS.md:29` states "No test runner is configured in this project yet."

## What We're NOT Doing

- **Not implementing S-04.** No scoring module, no statistics computation, no scoreboard UI. This
  phase writes the specification and its expectations only.
- **Not designing move persistence.** It remains undesigned and unowned; noted for S-03/S-04.
- **Not testing pairing against Postgres.** Phase 2 owns that (Docker is not installed).
- **Not testing RLS policies, definer functions, or API routes.** Phase 2.
- **Not testing the hidden-move protocol, hibernation, reconnect, or eviction.** Phase 3.
- **Not fixing D1–D4.** They are recorded, not resolved; S-03/S-04 own the fixes.
- **Not rewiring `src/pages/tournaments/[id].astro:77`** to use the new status constants. The hardcoded
  literals there are a documented hazard, but changing shipped UI is out of scope for a test-bootstrap
  phase; the constant is added and pinned so S-03 can adopt it.
- **Not adding E2E or browser tests.** Excluded by `test-plan.md` §7.
- **Not extracting `seatFor`, `isComplete`, or `committedFlags`** from `match-room.ts` — `seatFor` in
  particular is the identity-binding fix that closed a move-leakage critical.

## Implementation Approach

Six phases, ordered so the runner exists before anything needs it, and the specification lands before
its encoding.

Two mechanisms carry the phase's unusual shape:

1. **`test.todo` as a specification carrier.** Expectations for code that does not exist yet are
   written as `test.todo` with the full expected values in the title and a commented assertion body.
   The suite stays green (so the §5 gate can be enforced now), while the oracle is provably written
   before the implementation.
2. **Migration files as text fixtures.** Drift tests read `supabase/migrations/*.sql` as text and
   assert the literals match their TypeScript twins. This catches a defect class the repo has shipped
   twice, needs no database, and runs in milliseconds.

## Critical Implementation Details

**Ordering.** The ESLint override (Phase 1) must land in the same commit as the first test file, or
`npm run lint` fails on `strictTypeChecked` rules and blocks the pre-commit hook.

**`test.todo` semantics.** Vitest reports `todo` tests as passing-with-annotation, not as failures.
This is what keeps the suite green. Do not use `test.skip` for the specification cases — `skip` reads
as "temporarily disabled" whereas `todo` reads as "not yet implemented," which is the accurate signal
and shows in the summary line as a standing reminder.

**Do not disable `skipLibCheck`.** It is what keeps `worker-configuration.d.ts` (which declares
`console`, `crypto`, `setTimeout` at `:223,421,393`) from colliding with `@types/node` 25.6.2.

**Do not add an explicit `types` array to `tsconfig.json`.** Doing so turns off the implicit
"all `@types` packages" behavior that React and Node globals currently rely on. Use
`globals: false` in the Vitest config and explicit imports instead.

---

## Phase 1: Runner Bootstrap

### Overview

Install and wire Vitest + fast-check so that `npm run test` runs, is linted, is typechecked, and gates
CI. Ends with one real passing test so the runner is proven rather than merely configured.

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the test runner and the property-based generator as dev dependencies, and expose the
scripts the rest of the plan and CI depend on.

**Contract**: `vitest@^4.1.0` and `fast-check@^4.9.0` in `devDependencies`. New scripts:
`test` → `vitest run`, `test:watch` → `vitest`. Leave the existing `vite` override untouched — it is
what keeps a single Vite copy in the tree.

#### 2. Vitest configuration

**File**: `vitest.config.ts` (new, repo root)

**Intent**: Standalone config rather than `getViteConfig`, so a suite of pure functions does not pull
the Cloudflare adapter's Vite plugin chain into every run.

**Contract**: `test.environment: "node"`, `test.globals: false`, `test.include: ["src/**/*.test.ts"]`.
Must re-declare the `@/*` alias that `tsconfig.json:9-11` provides and Astro's alias plugin normally
supplies — without it, any test importing `@/lib/...` fails to resolve:

```ts
resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }
```

#### 3. ESLint override for test files

**File**: `eslint.config.js`

**Intent**: Allow ordinary test scaffolding without disabling type-aware linting for the project.
Required in the same commit as the first test file.

**Contract**: A new config block with `files: ["**/*.test.ts"]` relaxing
`@typescript-eslint/no-unsafe-assignment`, `no-unsafe-member-access`, `no-unsafe-call`,
`no-non-null-assertion` and `no-explicit-any` to `off`. Must be placed after the existing
`tseslint.config()` spread but before `eslint-plugin-prettier/recommended`, so Prettier formatting
still applies to test files.

#### 4. Ignore coverage output

**Files**: `.gitignore`, `.prettierignore`

**Intent**: Neither file currently lists `coverage/`, so coverage output would be linted by
`eslint .` and rewritten by Prettier.

**Contract**: `coverage/` added to both.

#### 5. CI test step

**File**: `.github/workflows/ci.yml`

**Intent**: Make the suite a real gate. Placed before `build` so failures surface in seconds rather
than after the slow Astro/Cloudflare build.

**Contract**: `- run: npm run test` as a new step in the `ci` job, between `npm run lint` and
`npm run build`. No `env:` block needed — Phase 1 tests touch neither Supabase variable. The existing
`needs: ci` on the `deploy` job is what makes this gate the deploy; no change there.

#### 6. Agent-facing documentation

**File**: `AGENTS.md`

**Intent**: `:29` currently asserts no test runner exists, which becomes false in this phase.

**Contract**: Replace that line with the test commands; add `npm run test` / `npm run test:watch` to
the "Build, Test, and Development Commands" list (`:20-29`); update the "CI Gate" paragraph (`:37`) to
include the test step in the enumerated sequence.

#### 7. Proving test

**File**: `src/lib/safe-redirect.test.ts` (new)

**Intent**: One genuine test so Phase 1 ends with evidence the runner works end-to-end, rather than
config that has never executed. `safe-redirect.ts` is chosen because it imports nothing at all, so a
failure here means the runner is broken rather than the module.

**Contract**: A small `describe`/`it` set over `safeRedirect`'s existing behavior, using explicit
`import { describe, it, expect } from "vitest"` (not globals).

### Success Criteria:

#### Automated Verification:

- Test suite runs and passes: `npm run test`
- Linting passes including the new test file: `npm run lint`
- Build is unaffected: `npm run build`
- Vitest resolves the `@/*` alias: a scratch import of `@/lib/tournament` inside a test resolves

#### Manual Verification:

- `npm run test:watch` starts and re-runs on file change
- The pre-commit hook (`npx lint-staged`) does not reject a staged `*.test.ts` file
- CI shows the test step running between lint and build on the next push

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 2: Pure-Function and Drift Tests

### Overview

Cover everything genuinely testable in-process today. Two categories: pure domain functions, and the
DB↔TS constant pairs that are currently held together only by comments — a defect class this repo has
already shipped twice (prior review findings F3 and F6).

### Changes Required:

#### 1. Domain constant and guard tests

**File**: `src/lib/tournament.test.ts` (new)

**Intent**: Pin `generateJoinCode`'s output contract and the two error-token type guards.

**Contract**: Property-based coverage via fast-check for `generateJoinCode`: always length 6, always
matches `JOIN_CODE_PATTERN`, and **leading zeros are preserved** — the obvious implementation bug for
a numeric join code is to lose them. Include a distribution sanity check across many samples (all six
digit positions vary), not a statistical test. Table-driven coverage for `isJoinTournamentError` and
`isStartTournamentError` over both their own tokens and foreign strings.

#### 2. Schema boundary tests

**File**: `src/lib/schemas.test.ts` (new)

**Intent**: `src/lib/schemas.ts:22` is the **only** enforcement of the 1–20 `rounds_per_match` bound
anywhere in the system — the database deliberately has no CHECK
(`supabase/migrations/20260729164628_tournament_tables.sql:12-13`). That makes these the
highest-value pure unit tests in the repo.

**Contract**: Boundary coverage on `createTournamentSchema` at 0, 1, 20, 21, `10.5`, `""` and
non-numeric input; on `joinTournamentSchema` for 6-digit codes, whitespace-padded codes, wrong
lengths and non-digits; on `signUpProfileSchema` at 0, 1, 40 and 41 characters plus
whitespace-only input.

#### 3. Status vocabulary constants

**File**: `src/lib/tournament.ts`

**Intent**: `matches.status` is typed as bare `string` in `src/db/database.types.ts:24` (the enum was
dropped for a text+CHECK), so its four legal values exist only in SQL and a typo compiles clean. Add
the shared vocabulary so the drift test has something to assert against and S-03 has something to
adopt.

**Contract**: Exported `MATCH_STATUSES` and `TOURNAMENT_STATUSES` as `as const` tuples with derived
union types, following the shape of the existing `JOIN_TOURNAMENT_ERRORS` / `START_TOURNAMENT_ERRORS`
constants in the same file. Values must match
`supabase/migrations/20260731174617_pairing_schema.sql:43` and the `tournament_status` enum at
`supabase/migrations/20260729164628_tournament_tables.sql:19` exactly.

#### 4. DB↔TS drift tests

**File**: `src/lib/db-constants.test.ts` (new)

**Intent**: Assert that every constant duplicated between SQL and TypeScript still agrees, by reading
the migration files as text fixtures. Needs no database and runs in milliseconds.

**Contract**: Read the relevant migration files from disk and assert against the TypeScript constants:
the player cap 50 (`20260729192744_join_tournament_membership_shortcircuit.sql:65`) vs
`MAX_PLAYERS_PER_TOURNAMENT`; the display-name bound 40 (`20260731181103_player_profiles.sql:21` and
`20260801170309_profile_trigger_hardening.sql:27`) vs `MAX_DISPLAY_NAME_LENGTH`; the join-code regex
(`20260730203114_join_code_six_digits.sql:22`) vs `JOIN_CODE_PATTERN`; the four `matches_status_check`
values vs `MATCH_STATUSES`; the `tournament_status` enum members vs `TOURNAMENT_STATUSES`; and every
`detail =` error token raised by `join_tournament` and `start_tournament` vs the two error-token
objects. Each assertion must fail with a message naming both sides and the migration path, so a
future failure is self-explaining.

#### 5. Extract the WebSocket message parser

**Files**: `src/durable/match-message.ts` (new), `src/durable/match-room.ts`

**Intent**: `parse` is the only input-validation boundary on the WebSocket, and S-03 must touch it to
add socket verification. Pinning its contract first is the point. Extraction is required because
`match-room.ts:1` imports `cloudflare:workers`, which is unresolvable outside workerd.

**Contract**: Move the `Move`, `Seat` and `ClientMessage` types and the `parse` function (and the
`MOVES` membership list it depends on) into `src/durable/match-message.ts` as pure, exported members;
`match-room.ts` re-imports them. Behavior must be identical — this is a move, not a rewrite. Note the
existing discrepancy: `parse` is declared `: ClientMessage | null` but its return spreads an optional
`playerId` field not declared on `ClientMessage` (`match-room.ts:283-288` vs `:10-13`). Preserve the
runtime behavior exactly and widen the declared return type to match what it actually returns, rather
than silently dropping the field.

#### 6. Parser contract tests

**File**: `src/durable/match-message.test.ts` (new)

**Intent**: Pin the parser's accept/reject contract before S-03 adds authentication to it.

**Contract**: Valid `commit` frames for both moves; rejection of malformed JSON, non-object payloads,
unknown `type`, missing `move`, and a `move` value outside `MOVES`; and explicit coverage of the
`playerId` passthrough so S-03 cannot remove it unnoticed.

### Success Criteria:

#### Automated Verification:

- All tests pass: `npm run test`
- Linting passes: `npm run lint`
- Build succeeds after the `match-room.ts` extraction: `npm run build`
- Drift tests fail loudly when a constant is edited: temporarily change `MAX_PLAYERS_PER_TOURNAMENT`, confirm a named failure, revert

#### Manual Verification:

- The dev match-room harness at `/dev/match-room` still completes a round after the parser extraction
- A deliberate malformed WebSocket frame is still rejected as before

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 3: Scoring Specification and Oracle Tests

### Overview

The reason this change is sequenced before S-04. Write the scoring contract into the PRD as ratified
product specification, then encode it as `test.todo` expectations that S-04 must satisfy rather than
reinterpret.

### Changes Required:

#### 1. PRD Business Logic amendment

**File**: `context/foundation/prd.md`

**Intent**: The PRD currently defines the score only as prose that cannot produce an expected value.
Replace the undefined terms with an operational specification. These decisions were ratified during
planning on 2026-08-01.

**Contract**: Amend the **Business Logic** section's *Output* paragraph and add a subsection defining:

- **Payoff matrix** (Axelrod standard): own Współpraca + opponent Współpraca → **3**; own Sabotaż +
  opponent Współpraca → **5**; own Współpraca + opponent Sabotaż → **0**; own Sabotaż + opponent
  Sabotaż → **1**. Record that this satisfies both Prisoner's Dilemma constraints — `T > R > P > S`
  (5 > 3 > 1 > 0) and `2R > T + S` (6 > 5), the latter being what makes sustained mutual cooperation
  beat alternating exploitation.
- **Score**: the plain sum of a player's points across every round they have played in the
  tournament. **The "zero-balanced" weighting requirement is withdrawn** — record that it was
  withdrawn deliberately on 2026-08-01, not lost, and that it ranks identically to any per-round
  average when the round robin completes.
- **Matches played**: displayed alongside every score. Record why: with no forfeit/timeout in MVP
  (FR-004's resolution) and the free-pacing NFR, players can complete different numbers of matches, so
  a total can favour volume. Surfacing the count lets the facilitator see and explain that rather than
  be misled by it.
- **Initial aggression** = (matches whose first move by this player was Sabotaż) ÷ (matches in which
  this player played at least one round). **Undefined when the denominator is zero.**
- **Forgiveness** = among all rounds *i* where the opponent played Sabotaż at round *i−1* within the
  same match and round *i* exists, the fraction in which this player played Współpraca at round *i*.
  **Undefined when the player was never provoked.** Note that a match's final round is never a
  provocation, because no round follows it.
- **Undefined rendering**: any undefined statistic renders as `—`, never as `0` and never as `1.0`,
  and the player is not omitted from the board.

Also update **FR-008** to reference this subsection so the requirement points at a definition rather
than at prose.

#### 2. Roadmap note for S-04

**File**: `context/foundation/roadmap.md`

**Intent**: S-04's entry must inherit two decisions made here, or it will re-derive them differently.

**Contract**: Under S-04, record that scoring and statistics are to be computed in a **pure
TypeScript module** under `src/lib/` — deliberately departing from the PL/pgSQL precedent set by
`join_tournament` and `start_tournament`, and from the definer-function intent noted at
`supabase/migrations/20260729192557_tighten_tournament_update_policy.sql:14-17` — so that the logic
stays reachable by unit tests. The definer function owns persistence and the status flip only. Also
record that S-04 must turn on the `test.todo` cases from this phase, and that move persistence to
Postgres remains undesigned and blocks the whole slice.

#### 3. Scoring oracle tests

**File**: `src/lib/scoring.test.ts` (new)

**Intent**: Encode the specification as executable expectations before any implementation exists.
Because the module under test does not exist, these are `test.todo` — the values live in the test
titles and in a commented assertion body, so S-04 turns them on rather than writing them.

**Contract**: A file header comment stating plainly that these expectations derive from the PRD
Business Logic specification and **must not** be regenerated from an implementation. The intended
module surface is `src/lib/scoring.ts` exporting a payoff lookup, a per-player score aggregate, and
the two statistics.

Three fixtures, defined as data in the test file:

- **Match A** — Alice vs Bob, 5 rounds: `(C,S) (C,C) (S,C) (S,S) (C,S)`
- **Match B** — Carol vs Dave, 3 rounds: all `(C,C)`
- **Match C** — Alice vs Carol, 2 rounds: Alice `S,S`; Carol `C,C`

Expected values, all derived by hand from the specification above:

| Player | Score | Matches | Initial aggression | Forgiveness |
|---|---|---|---|---|
| Alice | **19** | 2 | **0.5** (1 of 2 matches opened with Sabotaż) | **1.0** (2 of 2 provocations answered with Współpraca) |
| Bob | **14** | 1 | **1.0** | **0.0** (0 of 2) |
| Carol | **9** | 2 | **0** | **1.0** (1 of 1) |
| Dave | **9** | 1 | **0** | **undefined** — never provoked |

Per-round payoff assertions for Match A must also be pinned individually (`0,3,5,1,0` for Alice;
`5,3,0,1,5` for Bob), so a matrix transposition fails distinguishably from an aggregation error.

Three properties of this fixture set are deliberate and must be preserved if it is ever edited:

1. **Alice and Bob's totals are asymmetric** (19 vs 14), so a symmetric swap bug cannot pass.
2. **Dave is never provoked**, exercising the undefined case that must not render as `1.0`.
3. **The ranking inverts under normalization** — Alice leads on total (19 > 14) but Bob leads on
   points per round (2.8 > 2.71). This is precisely why matches-played is displayed, and it makes that
   decision testable rather than decorative.

Add `test.todo` cases for the edge conditions too: a match with zero rounds played contributes to
neither statistic's denominator; a final-round Sabotaż is not a provocation; a player with no matches
has both statistics undefined rather than zero.

### Success Criteria:

#### Automated Verification:

- Suite still passes with the todo cases present: `npm run test`
- Vitest reports the todo count in its summary rather than failures
- Linting passes: `npm run lint`

#### Manual Verification:

- The PRD amendment reads as a specification someone could implement from without asking a question
- Each expected value in the table can be re-derived by hand from the PRD text alone, without reading any test code
- The withdrawal of the zero-balance requirement is recorded as a decision, not silently dropped

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 4: Pairing Oracle

### Overview

Pairing correctness cannot be proven in-process because the algorithm is SQL. Build the pure
TypeScript round-robin oracle and property-test it, so Phase 2 of the rollout can run the same rosters
through Postgres and assert set-equality against it.

### Changes Required:

#### 1. Round-robin oracle

**File**: `src/lib/pairing-oracle.ts` (new)

**Intent**: An independent reference implementation of the circle method, written from the algorithm's
definition rather than transcribed from
`supabase/migrations/20260801170219_pairing_set_based.sql:87-104`. Independence is the point — a
transcription would agree with the SQL by construction, including any bug.

**Contract**: A pure function taking an ordered player-id list and returning pairs with their round
ordinals. Must reproduce the shipped conventions so the schedules are comparable: players sorted
ascending (the SQL uses `array_agg(user_id order by user_id)`); odd rosters get a phantom slot whose
pairs are dropped rather than written as byes; round ordinals are 1-based.

A file header must state that this module is a **test oracle, not production code**, is not imported
by anything shipped, and exists to be compared against the SQL in rollout Phase 2.

#### 2. Oracle property tests

**File**: `src/lib/pairing-oracle.test.ts` (new)

**Intent**: Prove the oracle is a correct round robin before it is trusted to judge the SQL.

**Contract**: fast-check properties over rosters of size 2–50: exactly `n(n−1)/2` pairs; every
unordered pair appears exactly once; no player is ever paired with themselves; **no player appears
twice within one round ordinal**; round ordinals span 1..`n−1` for even `n` and 1..`n` for odd `n`.

The no-player-twice-per-round property is the one that matters most: `round_number` participates in no
database constraint or index, so that specific corruption would land silently in production. The
lifetime-scoped `matches_tournament_pair_uniq` index does not cover it.

Include explicit worked cases for n=3 and n=4 matching the hand-traces recorded in
`context/changes/generate-round-robin-pairing/reviews/impl-review.md:227-229`, so the oracle agrees
with the only prior verification that exists.

### Success Criteria:

#### Automated Verification:

- All properties hold across the full range: `npm run test`
- Property tests exercise n=2 through n=50 without a counterexample
- Linting and build pass: `npm run lint`, `npm run build`

#### Manual Verification:

- The n=4 schedule matches the hand-trace in the prior review (R1: 1-2, 3-4 / R2: 1-3, 4-2 / R3: 1-4, 2-3)
- The oracle module is confirmed unreferenced by any shipped code path

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 5: State-Machine Invariants and the Dead-End Record

### Overview

Record Risk #5's confirmed dead ends in the two places that will actually be read: as `test.todo`
invariants S-03/S-04 must turn on, and as a standing design rule that stops the class recurring.

### Changes Required:

#### 1. Lessons file

**File**: `context/foundation/lessons.md` (new)

**Intent**: The repo has no `lessons.md` yet, and three separate implementation reviews each
independently rediscovered a dead end. That is a recurring class, which is what this file is for.

**Contract**: A rule stating that no status value may ship without a demonstrated exit transition, and
that "unreachable by design" must be recorded with the mechanism that makes it unreachable, not
asserted. Cite the three prior instances as evidence:
`tournament-data-model` F1 (`reviews/impl-review.md:36-53`), `realtime-match-scaffold` F2
(`reviews/impl-review.md:49-61`), `generate-round-robin-pairing` F1 (`reviews/impl-review.md:30-79`).
Add a second rule for the DB↔TS drift class (F3, F6), pointing at the Phase 2 drift tests as the
mechanism that now enforces it.

#### 2. State-machine invariant tests

**File**: `src/lib/state-machine.test.ts` (new)

**Intent**: Encode the transition invariants as executable expectations. These are `test.todo` because
each currently fails **correctly** — the transitions are unbuilt features, not regressions.

**Contract**: The transition table from `research.md` §5 expressed as data, plus `test.todo` cases
naming each dead end and its owning slice:

- **D1** — every reachable `tournaments.status` has at least one exit transition. Currently false:
  `started` has none, and `finished` has no writer. Owner: S-04.
- **D2** — every value in `MATCH_STATUSES` has a writer. Currently false: only `pending` does.
  Owner: S-03.
- **D3** — a match room may only be seated by a player named on that match. Currently false:
  `src/worker.ts:36-64` authenticates without authorizing. Owner: S-03.
- **D4** — a match supports `rounds_per_match` rounds. Currently false: a room holds exactly one.
  Owner: S-03.

Each todo title must name the failing state, the owning slice, and a `research.md` reference, so
whoever turns it on has the trace without re-deriving it.

#### 3. Roadmap notes for S-03

**File**: `context/foundation/roadmap.md`

**Intent**: D2, D3 and D4 all land in S-03's scope and are not currently named in its entry.

**Contract**: Under S-03, record the three dead ends with their `research.md` references, and note
that `generate-round-robin-pairing` F1's deferred pacing-model decision (rounds-as-barriers vs live
matching) is a prerequisite for marking any match `finished` — including the pre-written test
requirement from that review: *any test of mutuality must start from an uneven completion count.*

### Success Criteria:

#### Automated Verification:

- Suite passes with the new todo cases: `npm run test`
- Linting passes: `npm run lint`
- Every `MATCH_STATUSES` and `TOURNAMENT_STATUSES` member appears in the transition table fixture

#### Manual Verification:

- Each dead-end todo names a state, an owning slice, and a research reference
- `lessons.md` reads as a rule a reviewer could apply, not as a description of past bugs

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation before proceeding.

---

## Phase 6: Cookbook and Test-Plan Reconciliation

### Overview

Fill in the cookbook entries this phase owns, and correct the two places where the test plan's
assumptions did not survive research.

### Changes Required:

#### 1. Cookbook entries

**File**: `context/foundation/test-plan.md`

**Intent**: §6.1 and §6.2 are `TBD — see §3 Phase 1`, and this is the phase that fills them.

**Contract**: §6.1 (unit test for a derived value) documents location (`src/lib/*.test.ts` sibling),
naming, the run command, a reference test to copy, and — the substance of the entry — the rule that an
expected value must be derived from the PRD specification and never lifted from the implementation
under test, with `src/lib/scoring.test.ts` as the worked example. §6.2 (property-based test for a score
invariant) documents the fast-check setup, points at `src/lib/pairing-oracle.test.ts` as the reference,
and records that a property is the right tool when a claim quantifies over an input range that
examples cannot cover.

#### 2. Phased-rollout corrections

**File**: `context/foundation/test-plan.md`

**Intent**: §3 Phase 1 claims pairing as a `unit, property-based` target, which research disproved.
§5's unit gate becomes enforceable once Phase 1 lands.

**Contract**: In §3, move pairing correctness from Phase 1 to Phase 2, noting that the algorithm is
SQL-resident and that Phase 1 delivered the differential oracle it will be judged against; mark the
Phase 1 row `complete`. In §5, change the `unit + property-based` gate from
`required after §3 Phase 1` to `required (wired)`. In §2's Risk #1 row, record that the oracle context
it asked research to ground is now specified in the PRD rather than outstanding.

#### 3. Change-folder closure

**File**: `context/changes/testing-derived-output-correctness/change.md`

**Intent**: Record the decisions that future readers will need and that live nowhere else.

**Contract**: Note the four decisions with lasting consequence: the Axelrod matrix as canonical, the
deliberate withdrawal of the zero-balance requirement, the pure-TypeScript-module direction for S-04's
statistics, and the `test.todo`-as-specification mechanism with the list of files carrying todos that
later slices must turn on.

### Success Criteria:

#### Automated Verification:

- Full suite passes: `npm run test`
- Lint and build pass: `npm run lint`, `npm run build`
- No `TBD — see §3 Phase 1` markers remain in `test-plan.md`

#### Manual Verification:

- §6.1 answers "how do I add a test for a derived value here?" without needing the plan open
- §3's Phase 1 row reads `complete` and pairing appears under Phase 2
- A reader of `change.md` can find the payoff matrix decision without opening the PRD

**Implementation Note**: This is the final phase. After it passes, `test-plan.md` §3 Phase 1 is
complete and the orchestrator can advance to Phase 2.

---

## Testing Strategy

### Unit Tests

- `generateJoinCode` format and leading-zero preservation; the two error-token guards
- All three Zod schemas at their boundaries — the only enforcement of `rounds_per_match` anywhere
- `safeRedirect` behavior
- The extracted WebSocket message parser's accept/reject contract, including `playerId` passthrough
- DB↔TS drift across five constant pairs, using migration files as text fixtures

### Property-Based Tests

- `generateJoinCode` over many samples
- The pairing oracle over rosters of size 2–50, with four invariants — most importantly that no player
  appears twice in one round, which has no database backstop

### Specification Tests (`test.todo`)

- Scoring and statistics against the hand-derived fixture set — turned on by S-04
- State-machine exit invariants D1–D4 — turned on by S-03 and S-04

### Manual Testing Steps

1. Run `npm run test` on a clean checkout after `npm ci`; confirm green with a visible todo count.
2. Change `MAX_PLAYERS_PER_TOURNAMENT` to 51; confirm the drift test fails naming both sides and the
   migration path; revert.
3. Open `/dev/match-room` in two browsers after the parser extraction; complete one round; confirm the
   reveal still fires for both and post-reveal commits are still refused.
4. Re-derive Bob's forgiveness (`0.0`) and Dave's (`undefined`) by hand from the PRD text alone,
   without opening `scoring.test.ts`. If either cannot be re-derived, the specification is incomplete.
5. Push a branch and confirm CI runs the test step between lint and build, and that a deliberately
   failing test blocks the `deploy` job.

## Performance Considerations

The pairing oracle's property tests are the only meaningful cost: n=50 generates 1225 pairs per case,
and fast-check will run many cases. Cap the roster size at 50 (the product's hard cap) and keep the
default run count; if the suite exceeds a few seconds, reduce `numRuns` for the largest-roster property
rather than shrinking the range — the upper bound is where the schedule is least exercised by manual
testing.

## Migration Notes

No data migration. The only shipped-code changes are the extraction of the message parser into
`src/durable/match-message.ts` (behavior-preserving) and the addition of two status-vocabulary
constants. Both are covered by lint, typecheck and build, plus the manual dev-harness check in Phase 2.

## References

- Research: `context/changes/testing-derived-output-correctness/research.md`
- Test plan: `context/foundation/test-plan.md` §2 (risks), §3 (rollout), §5 (gates), §6 (cookbook)
- PRD: `context/foundation/prd.md` — Business Logic, FR-004, FR-008, NFRs
- Domain grounding for the payoff matrix: `context/foundation/shape-notes.md:61`
- Pairing algorithm: `supabase/migrations/20260801170219_pairing_set_based.sql:64-106`
- Prior dead-end findings: `context/changes/tournament-data-model/reviews/impl-review.md:36-53`,
  `context/changes/realtime-match-scaffold/reviews/impl-review.md:49-61`,
  `context/changes/generate-round-robin-pairing/reviews/impl-review.md:30-79`
- Zero-balance analysis: `context/changes/generate-round-robin-pairing/research.md:47`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Runner Bootstrap

#### Automated

- [x] 1.1 Test suite runs and passes: `npm run test`
- [x] 1.2 Linting passes including the new test file: `npm run lint`
- [x] 1.3 Build is unaffected: `npm run build`
- [x] 1.4 Vitest resolves the `@/*` alias

#### Manual

- [x] 1.5 `npm run test:watch` starts and re-runs on file change
- [x] 1.6 Pre-commit hook does not reject a staged `*.test.ts` file
- [x] 1.7 CI shows the test step running between lint and build

### Phase 2: Pure-Function and Drift Tests

#### Automated

- [ ] 2.1 All tests pass: `npm run test`
- [ ] 2.2 Linting passes: `npm run lint`
- [ ] 2.3 Build succeeds after the `match-room.ts` extraction: `npm run build`
- [ ] 2.4 Drift tests fail loudly when a constant is edited, then revert

#### Manual

- [ ] 2.5 Dev match-room harness still completes a round after the parser extraction
- [ ] 2.6 A malformed WebSocket frame is still rejected as before

### Phase 3: Scoring Specification and Oracle Tests

#### Automated

- [ ] 3.1 Suite still passes with the todo cases present: `npm run test`
- [ ] 3.2 Vitest reports the todo count in its summary rather than failures
- [ ] 3.3 Linting passes: `npm run lint`

#### Manual

- [ ] 3.4 PRD amendment reads as an implementable specification
- [ ] 3.5 Each expected value is re-derivable by hand from the PRD text alone
- [ ] 3.6 Withdrawal of the zero-balance requirement is recorded as a decision

### Phase 4: Pairing Oracle

#### Automated

- [ ] 4.1 All properties hold across the full range: `npm run test`
- [ ] 4.2 Property tests exercise n=2 through n=50 without a counterexample
- [ ] 4.3 Linting and build pass: `npm run lint`, `npm run build`

#### Manual

- [ ] 4.4 The n=4 schedule matches the hand-trace in the prior review
- [ ] 4.5 The oracle module is confirmed unreferenced by any shipped code path

### Phase 5: State-Machine Invariants and the Dead-End Record

#### Automated

- [ ] 5.1 Suite passes with the new todo cases: `npm run test`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 Every status-vocabulary member appears in the transition table fixture

#### Manual

- [ ] 5.4 Each dead-end todo names a state, an owning slice, and a research reference
- [ ] 5.5 `lessons.md` reads as an applicable rule, not a description of past bugs

### Phase 6: Cookbook and Test-Plan Reconciliation

#### Automated

- [ ] 6.1 Full suite passes: `npm run test`
- [ ] 6.2 Lint and build pass: `npm run lint`, `npm run build`
- [ ] 6.3 No `TBD — see §3 Phase 1` markers remain in `test-plan.md`

#### Manual

- [ ] 6.4 §6.1 answers "how do I add a test for a derived value here?" standalone
- [ ] 6.5 §3 Phase 1 reads `complete` and pairing appears under Phase 2
- [ ] 6.6 `change.md` records the payoff matrix decision findably
