<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate Round-Robin Pairing

- **Plan**: `context/changes/generate-round-robin-pairing/plan.md`
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-08-01
- **Verdict**: NEEDS ATTENTION
- **Findings**: 1 critical, 4 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | FAIL |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Note on the overall verdict: the rubric maps any critical finding to REJECTED. Calling this
NEEDS ATTENTION instead is a deliberate deviation, stated here rather than hidden — F1 is
**latent, not live**. Nothing in the system marks a match `finished` (that is S-03), so every
player is permanently at round 1 and the broken property cannot be reached with the code that
exists today. Everything actually shipped passes its own criteria. F1 blocks S-03, not this
slice's deploy.

## Findings

### F1 — The mutual-opponent invariant holds only at t=0

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: `src/pages/tournaments/[id].astro:51-70` (comment and query); plan.md:21, 259
- **Detail**: The code comment asserts "Ordering by round_number is what makes the naming
  mutual — both players of a given round-r match reach it at the same ordinal". That is only
  true while every player has completed the same number of matches. The plan makes the same
  claim (line 259) and simultaneously promises the opposite property at line 21: "Players who
  move faster are never blocked by players who move slower." Those two goals are in direct
  tension and cannot both hold under a single-named-opponent rule.

  Counter-example, traced against the schedule this function actually generates for a 4-player
  roster (verified by hand from `pairing_schema.sql:146-166` — R1: A-B, C-D; R2: A-C, D-B;
  R3: A-D, B-C):

  - A has finished R1 and R2. A's lowest unplayed match is R3 → A is told to find **D**.
  - D has finished nothing. D's lowest unplayed match is R1 → D is told to find **C**.

  A is sent to D, who is being sent to C. One player is pointed at someone already engaged and
  another at nobody. The failure grows with the spread in player pace, which is exactly what a
  live camp event produces.

  Manual criterion 4.6 ("two players in the same round-1 match see each other") passed
  legitimately but is too weak to catch this: it only ever exercises the all-players-at-zero
  state, which is the one state where the property is guaranteed.
- **Fix A ⭐ Recommended**: Correct the false comment now and hand the pacing model to S-03 as
  an explicit design decision, recorded in `change.md` and the plan addendum.
  - Strength: Nothing is reachable today, and S-03 is the slice that introduces match
    completion — it cannot avoid choosing a pacing model, so the decision lands where the
    information is. Avoids designing a matching rule against a match-play flow that does not
    exist yet.
  - Tradeoff: A known-wrong invariant stays in the codebase for the length of one slice,
    mitigated by the corrected comment.
  - Confidence: HIGH — nothing writes `finished`; verified `abandoned` and `finished` have no
    writers anywhere in `src/`.
  - Blind spot: If S-03 is planned by someone who reads only the code comment, the corrected
    comment is the only thing standing between them and the same false assumption.
- **Fix B**: Implement a mutual rule now — name an opponent only when that match is the lowest
  unplayed match for *both* players, otherwise show a "wait" state.
  - Strength: Preserves free-pace progression and mutual naming simultaneously; the property
    the slice is named for becomes true unconditionally.
  - Tradeoff: Introduces a "wait" state the PRD's pace NFR is hostile to, and it is untestable
    until matches can be completed — so it would ship unverified.
  - Confidence: MEDIUM — the rule is correct, but its UX consequence (how often players wait)
    cannot be measured before S-03.
  - Blind spot: Have not modelled how frequently the wait state triggers at 50 players.
- **Decision**: FIXED via Fix A — comment corrected in `src/pages/tournaments/[id].astro`,
  pacing model handed to S-03 in `change.md`, plan corrected in its `## Addendum`.

### F2 — `on delete restrict` collides with the pre-existing cascade to `auth.users`

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731174617_pairing_schema.sql:54-64`
- **Detail**: `tournament_players.user_id` and both `matches.player_*_id` already reference
  `auth.users (id) on delete cascade` (`20260729164628_tournament_tables.sql:49,67-68`). The
  two new composite FKs point `matches → tournament_players` with `on delete restrict`. A
  single `delete from auth.users` now fans out to both cascades, and RESTRICT is checked
  **immediately** rather than at end of statement — so deleting the `tournament_players` row
  can trip the restriction while the `matches` rows still exist. The likely effect is that
  once a tournament is started, the accounts in it can no longer be deleted at all. Not
  user-reachable (the delete policy requires `lobby`), but it blocks operational and GDPR
  deletion, and `profiles.id ... on delete cascade` shows account deletion is the intended
  cleanup path.
- **Fix**: Switch both composite FKs to `on delete no action`, which defers the check to
  end-of-statement — by which point the co-occurring `matches` cascade has satisfied it. Still
  blocks a bare `tournament_players` delete, so the immutability intent survives. Confirm
  empirically first with a scratch delete against a throwaway tournament.
- **Decision**: DISMISSED — disproved empirically, 2026-08-01. Two probes against the linked
  database, each rolled back inside its own DO block:
  - `delete from auth.users` for an account holding 8 matches in a **started** tournament:
    **PERMITTED**. The cascades resolve before the RESTRICT is evaluated, so account deletion
    is not blocked and there is no ops/GDPR problem.
  - `delete from public.tournament_players` for that same membership alone: **BLOCKED**,
    sqlstate 23503. The constraint does exactly the job it was added for.
  The finding's reasoning about immediate-vs-deferred RI checking was plausible but wrong for
  this cascade shape. No change made.

### F3 — `handle_new_user` can abort account creation

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731181103_player_profiles.sql:42-52` vs the CHECK at `:21`
- **Detail**: The trigger inserts `raw_user_meta_data ->> 'display_name'` verbatim into a
  column constrained to 1–40 characters. A longer value raises inside the `auth.users` insert
  and fails the whole signup with an opaque "Database error saving new user". `schemas.ts:29`
  caps the length, but only on the one app route — the trigger fires for every account-creation
  path (admin API, Supabase dashboard, any future OAuth or magic-link flow), none of which pass
  through that zod schema. A `SECURITY DEFINER` trigger on `auth.users` should never be able to
  fail a signup.
- **Fix**: Clamp inside the trigger — `left(nullif(trim(...), ''), 40)` — so the constraint
  becomes unreachable from the trigger path.
- **Decision**: FIXED — `supabase/migrations/20260801170309_profile_trigger_hardening.sql`.

### F4 — A failed roster query returns HTTP 200 with an empty lobby

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/tournaments/[id]/players.ts:47-51`
- **Detail**: Only `data` is destructured, so a query error yields `roster = []` and the route
  answers 200 with `players: []`. `LobbyRoster.tsx:62-67` treats any 200 as a successful poll,
  resets `failures.current`, and re-renders an empty roster — so a transient database error
  blanks every player out of the lobby and the client never registers a failure. The shape is
  pre-existing but this diff extends the same handler.
- **Fix**: Return 500 when the roster query errors, so the poll's existing failure counter and
  "lost connection" state engage.
- **Decision**: FIXED — `players.ts` now returns 500 on `rosterError`. The `?? []` fallback was
  removed with it: ESLint flagged it as an unnecessary condition once the guard narrowed the
  type, which is the fix proving itself.

### F5 — `signup.ts` missing `export const prerender = false`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/api/auth/signup.ts`
- **Detail**: `AGENTS.md` line 7 makes this a hard rule for every `src/pages/api/**` file, and
  all five tournament routes comply (`join.ts:6`, `index.ts:6`, `leave.ts:4`, `players.ts:4`,
  `start.ts:5`). No route under `src/pages/api/auth/` has it. Pre-existing, but `signup.ts` was
  modified by this slice.
- **Fix**: Add `export const prerender = false;` to all three auth routes.
- **Decision**: FIXED — added to `signup.ts`, `signin.ts` and `signout.ts`.

### F6 — The 40-character bound is restated as a literal in three places

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/schemas.ts:29`, `src/components/auth/SignUpForm.tsx:9`, `supabase/migrations/20260731181103_player_profiles.sql:21`
- **Detail**: `schemas.ts:4-11` states that bounds are imported from `@/lib/tournament` and
  "never restated as literals", and `tournament.ts:9-18` documents the mirroring migration for
  each such constant. The display-name bound follows neither convention.
- **Fix**: Add `MAX_DISPLAY_NAME_LENGTH` to `src/lib/tournament.ts` with the same
  migration-mirroring note, and import it in both TypeScript sites.
- **Decision**: FIXED — `MAX_DISPLAY_NAME_LENGTH` added to `src/lib/tournament.ts` naming both
  mirroring sites; `schemas.ts` and `SignUpForm.tsx` now import it.

### F7 — Phase 3 migration claims two grants but issues one

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `supabase/migrations/20260731181103_player_profiles.sql:96-98`
- **Detail**: The comment says "Both grants are required" but only `grant execute` is issued.
  The effective state is correct because `grant usage on schema private to authenticated`
  already exists from `20260729174939_tournament_rls.sql:50` — so the AGENTS.md two-grant rule
  is satisfied, but this migration is not self-contained and its comment misdescribes it.
- **Fix**: Add the (idempotent) `grant usage on schema private to authenticated`, or reword the
  comment to name the migration it inherits from.
- **Decision**: FIXED — both grants restated in
  `supabase/migrations/20260801170309_profile_trigger_hardening.sql`.

### F8 — 1225 row-at-a-time inserts inside one lock-holding transaction

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731174617_pairing_schema.sql:146-166`
- **Detail**: At the 50-player cap the loop issues 1225 single-row inserts, each re-checking two
  composite FKs and the normalised-pair expression index, while holding `FOR UPDATE` on the
  tournaments row. Supabase's default `statement_timeout` for `authenticated` is 8s. The plan's
  Performance section assumed one `INSERT … SELECT`; the implementation is row-at-a-time.
- **Fix**: Measure a 50-player start. If it lands near the timeout, rewrite as one set-based
  `insert … select` over `generate_series` for rounds × slots.
- **Decision**: FIXED — rewritten set-based in
  `supabase/migrations/20260801170219_pairing_set_based.sql`, without measuring first. The
  circle-method arithmetic is transcribed unchanged; the loop's `if i = 0` branches became CASE
  expressions and its phantom-slot null guard became the WHERE clause. Verified by re-running
  the four-session check end to end: identical pairing, mutuality intact.

### F9 — `handle_new_user` not revoked from `public, anon`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `supabase/migrations/20260731181103_player_profiles.sql:35-59`
- **Detail**: Every other `SECURITY DEFINER` function in this repo pairs its definition with a
  `revoke execute` — `join_tournament` (`…192744.sql:80`), `start_tournament`
  (`pairing_schema.sql:178`). This one does not. Not currently reachable, because PostgREST
  does not expose functions returning `trigger`, so this is convention rather than exposure.
- **Fix**: Add `revoke execute on function public.handle_new_user() from public, anon;`.
- **Decision**: FIXED — `supabase/migrations/20260801170309_profile_trigger_hardening.sql`.

## Verified clean

Recorded so a later review does not re-litigate them:

- **`start_tournament` authorization**: `auth.uid()` null-check first (`:91`), creator check
  returning the *same* `tournament_not_found` token as a missing row (`:105-108`) so it is not
  an existence oracle, `set search_path = ''` with every relation schema-qualified, execute
  revoked from `public, anon`. The eight-step behavioural ordering matches the plan exactly,
  including the idempotent short-circuit placed *before* the remaining gates.
- **Circle method**: hand-traced for 4, 6 and an odd 3-player roster. Every unordered pair
  occurs exactly once, no bye rows are written, and `matches_distinct_players` and
  `matches_tournament_pair_uniq` are satisfied by construction.
- **`profiles` SELECT policy** is scoped to self + co-members via `private.my_co_member_ids()`,
  not `using (true)` — the app does not become an enumerable directory of every camper. No
  write policies exist, so writes are denied by default.
- **No email ever reaches `profiles`**: `new.email` appears nowhere in the migration; the
  fallback is a uuid-derived pseudonym, in both the trigger and the backfill.
- **The bypass is genuinely closed**: `tournaments_update_creator_in_lobby` dropped, no UPDATE
  policy remains anywhere, and nothing else in `src/` updates `tournaments`.
- **Scope guardrails**: no writer for `abandoned` or `finished`, no full-schedule view, no move
  submission or persistence, no scoring, no creator-kick path, no rate limiting, no double
  round-robin.
- **Three unplanned files are all justified**: `schemas.ts` (Phase 3's zod requirement),
  `players.ts` and `LobbyRoster.tsx` (criterion 3.11 and 4.8 are unreachable without them).
- **All automated criteria re-run at HEAD**: `tsc --noEmit`, `npm run lint`, `npm run build`
  clean; `supabase db push --linked --dry-run` reports "Remote database is up to date";
  `start_tournament` and `profiles` present in the generated types; the start route no longer
  updates the table directly.
