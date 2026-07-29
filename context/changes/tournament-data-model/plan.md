# Tournament Data Model Implementation Plan

## Overview

Establish the project's first database schema — tournaments, membership, and a structural `matches` table — together with the migration tooling and typed Supabase client that every later slice depends on. This is roadmap **F-01**, the foundation that unblocks S-01 (create/join tournament), S-02 (pairing), and F-02 (realtime match rooms).

## Current State Analysis

The database layer is entirely absent. `src/lib/supabase.ts:5` wires a working `createServerClient` from `@supabase/ssr`, and authentication is live in production against a real Supabase project — but there are no application tables, no migrations directory, no generated types, and no `Database` generic on the client.

Three findings constrain how this change can be executed:

- **The Supabase CLI binary is missing.** `node_modules/supabase/` contains only `LICENSE`, `README.md`, `package.json`, and `scripts/postinstall.js` — no `bin/`, no `node_modules/.bin/supabase` symlink. The local npm is 12.0.1, which blocks install scripts by default; `npm install-scripts ls` lists `supabase@2.98.2` among five blocked packages. The pinned 2.98.2 relies on a postinstall that downloads the binary from GitHub releases. **Versions ≥ 2.99.0 removed that postinstall entirely** — platform binaries now ship as optional dependencies (`@supabase/cli-linux-x64` et al.), so upgrading sidesteps the whole mechanism rather than adding a script-execution exception. The existing `^2.23.4` range already permits 2.110.0; only the lockfile pins the broken version.
- **Docker is not installed** (`which docker` → not found, no `/var/run/docker.sock`). This rules out `supabase start`, `supabase db reset`, and shadow-database `supabase db diff`. It does **not** block this change: `supabase migration new` requires nothing, and `supabase db push --linked` connects directly to the remote Postgres.
- **The project is not linked and the CLI is not logged in.** `supabase/` holds only `.gitignore` and `config.toml`; there is no `supabase/.temp/`. `config.toml:5` sets `project_id = "10x-astro-starter"`, which is the *local stack name* (defaulted from the directory at `supabase init`) — not a remote project ref, and not evidence of a link. The remote ref is `jkaszaakfgqlulunoxer`, known from the deployed app's `SUPABASE_URL`.

## Desired End State

The remote Supabase project carries three tables — `tournaments`, `tournament_players`, `matches` — with row-level security enabled and per-operation policies that let members read their own tournaments, let creators start them, and route every membership insert through a single `join_tournament(code)` function. `supabase/migrations/` holds the two migration files that produced that state, `src/db/database.types.ts` holds generated types, and `src/lib/supabase.ts` returns a `Database`-typed client.

Verify by: `npx supabase db push --linked --dry-run` reporting no pending migrations, `npx supabase gen types typescript --linked` succeeding, and `npm run build` passing with the typed client in place.

### Key Discoveries:

- **Row-level security cannot express "join by code."** A policy predicate is evaluated per candidate row against row data and session state — it cannot see the client's `WHERE` clause. There is no way to write "you may read this row if you supplied its code." A `USING (true)` policy plus a client-side filter is not equivalent; it permits enumerating every tournament. This is why joining is a database function, not a policy.
- **A visibility deadlock forces the same conclusion independently.** The natural insert policy on `tournament_players` — `WITH CHECK (EXISTS (SELECT 1 FROM tournaments WHERE id = tournament_id AND status = 'lobby'))` — fails, because row-level security applies to that subquery too and a non-member cannot yet see the tournament row.
- **Recursive-policy errors will occur twice here if not designed around.** Postgres raises `42P17 infinite recursion detected in policy for relation …` when a policy queries a table whose own policies query back. Both the cross-table cycle (`tournaments` ↔ `tournament_players`) and a self-referential one (the "see my co-members" policy on `tournament_players` querying `tournament_players`) will trigger it. The standard fix is a `SECURITY DEFINER` helper in a non-exposed schema; because its body runs as the owner, the table's policies are not re-applied.
- **`(select auth.uid())` remains the required form**, not bare `auth.uid()`. Supabase advisor lint `0003_auth_rls_initplan` still prescribes it; the wrapper lets the planner hoist the call into an InitPlan evaluated once per statement rather than once per row.
- **Row-level security cannot restrict which *columns* an update touches.** An update policy scoped to the creator would also permit rewriting `rounds_per_match` or `join_code`. Column-level `GRANT` composes with the policy and is what actually narrows it.
- **`search_path = ''` on a `SECURITY DEFINER` function is mandatory and has a sharp edge**: every relation must then be schema-qualified. Supabase installs pgcrypto into the `extensions` schema, so an unqualified `gen_random_bytes` call fails at runtime even though the extension is present. (Not needed here — code generation is in app code — but relevant to any future function.)
- **This project uses the new API key format** (`sb_publishable_…`), so a legacy `service_role` key may not exist. Nothing in this plan requires one.
- `src/env.d.ts` declares only `App.Locals.user`; in adapter v13 the merged `Runtime` type is just `{ cfContext: ExecutionContext }`. There is no `locals.runtime.env`.
- No API route in the codebase currently reads `context.locals` — `grep -rn "locals\." src/` matches only `src/middleware.ts:13,15,19`.

## What We're NOT Doing

- **No pairing logic.** The `matches` table is created with its constraints but nothing writes to it; S-02 owns round-robin generation and will define what a match actually means.
- **No move, round, score, or statistics storage.** S-03 and S-04 own those, and F-02 may keep in-progress round state in the match room's own storage rather than Postgres.
- **No UI.** S-01 builds the create and join screens. This change ships schema, tooling, and types only.
- **No database-level round-count constraint.** Bounds of 1–20 (default 10) are enforced in application code by explicit decision; the column accepts any integer.
- **No behavioural verification of the policies.** By explicit decision, confirming that policies restrict the right people is deferred to S-01's UI work. See "Open risk" below.
- **No CI automation of migrations.** Applying migrations stays a manual, local step. If automated later, the migration job must run *before* the deploy job, or a deployed build will query tables that do not yet exist.
- **No secret/admin API key.** Joining goes through a database function specifically so a second high-privilege credential is not introduced.

## Implementation Approach

Two migration files rather than one, split at the tables/policies boundary. The policy half is where the recursion trap lives and where failures surface at query time rather than at migration time; keeping it separate means a failed `db push` points at one half unambiguously.

Access control divides by operation. Reads and the status update run through the user's own session client with policies applied. Membership inserts have **no** policy at all — every join, including the creator's own, calls `join_tournament(code)`, which runs as its owner and enforces the lobby state and player cap atomically under a row lock. That single path is a direct consequence of the "creator joins explicitly" decision, and it removes an entire class of policy from the design.

## Critical Implementation Details

**Ordering within the policy migration.** The `private` schema and its helper functions must be created *before* any policy references them, and the `GRANT USAGE ON SCHEMA private` / `GRANT EXECUTE ON FUNCTION` statements must accompany them. Policy expressions execute with the privileges of the querying user, so `authenticated` needs both grants — omitting them produces a permission error at query time, not at migration time. Supabase's own examples omit these grants, which makes this an easy way to ship a broken migration.

**Helper functions must live outside the exposed schema.** Supabase's guidance is explicit that `SECURITY DEFINER` functions used inside policies must not sit in a schema exposed through the API. `private`, not `public`.

---

## Phase 1: Migration tooling & project link

### Overview

Get a working Supabase CLI and a link to the remote project. This phase contains the only step requiring credentials from the operator and produces no schema changes.

### Changes Required:

#### 1. Supabase CLI dependency

**File**: `package.json`, `package-lock.json`

**Intent**: Replace the pinned 2.98.2 — whose binary never downloaded because npm 12 blocks install scripts — with a version that has no install script at all, fixing the tooling permanently in both local and CI environments.

**Contract**: `devDependencies.supabase` resolves to ≥ 2.99.0 (currently 2.110.0). After install, `npx supabase --version` succeeds and `node_modules/.bin/supabase` exists. No `allowScripts` entry is added to `package.json`.

#### 2. Remote project link

**File**: `supabase/.temp/` (generated, already gitignored via `supabase/.gitignore`)

**Intent**: Authenticate the CLI and bind this working copy to the remote project so `db push` and `gen types` can reach it without Docker.

**Contract**: `npx supabase login` (browser flow or `--token`), then `npx supabase link --project-ref jkaszaakfgqlulunoxer`, which prompts for the database password. Neither the access token nor the database password is committed. `supabase/config.toml` is not modified — its `project_id` is the local stack name and is unrelated to the link.

### Success Criteria:

#### Automated Verification:

- CLI resolves locally: `npx supabase --version` prints a version ≥ 2.99.0
- No blocked install scripts remain for this package: `npm install-scripts ls` does not list `supabase`
- Lint and build still pass after the dependency bump: `npm run lint` and `npm run build`

#### Manual Verification:

- `npx supabase projects list` shows the linked project without prompting for credentials again
- `supabase/.temp/` exists locally and does not appear in `git status`

**Implementation Note**: The login and link steps are interactive and require the operator's Supabase account and database password. Pause here for manual confirmation before proceeding.

---

## Phase 2: Tables & constraints

### Overview

First migration: the tournament status type, three tables, their constraints, and the indexes that later policies will depend on. No row-level security yet.

### Changes Required:

#### 1. Schema migration

**File**: `supabase/migrations/<timestamp>_tournament_tables.sql` (created via `npx supabase migration new tournament_tables`)

**Intent**: Create the minimal tournament domain — a tournament with a fixed round count and a shareable join code, a membership junction, and a structural matches table that S-02 will later populate.

**Contract**:

- `public.tournament_status` enum: `lobby`, `started`, `finished`.
- `public.tournaments` — `id` uuid primary key defaulting to `gen_random_uuid()`; `creator_id` uuid not null referencing `auth.users(id)` on delete cascade; `rounds_per_match` int not null (**no CHECK constraint** — bounds live in application code by decision); `join_code` text not null with a **unique** constraint; `status` defaulting to `lobby`; `created_at` timestamptz defaulting to `now()`.
- `public.tournament_players` — composite primary key `(tournament_id, user_id)`, both foreign keys cascading on delete; `joined_at` timestamptz.
- `public.matches` — `id` uuid primary key; `tournament_id` referencing tournaments on delete cascade; `player_a_id` and `player_b_id` referencing `auth.users`; `status`; `created_at`. Two constraints carry PRD guardrails into the database: a CHECK that `player_a_id <> player_b_id` (no player paired against themselves), and a unique index on the *normalised* pair so that (A,B) and (B,A) cannot both exist within one tournament.

  The normalised-pair index is the one non-obvious piece — an ordinary `UNIQUE (tournament_id, player_a_id, player_b_id)` does not prevent the reversed duplicate:

  ```sql
  create unique index matches_tournament_pair_uniq
    on public.matches (
      tournament_id,
      least(player_a_id, player_b_id),
      greatest(player_a_id, player_b_id)
    );
  ```

- Indexes: `tournament_players (user_id)` — required by the membership helper in Phase 3 and *not* served by the composite primary key's prefix; `tournaments (creator_id)`; `matches (tournament_id)`. `tournaments.join_code` is covered by its unique constraint.

### Success Criteria:

#### Automated Verification:

- Migration is syntactically valid and lands cleanly: `npx supabase db push --linked`
- Re-running reports nothing pending: `npx supabase db push --linked --dry-run`
- Types can be generated from the new schema: `npx supabase gen types typescript --linked --schema public` exits 0 and its output contains `tournaments`, `tournament_players`, and `matches`

#### Manual Verification:

- All three tables are visible in the Supabase dashboard's table editor with the expected columns
- Inserting two rows with the same `join_code` is rejected by the unique constraint
- Inserting a match with identical `player_a_id` and `player_b_id` is rejected

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Access control

### Overview

Second migration: enable row-level security, create the helper schema that breaks policy recursion, add per-operation policies, and add the `join_tournament` function that owns every membership insert.

### Changes Required:

#### 1. Recursion-breaking helper schema

**File**: `supabase/migrations/<timestamp>_tournament_rls.sql` (created via `npx supabase migration new tournament_rls`)

**Intent**: Provide a way for policies to ask "which tournaments is the caller in?" without the query re-entering the policies of the table being read — the fix for both the cross-table and self-referential recursion cycles described in Key Discoveries.

**Contract**: A `private` schema (not exposed through the API) containing `private.my_tournament_ids()` returning `setof uuid`, declared `security definer stable set search_path = ''`, selecting the caller's tournament ids from `public.tournament_players` filtered on `(select auth.uid())`. Accompanied by `GRANT USAGE ON SCHEMA private TO authenticated` and `GRANT EXECUTE ON FUNCTION private.my_tournament_ids() TO authenticated` — both required, since policy expressions run with the querying user's privileges.

#### 2. Row-level security and policies

**File**: same migration

**Intent**: Enable row-level security on all three tables and express the access rules per operation, scoped to the `authenticated` role.

**Contract**: `ENABLE ROW LEVEL SECURITY` on all three tables. With security enabled and no matching policy, access is denied by default — `anon` therefore needs no explicit deny policy, and Postgres has no `DENY` primitive to write one with. Every policy targets `TO authenticated` and wraps auth calls as `(select auth.uid())`.

- `tournaments` SELECT — visible when `id IN (SELECT private.my_tournament_ids())` **OR** `creator_id = (select auth.uid())`. The creator clause matters: it keeps the tournament visible in the window between creating it and joining it, which under the "creator joins explicitly" decision is a real state. Expressed as one policy with `OR` rather than two policies, since multiple permissive policies for the same role and command are OR'd but each evaluated per row (advisor lint `0006`).
- `tournaments` INSERT — `WITH CHECK (creator_id = (select auth.uid()) AND status = 'lobby')`.
- `tournaments` UPDATE — `USING (creator_id = (select auth.uid()) AND status = 'lobby')`. The `status = 'lobby'` term in `USING` is what makes starting idempotent: once started, the row is invisible to the update path, so a second start affects zero rows.
- `tournaments` DELETE — creator, lobby only.
- `tournament_players` SELECT — `tournament_id IN (SELECT private.my_tournament_ids())`.
- `tournament_players` INSERT — **no policy.** Every membership insert goes through `join_tournament`, including the creator's own. Direct inserts are denied by default.
- `tournament_players` DELETE — a member may remove themselves while the tournament is still in lobby.
- `matches` SELECT — `tournament_id IN (SELECT private.my_tournament_ids())`. No INSERT/UPDATE/DELETE policies; S-02 will decide how pairing writes rows.

#### 3. Column-level grant for starting

**File**: same migration

**Intent**: Narrow the creator's update permission to the status column alone, since a row-level policy cannot restrict which columns an update touches.

**Contract**: `REVOKE UPDATE ON public.tournaments FROM authenticated`, then `GRANT UPDATE (status) ON public.tournaments TO authenticated`. The policy and the grant compose — both must pass.

#### 4. Join function

**File**: same migration

**Intent**: Own the entire join operation — resolve the code, verify the tournament is still in lobby and under the player cap, and insert the membership — atomically, since row-level security can express none of these and cannot make the capacity check race-free.

**Contract**: `public.join_tournament(p_join_code text) returns uuid`, declared `security definer set search_path = ''`. Resolves the tournament by code `FOR UPDATE` (the lock is what serialises the capacity check against simultaneous joiners), raises distinct errors for unknown code / already started / full, then inserts into `tournament_players` with `ON CONFLICT DO NOTHING` so a repeat join is idempotent, and returns the tournament id. The player cap is a literal in this function matching the application constant from Phase 4 — both must be updated together. `REVOKE EXECUTE … FROM public, anon` and `GRANT EXECUTE … TO authenticated`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db push --linked`
- No pending migrations remain: `npx supabase db push --linked --dry-run`
- Schema is still introspectable after the policy changes: `npx supabase gen types typescript --linked --schema public` exits 0

#### Manual Verification:

- The Supabase dashboard's Security Advisor reports no `rls_disabled_in_public` findings for the three new tables
- The dashboard's Authentication → Policies view lists the expected policies per table, and `tournament_players` shows no INSERT policy

**Implementation Note**: Dashboard SQL runs with admin privileges and bypasses row-level security, so it confirms the policies *exist* but proves little about whether they *restrict* anyone. That behavioural check is deliberately deferred to S-01. After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 4: Generated types & application constants

### Overview

Generate TypeScript types from the live schema, wire them into the Supabase client, and add the application-level constants that replace the database constraints we chose not to write.

### Changes Required:

#### 1. Generated database types

**File**: `src/db/database.types.ts` (new)

**Intent**: Give the client compile-time knowledge of the schema so table and column names are checked at build time.

**Contract**: Output of `npx supabase gen types typescript --linked --schema public`, committed to the repository. Nothing in `.gitignore` excludes it, and CI's `npm run build` would fail on a missing import if it were absent.

#### 2. Typed Supabase client

**File**: `src/lib/supabase.ts`

**Intent**: Apply the generated `Database` type to the existing client factory so every query from here on is typed.

**Contract**: `createServerClient<Database>(...)`. The exported `createClient(requestHeaders, cookies)` signature and its null-return behaviour when `SUPABASE_URL`/`SUPABASE_KEY` are unset (`src/lib/supabase.ts:6-8`) are unchanged — callers must continue to null-check.

#### 3. Tournament domain constants

**File**: `src/lib/tournament.ts` (new)

**Intent**: Hold the bounds and defaults that were deliberately left out of the database, in one place rather than inline at call sites.

**Contract**: Exported constants for maximum players per tournament (50, matching the literal inside `join_tournament`), minimum and maximum rounds per match (1 and 20), and the default round count (10). Placed in `src/lib/` per the existing convention — `src/lib/` currently holds `config-status.ts`, `supabase.ts`, and `utils.ts`.

### Success Criteria:

#### Automated Verification:

- Types generate without error: `npx supabase gen types typescript --linked --schema public > src/db/database.types.ts`
- Type checking passes with the typed client: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Autocomplete resolves table and column names when writing a query against the typed client
- The player cap constant matches the literal inside `join_tournament`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

No test runner is configured in this repository, and introducing one is out of scope. Verification is therefore migration-level and type-level.

### Automated (per phase):

- `npx supabase db push --linked --dry-run` — reports whether the local migration history matches the remote
- `npx supabase gen types typescript --linked` — non-zero exit means the schema is malformed or unreachable
- `npm run build` — catches type errors introduced by the `Database` generic
- `npm run lint`

### Manual Testing Steps:

1. Confirm all three tables exist in the dashboard with the expected columns and foreign keys
2. Attempt to insert two tournaments sharing a `join_code`; confirm rejection
3. Attempt to insert a match where both players are the same user; confirm rejection
4. Insert two matches with reversed player order in the same tournament; confirm the second is rejected by the normalised-pair index
5. Confirm the Security Advisor reports no row-level-security findings for the new tables

### Deferred to S-01:

Behavioural confirmation that policies restrict the right people — that a non-member cannot read someone else's tournament, that a non-creator cannot start one, that `join_tournament` refuses a started tournament. These fail at query time rather than migration time, so they will surface during S-01's UI work.

## Performance Considerations

Negligible at this scale — roughly 50 players per tournament, low query volume. The forms recommended by Supabase's advisors cost nothing and are used anyway: `(select auth.uid())` for InitPlan hoisting, `TO authenticated` on every policy so anonymous requests short-circuit, a single OR'd policy rather than multiple permissive ones, and an index on `tournament_players (user_id)` because the membership helper filters on it and the composite primary key's prefix does not serve that lookup.

## Migration Notes

There is no existing data. The remote project's only occupied schema is Supabase's own `auth`, which migrations do not own — hence starting clean rather than pulling a baseline.

Both migrations are additive; rollback is a matching `DROP` migration rather than a revert, since `supabase db push` has no down-migration mechanism. Note the deploy-ordering hazard for later: if migration application is ever automated in CI, it must run *before* the `deploy` job, or a freshly deployed build will query tables that do not yet exist.

## References

- Roadmap item: `context/foundation/roadmap.md` → F-01
- PRD requirements: `context/foundation/prd.md` → FR-001, FR-002, Access Control, Open Questions
- Downstream dependency: `context/changes/realtime-match-scaffold/change.md` — F-02 keys match rooms on `matches.id`
- Existing client factory: `src/lib/supabase.ts:5`
- Existing API route pattern: `src/pages/api/auth/signin.ts`
- Project conventions: `AGENTS.md` — migration naming, row-level-security mandate, `src/lib/` placement

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migration tooling & project link

#### Automated

- [x] 1.1 CLI resolves locally: `npx supabase --version` prints ≥ 2.99.0 — f43f3bb
- [x] 1.2 No blocked install scripts remain for this package — f43f3bb
- [x] 1.3 Lint and build still pass after the dependency bump — f43f3bb

#### Manual

- [x] 1.4 `npx supabase projects list` shows the linked project without re-prompting — f43f3bb
- [x] 1.5 `supabase/.temp/` exists locally and does not appear in `git status` — f43f3bb

### Phase 2: Tables & constraints

#### Automated

- [x] 2.1 Migration lands cleanly: `npx supabase db push --linked` — e6664f0
- [x] 2.2 Re-running reports nothing pending: `--dry-run` — e6664f0
- [x] 2.3 Types generate and contain all three tables — e6664f0

#### Manual

- [x] 2.4 All three tables visible in the dashboard with expected columns — e6664f0
- [x] 2.5 Duplicate `join_code` is rejected — e6664f0
- [x] 2.6 Match with identical players is rejected — e6664f0

### Phase 3: Access control

#### Automated

- [x] 3.1 Migration applies cleanly: `npx supabase db push --linked`
- [x] 3.2 No pending migrations remain: `--dry-run`
- [x] 3.3 Schema still introspectable: `gen types` exits 0

#### Manual

- [x] 3.4 Security Advisor reports no `rls_disabled_in_public` findings
- [x] 3.5 Policies list matches expectations; `tournament_players` has no INSERT policy

### Phase 4: Generated types & application constants

#### Automated

- [ ] 4.1 Types generate without error into `src/db/database.types.ts`
- [ ] 4.2 Type checking passes: `npm run build`
- [ ] 4.3 Linting passes: `npm run lint`

#### Manual

- [ ] 4.4 Autocomplete resolves table and column names on the typed client
- [ ] 4.5 Player cap constant matches the literal inside `join_tournament`
