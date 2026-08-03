# Runner Bootstrap and Derived-Output Correctness — Plan Brief

> Full plan: `context/changes/testing-derived-output-correctness/plan.md`
> Research: `context/changes/testing-derived-output-correctness/research.md`

## What & Why

Stand up the project's first test runner, then do the one thing that must happen before S-04 is built:
write the scoring oracle down. Risk #1 is that scores or behavioral statistics are silently
miscalculated and players debrief on wrong numbers. The specific way that risk materializes is the
**oracle problem** — if statistics are implemented first, their tests inevitably take expected values
from the implementation and can never fail for the right reason. Research found the oracle does not
exist anywhere in the repo, so this phase creates it: as ratified PRD specification, and as executable
expectations S-04 must satisfy rather than reinterpret.

## Starting Point

Zero test infrastructure — no runner, no config, no test files, and nothing that runs `tsc`. No
scoring code, no payoff matrix, and no persisted move history to compute from. Pairing, the only
derived output with real code, lives entirely in PL/pgSQL. Risk #5's dead ends turned out to be
confirmed and to be the main path rather than edge cases: a started tournament can never end, be left,
or be deleted; every match is permanently `pending`. Those are unbuilt features owned by S-03/S-04,
not regressions.

## Desired End State

`npm run test` runs a green suite locally and in CI, blocking deploy through the existing `needs: ci`
dependency. Every pure function and every duplicated DB↔TS constant is covered. The PRD carries a
complete scoring specification someone could implement from without asking a question, and that
specification exists as `test.todo` cases in the suite. The cookbook answers "how do I add a test for
a derived value here?"

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Payoff matrix | Axelrod 5/3/1/0 | The project already grounds itself in Axelrod; satisfies `T>R>P>S` and `2R>T+S` | Plan |
| Zero-balanced score | **Requirement withdrawn** — plain points total | Ranks identically to any average once the round robin completes | Plan |
| Incomplete tournaments | Show matches-played beside every score | No forfeit in MVP means uneven completion; surfacing volume lets the facilitator explain it | Plan |
| Undefined statistics | Explicit undefined, rendered `—` | A never-provoked player scoring 1.0 forgiveness is the exact silent-wrong failure Risk #1 targets | Plan |
| Where S-04 computes stats | Pure TypeScript module | Departs from the SQL precedent deliberately — it is what keeps Risk #1 unit-testable at all | Plan |
| Unwritten-code expectations | `test.todo` carrying the spec | Oracle provably precedes implementation while the suite stays green so the gate can be enforced now | Plan |
| Pairing | Oracle in this phase, verdict in rollout Phase 2 | Algorithm is SQL-resident; a TS port tested against itself would *be* the oracle problem | Research |
| Dead ends D1–D4 | `test.todo` invariants + `lessons.md` rule | Three prior reviews each rediscovered one — a recurring class needs a standing rule | Plan |
| Test layout | Colocated `src/lib/*.test.ts` | Matches the flat-within-concern grain; tsconfig, ESLint and lint-staged already cover it | Plan |
| `match-room.ts` | Extract `parse` only | Sole WebSocket input-validation boundary and S-03 must touch it; leaves the identity-binding fix alone | Plan |

## Scope

**In scope:** Vitest + fast-check bootstrap with CI wiring; unit and property tests for all pure
functions; DB↔TS drift tests; PRD scoring specification; `test.todo` oracle for scoring and
statistics; pure TS pairing oracle with property tests; state-machine invariants and `lessons.md`;
cookbook §6.1/§6.2 and test-plan reconciliation.

**Out of scope:** implementing S-04; designing move persistence; anything needing Postgres (rollout
Phase 2) or workerd (rollout Phase 3); fixing D1–D4; E2E tests; rewiring `[id].astro`'s hardcoded
status literals.

## Architecture / Approach

Standalone `vitest.config.ts` rather than Astro's `getViteConfig`, which would drag the Cloudflare
adapter's plugin chain into every run — the cost is duplicating one path alias. Two mechanisms carry
the phase's unusual shape: **`test.todo` as a specification carrier**, so expectations for unwritten
code keep the suite green while pinning the oracle; and **migration files as text fixtures**, so
constant drift between SQL and TypeScript is caught with no database in milliseconds.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Runner bootstrap | Vitest + fast-check, config, CI step, docs; one passing test | ESLint `strictTypeChecked` rejects test scaffolding unless the override lands in the same commit |
| 2. Pure-function and drift tests | Property + boundary coverage; five DB↔TS drift pins; `parse` extracted | Touching `match-room.ts`, which is untested and recently hardened by three critical fixes |
| 3. Scoring specification and oracle | PRD amendment; hand-derived fixture set as `test.todo` | A specification that is subtly incomplete produces a subtly wrong S-04 |
| 4. Pairing oracle | Pure TS round-robin + fast-check invariants for n=2..50 | Transcribing the SQL instead of deriving independently would defeat the purpose |
| 5. State-machine invariants | D1–D4 as todos; `lessons.md`; roadmap notes for S-03 | Todos that no slice ever turns on |
| 6. Cookbook and reconciliation | §6.1/§6.2 filled; pairing moved to Phase 2; gate flipped to wired | — |

**Prerequisites:** None. Everything runs in-process; no Docker, no Supabase, no Playwright.
**Estimated effort:** ~2–3 sessions across six phases. Phases 1, 4 and 6 are short; Phase 3 carries
the real thinking.

## Open Risks & Assumptions

- **Move persistence remains undesigned and unowned.** S-04 cannot compute anything until moves reach
  Postgres, and no route exists. This phase specifies the computation but cannot unblock its input.
- **`test.todo` is a weaker forcing function than a red suite.** S-04's and S-03's plans must
  explicitly own turning these on, or the specification quietly ages.
- **The S-04 pure-TypeScript direction departs from three slices of precedent** and from an existing
  migration comment. If S-04 reverts to a definer function, Risk #1's cheapest test layer disappears.
- **The pairing oracle proves nothing about shipped behavior until rollout Phase 2**, which needs
  Docker that is not currently installed.
- **Deadline pressure.** 2026-08-19 is hard, and S-01 through S-04 are all still unbuilt.

## Success Criteria (Summary)

- A developer can run `npm run test`, see it green, and have CI block a deploy on a failing test.
- Someone can read the PRD alone and hand-compute every expected score and statistic in the fixture
  set — no test code required.
- S-04 cannot ship a statistic whose expected value came from its own implementation.
