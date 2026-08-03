<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Runner Bootstrap and Derived-Output Correctness

- **Plan**: `context/changes/testing-derived-output-correctness/plan.md`
- **Scope**: Phases 1–6 of 6 (full plan)
- **Date**: 2026-08-03
- **Verdict**: NEEDS ATTENTION (triaged 2026-08-03 — 8 fixed, 2 skipped)
- **Findings**: 0 critical, 5 warnings, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Note: this is a review of work the reviewing agent wrote itself, so the two independent
sub-agent readings carry more weight than usual. Both found problems the author did not, and two
of their claims were in turn wrong and are corrected below. Success Criteria is PASS on
independent re-verification: an agent re-ran the suite (188 passed | 42 todo, 2.99s), broke a
drift assertion, confirmed the named failure, reverted it, and confirmed `git diff` clean.

## Findings

### F1 — The pairing oracle's independence claim overstates what the code does

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/lib/pairing-oracle.ts:15-23`, `:63-93`
- **Detail**: The plan (`plan.md:474-487`) made independence the explicit point: "written from the
  algorithm's definition rather than transcribed … a transcription would agree with the SQL by
  construction, including any bug." The header at `:15-17` claims exactly that was done.

  The arithmetic says otherwise. Term for term against
  `20260801170219_pairing_set_based.sql:84-104`: `slots = count + (count % 2)` ↔ `v_slots`;
  `rounds = slots - 1` ↔ `v_rounds`; `onCircle((position + step) % rounds)` ↔
  `2 + ((r-1+i) % v_rounds)`; `onCircle((position - step + rounds) % rounds)` ↔
  `2 + ((r-1-i+v_rounds) % v_rounds)`, including the same negative-safe `+ rounds` idiom. Even
  the variable names mirror the SQL's. A genuinely different formulation — array rotation,
  fixing element 0 and pairing `i` with `len-1-i` — has a visibly different shape.

  There is a real tension the plan did not acknowledge: it *also* required reproducing the SQL's
  exact round assignment so the schedules are comparable, and pinned that with the n=4
  hand-trace. A rotation formulation produces a valid but *differently numbered* schedule
  (R1 would be 1-4, 2-3 rather than 1-2, 3-4), so it cannot satisfy both requirements at once.

  Residual risk is narrow, because `pairing-oracle.test.ts` proves the schedule against
  round-robin invariants rather than against the SQL, exhaustively for n=2..50. The oracle is
  *proven* independently even though it was not *written* independently. What is wrong is the
  header asserting a property the code does not have — the same defect class as the false
  mutuality comment caught in `generate-round-robin-pairing` F1.
- **Fix A ⭐ Recommended**: Correct the header to state what was actually done and why — that the
  formulation is shared because reproducing the SQL's round assignment was a hard requirement,
  that independence is therefore limited to expression rather than derivation, and that the
  properties are the proof.
  - Strength: Truthful, keeps the comparability the plan needs and the n=4 agreement, and costs
    nothing. The properties already carry the real verification burden.
  - Tradeoff: The plan's stated goal of catching a shared misreading of the circle method is not
    achieved, only documented as not achieved.
  - Confidence: HIGH — the invariant tests demonstrably do not depend on the SQL.
  - Blind spot: If the SQL and this oracle share a wrong understanding of the circle method that
    the seven invariants happen not to distinguish, nothing here would catch it.
- **Fix B**: Rewrite with the rotation formulation and drop the exact-round-assignment
  requirement, comparing per-round *partitions* instead of numbered rounds in rollout Phase 2.
  - Strength: Delivers the independence the plan asked for.
  - Tradeoff: Breaks the n=4 hand-trace agreement, which is the only prior verification the SQL
    has; Phase 2's comparison gets more complex.
  - Confidence: MEDIUM — the looser comparison is weaker evidence about round assignment, which
    is precisely where `round_number` has no database constraint.
  - Blind spot: Have not prototyped the partition comparison.
- **Decision**: FIXED via Fix A — header rewritten to state that the formulation is shared
  because exact round assignment was required, that a rotation formulation would produce
  different round numbers (R1 = 1-4, 2-3), and that the properties rather than the agreement
  carry the verification.

### F2 — The roadmap now promises and withdraws the zero-balanced score in the same entry

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/foundation/roadmap.md:137` vs `:146`
- **Detail**: S-04's Outcome line still reads "…their own **zero-balanced score**, and behavioral
  statistics…", while nine lines below the same entry records that the requirement was
  deliberately withdrawn. The withdrawal was the point of Phase 3, and the roadmap is now
  self-contradictory at the exact place S-04's implementer will read first.
- **Fix**: Rewrite the Outcome line to say "their own score and matches played, and behavioral
  statistics", matching the PRD's ratified specification.
- **Decision**: FIXED — Outcome line rewritten and pointed at the PRD subsection.

### F3 — The drift tests pin migration paths with no staleness guard, while claiming otherwise

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/lib/db-constants.test.ts:30-31`, `:58`, `:72-73`, `:108`, `:122-123`, `:159`, `:174`
- **Detail**: The header states "a drift test silently reading a stale file is the very failure it
  exists to prevent" — but nothing enforces it. Concretely: add
  `2026xxxx_join_tournament_v2.sql` raising the cap to 100; this test still reads
  `20260729192744`, still finds 50, still passes, and the TypeScript constant stays wrong.

  That is `tournament-data-model` F3 recurring — a pointer to a superseded migration — which is
  one of the two instances `context/foundation/lessons.md` cites as the reason this file exists.
  The file honours the lesson for the constants and violates it for its own inputs.
- **Fix**: Assert that each pinned file is the newest migration matching the relevant
  `create or replace function public.<name>` (or, for constraints, the newest touching that
  constraint). Roughly six lines reading the migrations directory; still no database needed.
- **Decision**: FIXED — `assertNewestDefinition()` added and wired into all six pinned groups.
  Verified by dropping a probe migration redefining `join_tournament` into the directory: two
  tests failed naming both the pinned and the superseding file, then passed again once removed.

### F4 — A state-machine test claims to detect a fixed dead end and cannot

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/state-machine.test.ts:79-87`
- **Detail**: The comment says "if someone fixes a dead end without turning on the matching todo,
  this fails and points them at it." It cannot. Fixing a dead end means adding SQL — an UPDATE
  policy, or a function writing `finished`. This test only compares the hand-written table to
  itself, so it fails only if someone edits that literal by hand. The transition model was
  verified accurate today, but by inspection, not by mechanism.

  Same shape as F3: the status *vocabulary* is drift-tested against the migrations; the
  *writers and exits* are not, and the comment claims they are.
- **Fix**: Reword the comment to say what it actually does — pins the hand-maintained model so
  an unexplained edit is visible — or grep the migrations for `set status` writers and assert
  against that, which would make the claim true.
- **Decision**: FIXED (both halves) — the old comment now says only what it does, and a new test
  scans every migration for `set status = '<value>'` on any status the model calls unwritten,
  so a dead end fixed in SQL fails the model rather than silently outdating it.

### F5 — The scoring oracle contradicts itself on the move vocabulary

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/scoring.test.ts:32` vs `:43` and `:95-98`
- **Detail**: The declared module surface says `payoff(own: Move, opponent: Move)` where `Move` is
  the shipped `"cooperate" | "sabotage"`, while the fixtures define `type M = "C" | "S"` and the
  todos are written as `payoff('C','C')`. Those todos would not compile against the declared
  signature, and S-04 inherits an unstated mapping between the two vocabularies. The arithmetic
  is unaffected and was independently re-derived as correct by both reviewers.
- **Fix**: Either write the fixtures in terms of `Move` and drop `M`, or state explicitly in the
  header that `C`/`S` are fixture shorthand for `cooperate`/`sabotage` and write the todo titles
  in the shipped vocabulary.
- **Decision**: FIXED — header now states the shorthand explicitly and names the mapping S-04
  applies when turning the todos on.

### F6 — `MAX_FRAME_BYTES` does not bound bytes

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/durable/match-message.ts:53`, `src/durable/match-message.test.ts:90-99`
- **Detail**: `raw.length` counts UTF-16 code units, so a 1024-unit frame of three-byte UTF-8
  characters is about 3 KB. The original code was a bare `1024` making no unit claim; this
  change introduced the name and exports it from two modules, on the WebSocket's only validation
  boundary. The boundary test pads with ASCII, so it cannot distinguish the two readings and its
  stated purpose ("the bound is not off by one") reads stronger than it is. Not exploitable at
  3 KB.
- **Fix**: Rename to `MAX_FRAME_LENGTH`, or measure with `TextEncoder` and add a multi-byte case.
- **Decision**: FIXED — renamed to `MAX_FRAME_LENGTH` across all three files, with the unit
  stated and the ~3 KB multi-byte consequence recorded as acceptable for a work bound.

### F7 — Documentation left stale by the phase that existed to reconcile it

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/foundation/test-plan.md` §4 rows; `context/foundation/lessons.md:13-15`
- **Detail**: Two items Phase 6 should have swept. (a) §4's Vitest and fast-check rows still read
  "none yet — see §3 Phase 1" while §3 Phase 1 reads `complete` and §8 records both as installed
  and running; the fast-check note also cites "zero-balance" invariants that no longer exist.
  These are not literal `TBD — see §3 Phase 1` markers, so criterion 6.3 passed while the same
  staleness class survived. (b) `lessons.md` cites the three prior findings by change and id but
  omits the `reviews/impl-review.md` line anchors the plan (`plan.md:543-545`) required, so a
  reader must go hunting.
- **Fix**: Update the two §4 note cells to name the installed versions and their reference tests;
  add the three line anchors to `lessons.md`.
- **Decision**: FIXED — §4 rows now read **Wired** with versions, reference tests and a checked
  date; `lessons.md` carries the three review line anchors.

### F8 — A test-only module lives in the production helper directory

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: `src/lib/pairing-oracle.ts`
- **Detail**: `AGENTS.md` designates `src/lib/` as services and helpers. The header's "nothing
  shipped imports this module, and nothing should" is true today — verified by grep and by its
  absence from `dist/` — but the file is indistinguishable from a helper at the import prompt,
  and an accidental import would give the app a second pairing implementation that diverges from
  the SQL silently.
- **Fix**: Move to `src/test-support/` (updating the Vitest `include` glob, which is currently
  `src/**/*.test.ts` and would still match), or add a `no-restricted-imports` ESLint rule
  forbidding it outside `*.test.ts`.
- **Decision**: SKIPPED — accepted risk. The module is verifiably unreferenced today and absent
  from `dist/`; revisit if a second test-only module appears in `src/lib/`.

### F9 — The sampled pairing properties are strictly subsumed by the exhaustive sweep

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/pairing-oracle.test.ts:63-160` vs `:162-203`
- **Detail**: The seven fast-check properties draw `n` from `fc.integer({min: 2, max: 50})` —
  exactly the space the sweep enumerates — and both feed the same deterministic `roster(n)`.
  About 700 redundant schedule builds and roughly 2 of the suite's 3 seconds, for no added
  coverage. Worth noting because the file argues the sampled-versus-exhaustive distinction
  explicitly at `:162-166` and then keeps both.
- **Fix**: Keep the sweep; keep one or two sampled properties as the §6.2 cookbook reference and
  drop the rest, or give the sampled ones a generator the sweep does not cover (shuffled
  rosters, duplicate ids).
- **Decision**: SKIPPED — the redundancy costs ~2s and is harmless; the sampled properties also
  serve as the §6.2 cookbook reference, which has its own value.

### F10 — Assertions that cannot fail, consolidated

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/tournament.test.ts:19-26`, `:57`, `:78`; `src/durable/match-message.test.ts:16`; `src/lib/state-machine.test.ts:66-77`
- **Detail**: Four small instances of the pattern this change's own headers warn about.
  (a) `fc.property(fc.integer(), () => …)` ignores the generated value — a 500× loop wearing
  fast-check's clothes, whose shrinking and counterexample reporting are meaningless.
  (b) "accepts its own token" feeds `Object.values(JOIN_TOURNAMENT_ERRORS)` to a guard defined as
  `Object.values(JOIN_TOURNAMENT_ERRORS).includes(x)` — an identity. Same at
  `match-message.test.ts:16` for `MOVES`. The rejection cases are real, and `db-constants.test.ts`
  supplies the genuine SQL-side oracle, so no coverage is lost.
  (c) `state-machine.test.ts:66-77`'s second loop never executes, because every
  `MATCH_TRANSITIONS` entry has `exits: []` — the match half of that test asserts nothing.

  **Correction to a sub-agent claim**: it was reported that `it.each([])` silently registers zero
  tests while the file reports as passed. Probed directly — Vitest 4.1 raises
  `Error: No test found in suite`. So the sweep at `pairing-oracle.test.ts:167` is protected (it
  is alone in its `describe`). The risk survives only where an `it.each` over a computed array
  sits beside other tests, which is the case at `tournament.test.ts:61,82`.
- **Fix**: Use `fc.constant(null)` or a plain loop for (a); add
  `expect(cases.length).toBeGreaterThan(0)` at the two computed-array sites; either drop the
  match half of (c) or give one match status a non-empty `exits` once S-03 lands.
- **Decision**: FIXED — `fc.integer()` → `fc.constant(null)` with the reasoning recorded; both
  guard suites and the parser's move cases now assert against literal wire tokens rather than
  the objects that define them; non-vacuity assertions added at both computed-array sites; the
  exits loop now counts what it checked and fails if that count is zero.

## Verified clean

Recorded so a later review does not re-litigate them:

- **The `parse` extraction is behaviour-identical.** Diffed against
  `git show 703db3d^:src/durable/match-room.ts`: character-for-character the same apart from
  `1024` → `MAX_FRAME_BYTES`. No input changes accept/reject status. `ClientMessage` was widened
  with `playerId?: string` rather than the field being dropped, exactly as `plan.md:307-310`
  required. This was the highest-risk edit in the change — the only input-validation boundary on
  the WebSocket.
- **`seatFor`, `isComplete` and `committedFlags` were not extracted**, per the plan's explicit
  prohibition; all three remain private methods with unchanged bodies.
- **The scoring arithmetic is correct.** Both reviewers independently re-derived all four
  players' scores, match counts, initial aggression and forgiveness, the per-round sequences
  `0,3,5,1,0` and `5,3,0,1,5`, and the 2.8 > 2.71 ranking inversion. Plan, PRD and test file all
  agree with hand derivation. The four fixture-integrity tests are genuine and can fail.
- **The drift suite provably fails**, demonstrated end to end by an independent agent: break,
  named failure citing both sides and the migration path, revert, `git diff` clean.
- **Migration path choices are correct today** — each pinned file is the current live definition,
  and each regex has exactly one match in its file. (The absence of a *guard* on that is F3.)
- **All 8 test files are picked up** by the `include` glob; nothing is silently unrun.
- **`pairing-oracle.ts` is unreferenced by shipped code** — grep and `dist/` both confirm.
- **Scope guardrails all held**: no scoring module, no statistics computation, no scoreboard UI,
  no Postgres/RLS/API-route/protocol tests, no E2E, D1–D4 recorded rather than fixed, and
  `src/pages/tournaments/[id].astro` left on its hardcoded literals as the plan directed.
- **Success criteria**: 188 passed | 42 todo across 8 files; lint clean; build clean; all 34
  Progress rows carry a SHA.
