# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-08-03

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the risk wins. Do not
   promote to e2e because e2e "feels safer." Do not put a vision model on top of a
   deterministic diff that already catches the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team is worried about X,
   and the failure would surface somewhere in `<area>`" carry the same weight as PRD lines or
   hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents *what could fail* and *why
   we believe it's likely* — drawn from documents, interview, and codebase *signal* (churn,
   structure, test base). It does NOT claim to know which line owns the failure. That knowledge
   is produced by `/10x-research` during each rollout phase. If the plan and research disagree
   about where the failure lives, research is the ground truth.

A fourth rule is specific to this product: **the pedagogical payload is the deliverable.** A
tournament that runs smoothly and reports wrong statistics has failed completely while appearing
to succeed. Prefer tests that can distinguish "plausible" from "correct."

Hot-spot scope used for likelihood weighting: `src/`, `supabase/` (excluding
`src/db/database.types.ts` and lockfiles). 25 commits in the last 30 days — sufficient signal.

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by risk = impact ×
likelihood. Risks are failure scenarios in user / business terms, not test names. The Source
column cites the *evidence that surfaced this risk* — never a specific file as "where the
failure lives" (that is research's job, see §1 principle #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|---|---|---|---|
| 1 | Scores or behavioral statistics are silently miscalculated; players debrief on wrong numbers and take away a false lesson | High | High | interview Q1 (stated primary worry); PRD FR-008 + Business Logic; roadmap S-04 not yet built |
| 2 | A move becomes visible to the opponent before both players have committed | High | High | interview Q1; PRD Guardrail ("never see the opponent's choice before both have committed"); `realtime-match-scaffold` review F1 + F3, both critical; hot-spot dir `src/durable/` (4 commits/30d, lowest stated confidence) |
| 3 | A reconnect, refresh, or mid-session deploy desyncs a match or strands a player mid-round | High | High | interview Q1 ("desynchronization"); PRD Guardrail (state survives dropped connection or refresh); `infrastructure.md` risk register (deploys drop live WebSockets); roadmap S-03 risk |
| 4 | A migration behaves differently against the real database than intended — and no environment exists where finding out is safe | High | Medium | interview Q2 (the remembered burn); hot-spot dir `supabase/migrations/` (13 commits/30d); no local stack and no staging, `db push --linked` targets production |
| 5 | A tournament reaches a state it cannot leave, and the session stalls with players waiting | High | High | `tournament-data-model` review F1; `realtime-match-scaffold` review F2; `generate-round-robin-pairing` review F1; interview Q1 |
| 6 | An operation reports success while the write was refused, or reports emptiness that is really a failure | Medium | Medium | `create-and-join-tournament` review F5 + F7; `generate-round-robin-pairing` review F4; hot-spot dir `src/pages/api/tournaments/` (7 commits/30d) |

Deliberate abuse and attack scenarios are excluded by decision — see §7. Accidental disclosure
(Risk #2) remains in scope: a reconnect that leaks a move is the same defect whether or not
anyone intended it.

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|---|---|---|---|---|---|
| #1 | A known move sequence produces exactly the score and behavioral classification the PRD's definitions demand | That a statistic "looks reasonable" — reasonable and correct diverge silently, and no player will notice | **Resolved 2026-08-03:** the oracle context is now specified in the PRD (Business Logic → *Scoring specification*) rather than outstanding. What remains open for research: **where round-by-round move history is persisted — currently nowhere**, which blocks S-04 entirely | unit + property-based on pure functions | **The oracle problem.** An expected value lifted from the statistics implementation makes the test tautological: it green-lights current behavior including current bugs, and can never fail for the right reason. The oracle must be derived from the PRD definition independently |
| #2 | With one player committed and one not, the uncommitted player's channel has received nothing that encodes the other's move | That the UI not showing it means it was not sent — the wire payload is what matters, not the render | Room storage shape; what is broadcast on reconnect versus first connect; when the wipe fires relative to the broadcast | integration inside the Workers runtime | Asserting on rendered output instead of the payload; testing only the both-committed path |
| #3 | A player who drops mid-round and returns resumes the same round with the same commitments, and cannot replay a round already decided | That reconnect "works" because the page loads — the question is which state it loads into | Hibernation semantics; what survives eviction; how a round is marked terminal; what a second connection with the same identity is allowed to do | integration inside the Workers runtime, using eviction helpers | Happy-path-only reconnect; testing the disconnect without testing the return |
| #4 | Migrations apply cleanly to an empty database *and* the resulting policies permit and refuse exactly what was intended | That applying cleanly means behaving correctly — RLS and grant mistakes fail at query time, not migration time | Which policies exist per table; which helpers are `SECURITY DEFINER` and in which schema; who may read what; which functions are the only write path | integration against a real Postgres | Asserting the migration ran rather than what it produced; testing only the permitted case and never the refused one |
| #5 | Every state the machine can enter has a documented route out, and idempotent operations stay idempotent under retry | That a state is unreachable "by design" — three separate reviews found reachable dead ends | The full status vocabulary for tournaments, matches and rooms, and which component owns each transition | unit on transitions + integration on the definer functions | Testing only forward transitions; assuming a retry is safe without exercising it |
| #6 | A refused write surfaces to the caller as a failure, and an empty result is distinguishable from a failed one | That a 2xx means success — this exact defect shipped twice already | How each route maps a database error to a response; which errors are swallowed; what the client does with each shape | integration on the API routes | Asserting status codes without exercising the refused-write branch |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder via `/10x-new`.
Status moves left-to-right through the values below; the orchestrator updates Status as
artifacts appear on disk.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|---|---|---|---|---|---|
| 1 | Runner bootstrap and derived-output correctness | Prove scores and statistics are right against oracles derived from the PRD, not from the code | #1, #5 | unit, property-based | complete | `context/changes/testing-derived-output-correctness/` |
| 2 | Database-boundary integration | Prove migrations and RLS produce the access behavior intended, and that the SQL pairing matches the oracle | #4, #6, pairing correctness | integration | not started | — |
| 3 | Hidden-move protocol | Prove the reveal invariant holds across commit, reconnect and replay | #2, #3, #5 | integration in Workers runtime | not started | — |
| 4 | Quality-gate wiring | Make the suite a merge gate rather than something to remember to run | cross-cutting | gates | not started | — |

**Ordering rationale.** Phase 1 is first because no runner exists and because it must land
**before S-04 is implemented** — statistics written before their tests will supply the oracle to
their own tests, which is the failure mode Risk #1 exists to prevent. Phase 2 closes the "no
safe place to be wrong" gap before S-03 and S-04 add more schema. Phase 3 carries the highest
risk and the lowest stated confidence, and depends on Phase 1's runner. Phase 4 locks the floor
once there is a floor.

**Correction, 2026-08-03 (from Phase 1's research).** Phase 1 originally claimed pairing
correctness as a `unit, property-based` target. Research disproved that: the round-robin
algorithm is 100% SQL-resident inside `start_tournament()` and cannot be reached from an
in-process test at all. Pairing correctness moves to **Phase 2**, which can run rosters through
Postgres. Phase 1 delivered what Phase 2 will judge it against — `src/lib/pairing-oracle.ts`,
an independent reference implementation with the round-robin invariants property-tested and
swept exhaustively over every roster size from 2 to 50.

## 4. Stack

The classic test base for this project. Tools carry a `checked:` date so future readers can see
which lines need re-verification.

| Layer | Tool | Version | Notes |
|---|---|---|---|
| unit + property-based | Vitest | ^4.1.0 | none yet — see §3 Phase 1. Shares the project's existing Vite pipeline; Astro's own recommendation |
| property-based generation | fast-check | latest | none yet — see §3 Phase 1. For score invariants (zero-balance, order independence) that example-based tests state poorly |
| Workers-runtime integration | `@cloudflare/vitest-pool-workers` | ^0.16.20 | none yet — see §3 Phase 3. Runs tests inside workerd via Miniflare, fully local; `cloudflare:test` exports `runInDurableObject`, `runDurableObjectAlarm`, and `evictDurableObject(stub, { webSockets: "close" })` for eviction/reconnect. checked: 2026-08-01 |
| database integration | Supabase CLI local stack | 2.110.0 | none yet — see §3 Phase 2. **Requires Docker, which is not currently installed** — Phase 2 must resolve this or choose a disposable remote branch instead |
| e2e | none | — | Deliberately absent — see §7 |
| accessibility | none | — | Out of scope for MVP |
| AI-native | none | — | Deliberately absent — see §7 |

**Stack grounding tools (current session):**

- Docs: Cloudflare docs MCP — verified the Workers Vitest integration, the `cloudflare:test`
  Durable Object helpers, and the June 2026 eviction helpers; checked: 2026-08-01
- Search: WebSearch / WebFetch available; Exa.ai and Context7 not available in current session;
  checked: 2026-08-01
- Runtime/browser: Playwright MCP **not available in current session** — an e2e layer would need
  Playwright as an ordinary dev dependency, which is part of why §7 excludes it; checked: 2026-08-01
- Provider/platform: Cloudflare API MCP available (deployment and log inspection could support a
  future gate); Supabase has no MCP here, only the CLI; checked: 2026-08-01

## 5. Quality Gates

The full set of gates that must pass before a change reaches production. "Required after §3
Phase N" means the gate is enforced once that rollout phase lands; before that, it is planned.

| Gate | Where | Required? | Catches |
|---|---|---|---|
| lint + typecheck | local + CI | required (wired) | syntactic and type drift |
| build | local + CI | required (wired) | build-time breakage |
| unit + property-based | local + CI | **required (wired)** | wrong scores, wrong statistics, schema-boundary drift, DB↔TS constant drift |
| database integration | CI | required after §3 Phase 2 | policy and migration regressions |
| Workers-runtime integration | local + CI | required after §3 Phase 3 | move leakage, desync, replayable rounds |
| suite as merge gate | CI on push to `master` | required after §3 Phase 4 | anything the suite covers, enforced rather than remembered |
| manual pre-camp smoke | before 2026-08-19 | required | environment-specific failures no local test sees |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the relevant rollout
phase ships; before that, the sub-section reads "TBD".

### 6.1 Adding a unit test for a derived value (score, statistic, pairing)

- **Location**: `src/lib/<module>.test.ts`, a sibling of the module it covers.
- **Naming**: match the module exactly — `tournament.ts` → `tournament.test.ts`.
- **Run locally**: `npm run test` (or `npm run test:watch` while iterating).
- **Reference test**: `src/lib/scoring.test.ts`.
- **Imports**: explicit `import { describe, expect, it } from "vitest"` — globals are off by
  design, because enabling them would require a `types` array in `tsconfig.json` that turns off
  the implicit "all `@types` packages" behaviour React and Node rely on.

**The rule that matters here, and the reason this entry exists:**

> An expected value must be derived from the PRD specification. It must never be lifted from
> the implementation under test, or produced by running that implementation and recording what
> came out.

A test whose expectation came from the code under test is tautological — it green-lights
whatever that code currently does, bugs included, and can never fail for the right reason. This
is the single most dangerous failure mode for tests written quickly, because such a test looks
identical to a good one and reports the same green.

The worked example is `src/lib/scoring.test.ts`: every expected value was derived by hand from
the PRD's Business Logic → *Scoring specification* before `src/lib/scoring.ts` existed at all.
Its header states this and instructs future readers that a failure means the implementation is
wrong unless the PRD says otherwise.

Practically: if you cannot state where an expected value comes from other than "that's what it
returns," you do not yet have a test. Find the requirement, or write one.

For a derived value whose reference implementation lives somewhere unreachable — pairing, which
is SQL-resident — the pattern is a separate oracle module written from the algorithm's
definition, not transcribed from the original. See `src/lib/pairing-oracle.ts`, and note its
header is explicit about what that independence does and does not buy.

### 6.2 Adding a property-based test for an invariant

- **Tool**: fast-check, `import fc from "fast-check"`.
- **Location and naming**: same as §6.1 — property tests live beside example tests in the same
  file, usually in their own `describe`.
- **Reference test**: `src/lib/pairing-oracle.test.ts`; a smaller one in
  `src/lib/tournament.test.ts` covers `generateJoinCode`.

**When a property is the right tool.** When the claim quantifies over a range that examples
cannot cover, or when the function is non-deterministic so that any single sample proves nothing
about the next. `generateJoinCode` is the clearest case: it is random, so only a run over many
samples can argue that *every* output satisfies the database constraint.

**State the invariant, not the output.** "Every unordered pair appears exactly once" and "no
player appears twice within one round" are properties. "The schedule for four players is
1-2, 3-4, …" is an example — write those too, but they are not properties.

**Prefer enumeration when the input space is small.** fast-check samples; with roster sizes
2–50 it draws ~100 values from a 49-value space, so full coverage is likely but not certain. If
a success criterion says "exercises n=2 through n=50," sampling makes that a claim about
probability. `pairing-oracle.test.ts` therefore carries both: sampled properties *and* an
exhaustive sweep, one named case per roster size.

**Bound the cost.** The property tests over 50-player rosters are the slowest thing in the
suite (~2s of a ~4s run) because n=50 generates 1225 pairs per case. If it grows, reduce
`numRuns` on the largest-roster property rather than shrinking the range — the upper bound is
exactly where manual testing never goes.

### 6.3 Writing a specification before its implementation exists

- **Mechanism**: `it.todo("<full expected value in the title>")`, with the intended module
  surface documented in the file header.
- **Reference**: `src/lib/scoring.test.ts` (S-04's oracle) and `src/lib/state-machine.test.ts`
  (the D1–D4 dead ends).
- **Run locally**: `npm run test` — the summary line reports e.g. `188 passed | 42 todo`.

Use `todo`, never `skip`. Vitest reports todo as *not yet implemented* and surfaces the count in
every run as a standing reminder; skip reads as *temporarily disabled*, which is a different and
inaccurate claim. The suite stays green either way, so a quality gate can be enforced now while
the expectations wait.

Each todo title must be self-contained: the expected value or invariant, the slice that owns
turning it on, and a reference to where the reasoning lives. Whoever turns it on should not have
to re-derive anything.

Where a file consists mostly of todos, add a few **live** tests that guard the fixtures or table
they depend on — otherwise nothing detects an edit that quietly invalidates every pending
expectation. Both reference files do this.

### 6.4 Adding a test for an RLS policy or a definer function

TBD — see §3 Phase 2. Will carry the pattern for asserting both the permitted and the refused
case, since a policy that permits too much passes any permit-only test.

### 6.5 Adding a test for an API route

TBD — see §3 Phase 2. Will carry the pattern for distinguishing a refused write from an empty
result.

### 6.6 Adding a test for the hidden-move protocol

TBD — see §3 Phase 3. Will carry the pattern for asserting on wire payloads rather than
rendered output, and for driving eviction and reconnect.

### 6.7 Per-rollout-phase notes

(Filled in by each phase's final sub-phase.)

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout interview. Future contributors should respect these unless
the underlying assumption changes.

- **Deliberate abuse and attack scenarios** — small trusted group at a single camp event, no
  adversarial users assumed. Re-evaluate if the app is ever opened to a public or unsupervised
  audience. (Source: interview Q5.) Note the boundary: *accidental* move disclosure stays in
  scope as Risk #2.
- **An AI-native test layer** — cannot be justified under cost × signal here. Three weeks of
  after-hours budget against a hard deadline, no browser MCP in this session, and every risk in
  §2 has a cheaper deterministic answer. Re-evaluate after the camp, or if a risk appears that
  no deterministic test can express. (Source: §1 principle 1.)
- **End-to-end browser tests** — the setup cost lands squarely in the weeks before the deadline,
  and Phase 3 covers the protocol-level behavior that would motivate them. Re-evaluate after
  2026-08-19. (Source: interview Q5, §4 grounding note.)
- **UI copy, styling and layout** — verified by eye. (Source: interview Q5.)
- **Supabase's own auth flows** — vendor-owned surface; the project calls it, does not implement
  it. Re-evaluate if custom auth logic is added. (Source: interview Q5.)

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-08-03 (§3 pairing correction, §5 unit gate wired, §2 Risk #1 context resolved)
- Stack versions last verified: 2026-08-03 (Vitest 4.1.10 and fast-check 4.9 installed and running)
- AI-native tool references last verified: 2026-08-01 (none adopted)

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
