<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Tournament Data Model

- **Plan**: context/changes/tournament-data-model/plan.md
- **Scope**: Phases 1–4 of 4 (full plan) + post-plan commit 3017011
- **Date**: 2026-07-29
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 5 warnings, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## What is clean

Verified and holding, so it does not reappear as findings:

- **Contract conformance**: every item in the Phase 1–4 contracts is implemented as written. No MISSING items. All seven "What We're NOT Doing" guardrails hold.
- **RLS confidentiality core**: no traced path lets an authenticated user read or mutate another tournament's rows. `anon` gets zero rows everywhere.
- **`search_path = ''` hygiene**: both SECURITY DEFINER functions set it and schema-qualify every relation.
- **No policy recursion (42P17)**: all membership checks route through the definer helper; the one policy querying another table cannot loop back.
- **Capacity race**: `select … for update` before the count is genuinely race-free under Read Committed.
- **Grants minimal**: `private` is absent from `config.toml`'s exposed `schemas`, so the helper is not RPC-reachable; `join_tournament` is revoked from `public, anon`.
- **Column GRANT works**: Postgres checks UPDATE privilege per column, so the creator cannot rewrite `join_code` or `rounds_per_match`.
- **Success criteria**: all automated checks pass; committed `database.types.ts` is byte-identical to a fresh generation.

## Findings

### F1 — Tournament status can never legitimately reach 'finished', and lobby→finished bricks the row

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: supabase/migrations/20260729174939_tournament_rls.sql:98-115
- **Detail**: The only UPDATE policy on `tournaments` requires `status = 'lobby'` in `USING`, so `started → finished` is denied for every authenticated user — the terminal state in `tournament_status` is unreachable through the policy layer, though the PRD requires a concluded tournament with statistics. Separately, `WITH CHECK` constrains only `creator_id`, so a creator may set `lobby → finished` directly; the resulting row then satisfies no `USING` clause on either the UPDATE or DELETE policy, leaving it permanently unmodifiable, undeletable, unjoinable (`join_tournament` raises `tournament_already_started`) and unleavable (the member DELETE policy also requires lobby). The plan specified the `USING` clause as written and reasoned only about start idempotency, so this is a plan defect carried faithfully into code, not implementation drift.
- **Fix A ⭐ Recommended**: Tighten `WITH CHECK` to `creator_id = (select auth.uid()) and status = 'started'`, and route finishing through a SECURITY DEFINER `finish_tournament(uuid)` in a later slice.
  - Strength: Permits exactly the one transition this policy exists for and closes the bricking path; the definer-function precedent is already established by `join_tournament`, and S-04 needs server-side computation for statistics anyway.
  - Tradeoff: Finishing becomes a function S-04 must write rather than a policy that already works.
  - Confidence: HIGH — the transition set is small and fully enumerated by the enum.
  - Blind spot: Have not confirmed with S-04's design whether finishing is creator-triggered or automatic on last-match completion.
- **Fix B**: Widen `USING` to `creator_id = uid AND status <> 'finished'` and add a transition CHECK.
  - Strength: Keeps the whole lifecycle in the policy layer with no new function.
  - Tradeoff: Loses the start-idempotency property the plan explicitly wanted, and a row-level policy cannot express legal transitions without a trigger.
  - Confidence: MEDIUM — needs a trigger to be safe, which is more machinery than Fix A.
  - Blind spot: Interaction with the column GRANT if further columns become updatable later.
- **Decision**: FIXED via Fix A — `20260729192557_tighten_tournament_update_policy.sql`. `WITH CHECK` now requires `status = 'started'`; `'finished'` is deliberately left to a future SECURITY DEFINER function.

### F2 — join_tournament rejects an existing member of a full tournament, breaking its stated idempotency

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260729190621_join_tournament_error_codes.sql:51-63
- **Detail**: The order is count → `if v_player_count >= 50 then raise 'tournament_full'` → `insert … on conflict do nothing`. An existing member never reaches the idempotent insert once the tournament is full, so a reconnect, back-navigation, or retry returns `tournament_full` to someone already in the tournament. The nastiest case is the boundary: player #50's insert commits but the response is lost to a network drop; the client retries and is told the tournament is full. The plan promised "`ON CONFLICT DO NOTHING` so a repeat join is idempotent" (plan.md:199), and the comment on line 60 restates it — both are false in this case.
- **Fix**: Short-circuit before the capacity check with `if exists (select 1 from public.tournament_players where tournament_id = v_tournament.id and user_id = v_user_id) then return v_tournament.id; end if;`
  - Strength: Restores the contract exactly, and also makes a member re-entering a started tournament succeed rather than getting `tournament_already_started` — the right reconnect behaviour.
  - Tradeoff: One extra index probe per join, served by the composite primary key.
  - Confidence: HIGH — the membership row is uniquely keyed and the row lock is already held.
  - Blind spot: None significant.
- **Decision**: FIXED — `20260729192744_join_tournament_membership_shortcircuit.sql`. Membership is resolved before the lobby and capacity gates, so an existing member gets the tournament id back regardless of state.

### F3 — Player-cap comment points at a superseded migration

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/tournament.ts:12-14
- **Detail**: The `MAX_PLAYERS_PER_TOURNAMENT` doc comment names `20260729174939_tournament_rls.sql` as holding the authoritative `50` literal. That function body was replaced wholesale by `20260729190621_join_tournament_error_codes.sql:55`. The follow-up migration also dropped the reciprocal "matches MAX_PLAYERS_PER_TOURNAMENT" comment, so the live definition has no back-pointer at all. Someone raising the cap would edit a dead function body, see constant and migration agree, and ship a UI that shows "37/100" while the RPC returns `tournament_full` — precisely the drift the comment exists to prevent.
- **Fix**: Repoint the comment to `20260729190621_join_tournament_error_codes.sql` and restore the back-pointer comment beside the `50` literal there.
- **Decision**: FIXED — comment now points at `20260729192744` (the live definition after F2's fix) and explains that the live body is always the most recent replacing migration; the reciprocal back-pointer is restored beside the `50` literal.

### F4 — No .prettierignore, so `npm run format` defeats the ESLint ignore's stated purpose

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: eslint.config.js:73-76
- **Detail**: The ignore's rationale is that the generated file stays verbatim "so regeneration produces no diff churn." But `package.json:13` runs `prettier --write .`, there is no `.prettierignore`, and Prettier 3 does not read `.gitignore` — so one `npm run format` reformats the file and reintroduces exactly the churn. `lint-staged` happens not to hit it (prettier is bound only to `*.{json,css,md}` there), so the hole is manual-format only, but the stated premise is one command away from being false.
- **Fix**: Add a `.prettierignore` containing `src/db/database.types.ts`.
- **Decision**: FIXED — `.prettierignore` added. Verified effective: `prettier --check --ignore-path /dev/null` flags the file, `prettier --check` with the ignore passes.

### F5 — join_code has no entropy or format constraint at any layer

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260729164628_tournament_tables.sql:31,34
- **Detail**: `join_code text not null` with only a UNIQUE constraint — no DEFAULT, no length/charset CHECK, no generator. The INSERT policy constrains only `creator_id` and `status`, so the client picks the code, and the database accepts `'game1'` or `''`. That code is the sole authorization token for entry: `join_tournament` resolves it with RLS bypassed and no other check, over an unrate-limited RPC where each miss is one unique-index probe. A successful guess grants permanent membership — the member DELETE policy permits only self-removal in lobby, and no creator-kick path exists. The plan deferred code generation to application code, so this is a deliberate deferral rather than drift, but nothing in the repo records the requirement.
- **Fix A ⭐ Recommended**: Add `check (join_code ~ '^[A-Z0-9]{8,}$')` now and generate the code server-side in S-01.
  - Strength: Additive, cheap, and cannot drift from a TypeScript constant; forecloses the weak-code case at the layer that is always enforced.
  - Tradeoff: Pins a code format before S-01 has designed the share flow.
  - Confidence: MEDIUM — the format is a guess at what S-01 wants, though the length floor is the load-bearing part.
  - Blind spot: Have not checked whether the PRD wants human-readable/pronounceable codes, which would change the charset.
- **Fix B**: Leave the schema alone; record the constraint as an S-01 requirement in the change notes.
  - Strength: Respects the plan's explicit deferral and keeps S-01's design space open.
  - Tradeoff: The invariant lives only in prose until S-01 writes it, and the database keeps accepting `''`.
  - Confidence: HIGH — matches how the plan handled `rounds_per_match`.
  - Blind spot: Depends on S-01 actually reading the note.
- **Decision**: FIXED via Fix A — `20260729193142`: `check (join_code ~ '^[A-Z0-9]{8,}$')`, mirrored by `JOIN_CODE_PATTERN` in `src/lib/tournament.ts`. The rate-limit and creator-kick gaps are recorded in `change.md` as S-01 scope.

### F6 — matches.player_a_id and player_b_id are unindexed foreign keys

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260729164628_tournament_tables.sql:67-68
- **Detail**: Every other FK in the change is indexed; these two were missed, and Postgres does not auto-index the referencing side. Deleting one `auth.users` row sequentially scans `public.matches` twice while holding locks inside the auth deletion transaction. The same missing index will hit the "matches I am playing" query S-02/S-03 will run constantly. The plan did not require them.
- **Fix**: Add `matches_player_a_id_idx` and `matches_player_b_id_idx` in the migration that first writes to `matches`.
- **Decision**: FIXED — both indexes added in `20260729193142`.

### F7 — match_status enum pre-commits vocabulary the plan deferred to S-02

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: supabase/migrations/20260729164628_tournament_tables.sql:21,69
- **Detail**: The plan named `matches.status` without a type — a plan defect that required a decision. Typing it was right; bare `text` would have been worse. But the specific values `pending | in_progress | finished` and the `'pending'` default are invented, and the plan explicitly defers match semantics to S-02 ("S-02 will decide how pairing writes rows", plan.md:183). A Postgres enum is the hardest artifact here to walk back: values can be added but not removed or reordered without recreating the type and rewriting the column. Blast radius is nil today — zero rows, zero writers.
- **Fix**: Accept as-is and flag in S-02's change notes that the enum is provisional and cheap to redefine while `matches` is empty.
- **Decision**: FIXED — `20260729193532_match_status_text_check.sql` converts the column to `text` with `matches_status_check` holding the same three values and drops `public.match_status`. Same validation, revised by a constraint swap instead of a type recreation. `tournament_status` is untouched — that vocabulary is settled. Types regenerated.

### F8 — Plan and change.md not updated for the post-plan third migration

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: context/changes/tournament-data-model/plan.md:19,199,248
- **Detail**: Commit `3017011` landed after the plan was closed out. `plan.md:19` still says `supabase/migrations/` holds "the two migration files"; there are three. `plan.md:199` still describes `join_tournament` raising "distinct errors" with no mention of the `DETAIL` token contract, and `plan.md:248` still describes `src/lib/tournament.ts` as four constants. `## Progress` is fully checked with no row covering the work, and `change.md` Notes is empty — no deviation is recorded anywhere in the change folder.
- **Fix**: Add a short addendum section to plan.md (not the Progress block) and a Notes entry in change.md recording the three deviations and the follow-up migration.
- **Decision**: FIXED — `## Addendum` added to plan.md (deviations, follow-up migration table, constraints carried forward); `change.md` Notes now records per-slice ownership for S-01/S-02/S-04. Progress block left untouched as the historical record.

### F9 — AGENTS.md not updated for src/db/ or the regeneration step

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: AGENTS.md:16
- **Detail**: The Project Structure line names `src/types.ts` as the home for shared entities/DTOs — that file does not exist. The change introduced `src/db/database.types.ts` with no mention in AGENTS.md, no note that `npx supabase gen types typescript --linked --schema public` must be re-run after each migration, and no mention of the `private` schema convention for RLS helpers. AGENTS.md is the agent onboarding contract; an agent following it looks for DB types in a path that does not exist.
- **Fix**: Update the Project Structure line and add the regeneration command to the commands section.
- **Decision**: FIXED — Project Structure now names `src/db/database.types.ts` instead of the non-existent `src/types.ts`; two new hard rules cover the `private`-schema/`search_path` convention for RLS helpers and the `WITH CHECK` trap from F1, plus the regeneration command.

### F10 — Cascade on the matches player FKs lets one account deletion rewrite finished history

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260729164628_tournament_tables.sql:67-68
- **Detail**: The plan specified `on delete cascade` for `creator_id` and the `tournament_players` FKs, so those are planned. It said only "referencing `auth.users`" for the two `matches` player columns; cascade was chosen unstated. A participant deleting their account therefore silently removes their `matches` rows from a *finished* tournament, so the remaining players' standings change retroactively — `status = 'finished'` confers no immutability. Nothing is at risk today (no rows, no scoring), but S-03/S-04 inherit the choice.
- **Fix**: Decide the retention story before S-04 computes statistics — `on delete restrict`, or a tombstoned/anonymised player, rather than silent deletion.
- **Decision**: DEFERRED to S-04 — recorded in `change.md` Notes and the plan addendum. Cascade stays for now; the retention decision belongs with the slice that computes standings.
