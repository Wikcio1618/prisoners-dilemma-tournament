# Tournament Data Model — Plan Brief

> Full plan: `context/changes/tournament-data-model/plan.md`

## What & Why

The Prisoner's Dilemma tournament app has working authentication and a live deployment, but no application data whatsoever — no tables, no migrations, no generated types. This change lands the minimal tournament domain (tournaments, membership, a structural matches table) plus the migration tooling and typed client that S-01, S-02, and F-02 all sit on. It is roadmap item **F-01**.

## Starting Point

`src/lib/supabase.ts` wires a working Supabase client and auth runs in production, but `supabase/` contains only a default `config.toml` — no migrations directory, no link to the remote project, and no `Database` generic on the client. The Supabase CLI binary is also missing: npm 12 blocks install scripts by default, so the pinned `supabase@2.98.2` never downloaded it. Docker is not installed either, ruling out the local-stack workflow.

## Desired End State

Three tables live on the remote project with row-level security enabled and per-operation policies, produced by two committed migration files. Members can read their own tournaments; creators can start them; every membership insert — including the creator's own — flows through a single `join_tournament(code)` database function. `src/lib/supabase.ts` returns a fully typed client.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| What match rooms key on | F-01 grows to include a `matches` table | F-02 was made dependent on F-01 for real match ids; the roadmap's original "no match tables" scope couldn't supply one |
| Matches table contents | Structure only, no rows written | S-02's pairing logic defines what a match means; guessing now guarantees rework |
| Creator membership | Joins explicitly, like everyone else | Removes an entire policy class — one join path for all, so `tournament_players` needs no insert policy at all |
| Joining by code | Database function | Row-level security cannot see a client's filter, so "readable if you know the code" is inexpressible as a policy; the function also makes the player cap race-proof |
| Starting a tournament | Update policy + column-level grant | Policies can't restrict *which* columns change; the grant narrows it to `status` |
| Join code generation | Application code | Chosen for readability over the database-side alternative; the unique constraint remains the backstop |
| Player cap | Hardcoded constant (50) | A camp-group constant that won't change mid-event; no schema or UI surface warranted |
| Round count | 1–20, default 10, app-validated | No database CHECK by explicit decision |
| Supabase CLI | Upgrade dependency to ≥ 2.99 | Those versions dropped the install script entirely, fixing local and CI without adding a script-execution exception |
| Migration baseline | Start clean | The remote's only occupied schema is Supabase's own `auth`, which migrations don't own |
| Verification | Deferred to S-01's UI | No throwaway test script; migration-level and type-level checks only |

## Scope

**In scope:** Supabase CLI repair and remote project link · two migrations (tables, then policies) · `private` helper schema breaking policy recursion · `join_tournament` function · generated TypeScript types · typed client · domain constants.

**Out of scope:** pairing logic · move/round/score/statistics storage · any UI · database-level round-count constraint · behavioural policy testing · CI migration automation · any admin/secret API key.

## Architecture / Approach

Two migration files split at the tables/policies boundary, so a failed push points at one half unambiguously — the policy half is where failures surface at query time rather than migration time. Access control divides by operation: reads and the status update run through the user's own session client with policies applied, while every membership insert goes through a `SECURITY DEFINER` function that enforces lobby state and player cap atomically under a row lock. A `private` schema holds a membership-lookup helper whose sole purpose is breaking two policy-recursion cycles that would otherwise abort queries with `42P17`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Migration tooling & project link | Working CLI, linked project | Needs the operator's Supabase login and database password — the only interactive step |
| 2. Tables & constraints | Three tables live on the remote | The normalised-pair unique index is easy to get wrong; a plain unique constraint won't stop reversed duplicates |
| 3. Access control | Policies, helper schema, join function | Recursion cycles and missing schema grants both fail at query time, not migration time |
| 4. Generated types & constants | Typed client, domain constants | Player cap is duplicated between SQL and TypeScript and must be kept in sync |

**Prerequisites:** Supabase account access and the remote database password for project `jkaszaakfgqlulunoxer`. No Docker required.
**Estimated effort:** ~1–2 sessions across four phases; phases 2 and 3 are the substantive ones.

## Open Risks & Assumptions

- **Policy behaviour is unverified until S-01.** By explicit decision there is no test script, so recursion and grant mistakes — which fail at query time — will surface during UI work, where they compete for attention with new-feature bugs. This is a foundation three slices depend on.
- **The remote schema was never inspected.** No command in planning contacted the database, so undocumented drift would only appear at first push.
- **The player cap lives in two places** — a literal inside `join_tournament` and a TypeScript constant — and nothing enforces that they agree.
- **F-01 is now larger than the roadmap describes.** The roadmap's F-01 entry says "no pairing, match, or statistics tables"; adding `matches` contradicts that and the roadmap needs updating to match.
- **Config divergence:** `supabase/config.toml` declares Postgres major version 17 for the local stack; the remote's version was not verified.

## Success Criteria (Summary)

- Two migrations are committed and `supabase db push --linked --dry-run` reports nothing pending against the remote.
- `supabase gen types typescript --linked` succeeds and `npm run build` passes with the `Database`-typed client in place.
- S-01 can begin: the tables, the join function, and the types it needs all exist.
