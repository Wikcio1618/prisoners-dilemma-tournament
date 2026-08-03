---
change_id: testing-derived-output-correctness
title: Runner bootstrap and derived-output correctness (test-plan Phase 1)
status: implemented
created: 2026-08-01
updated: 2026-08-03
archived_at: null
---

## Notes

Rollout Phase 1 of `context/foundation/test-plan.md`: "Runner bootstrap and derived-output correctness".

Risks covered: #1 (scores or behavioral statistics silently miscalculated; players debrief on wrong numbers), #5 (a tournament reaches a state it cannot leave).
Test types planned: unit, property-based.

Risk response intent:
- Risk #1: prove that a known move sequence produces exactly the score and behavioral classification the PRD's definitions demand. Must challenge the assumption that a statistic "looks reasonable" — reasonable and correct diverge silently here and no player will notice. The single most dangerous anti-pattern is the oracle problem: an expected value lifted from the statistics implementation makes the test tautological. The oracle must be derived independently from the PRD's Business Logic and FR-008.
- Risk #5: prove that every state the machine can enter has a route out, and that idempotent operations stay idempotent under retry. Must challenge "that state is unreachable by design" — three separate implementation reviews found reachable dead ends.

Hard constraint on sequencing: this phase must land BEFORE S-04 (tournament-results-and-stats) is implemented. Statistics written before their tests will supply the oracle to their own tests, which is precisely the failure Risk #1 exists to prevent.

Note the project currently has no test runner and no test files at all.

## Decisions with lasting consequence

Four things decided here that later slices inherit and should not re-derive.

### 1. The Axelrod payoff matrix is canonical

Own Współpraca + opponent Współpraca → **3**; own Sabotaż + opponent Współpraca → **5**; own
Współpraca + opponent Sabotaż → **0**; own Sabotaż + opponent Sabotaż → **1**. Written into
`context/foundation/prd.md` under Business Logic → *Scoring specification*, with both defining
constraints recorded: `T > R > P > S` (5 > 3 > 1 > 0) and `2R > T + S` (6 > 5). The second is
what makes sustained mutual cooperation beat alternating exploitation; break either and the
strategic patterns the tournament exists to teach stop appearing.

### 2. The "zero-balanced" score requirement is withdrawn

Deliberately, on 2026-08-01 — not lost. It was never formalized (deferred in `shape-notes.md`
and never resolved), and once the round robin completes it ranks identically to any per-round
average, because every player plays the same number of matches. Its only effect would be on an
incomplete tournament, where the honest fix is displaying **matches played** beside every score
rather than hiding the disparity inside a weighting nobody can interpret. Score is now the plain
sum of points across every round played.

### 3. S-04 computes statistics in a pure TypeScript module

`src/lib/scoring.ts`, deliberately departing from the PL/pgSQL precedent set by
`join_tournament` and `start_tournament`. The reason is testability: SQL-resident logic is
unreachable from the unit suite, which is exactly why pairing needed a separate oracle
(`src/lib/pairing-oracle.ts`) built at some cost. The definer function owns persistence and the
status flip only.

### 4. `test.todo` carries specifications that later slices must turn on

Expectations for code that does not exist yet are written as `test.todo` with the full expected
value in the title. The suite stays green so the quality gate can be enforced now, while the
oracle is provably written before the implementation — which is the only thing that stops the
implementation from supplying the oracle to its own tests.

Files carrying todos, and who owns turning them on:

| File | Todos | Owner |
| --- | --- | --- |
| `src/lib/scoring.test.ts` | 35 | **S-04** — the scoring and statistics oracle |
| `src/lib/state-machine.test.ts` | 7 | **S-03** (D2, D3, D4) and **S-04** (D1) |

Both files also carry live tests guarding their fixtures and transition table, so an edit that
would quietly invalidate a pending expectation fails immediately instead.

### Blocking issue surfaced, not resolved

**Move persistence to Postgres is undesigned and unowned.** Moves live only in Durable Object
storage; the DO holds no database credential. S-04 cannot compute any statistic from data that
was never persisted. Recorded against S-03 and S-04 in `context/foundation/roadmap.md`.
