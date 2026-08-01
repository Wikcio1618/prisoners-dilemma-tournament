# Generate Round-Robin Pairing Implementation Plan

## Overview

Starting a tournament generates the complete round-robin schedule in a single transaction, and every player is then shown exactly one opponent to go and find — the same person that opponent is being told to find. This is roadmap **S-02**, and it turns the tournament shell from S-01 into something with actual matches in it.

## Current State Analysis

S-01 shipped create, join, lobby, leave and start; the start button already flips `lobby → started` and closes the join window. What is missing is everything behind that flip.

Five constraints shape the work, all established in `research.md`:

- **`public.matches` has no write path at all.** It has exactly one policy — `matches_select_member` — and the migration that created it says outright that S-02 decides how pairing writes rows. It also has **no column grants anywhere in the repo**, so `authenticated` holds Supabase's stock `ALL PRIVILEGES`; an INSERT policy would let a creator write `status`, `id` and `created_at` directly.
- **Starting is a one-way door with no recovery.** Every rollback route requires `lobby`: members cannot leave, the creator cannot revert or delete, and `join_tournament` refuses new players. If the flip succeeds and pairing fails as a separate call, the tournament is **permanently bricked**. This is strictly worse than the create-tournament case, which recovers precisely because it is still in `lobby`.
- **There are no display names, and no way to get one.** Signup collects only email and password; `auth.users` is unreachable three ways over (not in `config.toml`'s exposed schemas, no grant, and **no `service_role` key is configured**). The lobby already renders truncated UUIDs.
- **`matches.player_a_id` / `player_b_id` reference `auth.users`, not membership**, so nothing stops a match naming a non-member — and the realistic cause is a race, not a bug: a player may leave while `lobby`, so a non-atomic read-then-write pairs someone who is already gone.
- **The PRD contradicts itself about pairing**, and `research.md` resolves it toward generating everything at start. Its Business Logic prose describes round-by-round scheduling; its Success Criteria, FR-003 and — decisively — its pace NFR do not.

## Desired End State

A creator with at least two players in the lobby presses start. Every pairing for the tournament is created in the same transaction that flips the status, so a `started` tournament always has a complete schedule. Each player then opens the tournament and sees one name: the person they should go and play. That person, opening their own screen, sees them back. When they finish, each sees their next opponent. Players who move faster are never blocked by players who move slower.

Verify by: `npm run build`, `npm run lint` and `npx tsc --noEmit` passing; `npx supabase db push --linked --dry-run` reporting nothing pending; and a manual four-account run where two pairs play at different speeds without interfering.

### Key Discoveries:

- **`join_tournament` is the template to copy line-for-line.** Its live body (`20260729192744_join_tournament_membership_shortcircuit.sql:14-81`) demonstrates every property a second definer function needs: `security definer set search_path = ''` with every relation schema-qualified, an explicit `auth.uid()` null check *first* because the function bypasses RLS entirely, a `FOR UPDATE` lock before any read-then-write decision, an idempotent short-circuit, and machine-readable failure tokens in `DETAIL` rather than the message.
- **Failure tokens must go in `DETAIL`, never a custom SQLSTATE.** PostgREST derives the HTTP status from the SQLSTATE and maps unrecognised codes to 500, which would turn "not enough players" into a server error. `P0002 → 404`, `P0001 → 400`, class `28 → 403`.
- **A definer function's writes are not attacker-controlled at all.** The caller passes a tournament id and nothing else; pairings are derived server-side from `tournament_players`. Compare an INSERT policy, where a `WITH CHECK` is evaluated per candidate row and is structurally incapable of expressing "this is a complete, correct round-robin over the roster".
- **The circle method needs no results.** The whole n−1-round schedule is computable from the player list alone at t=0, which is what lets rounds be a *presentation ordinal* rather than a barrier.
- **A policy that reads `tournament_players` will recurse** (`42P17`) unless it goes through a `SECURITY DEFINER` helper in the non-exposed `private` schema — the reason `private.my_tournament_ids()` exists. The profiles read policy needs a sibling helper for the same reason.
- **`matches` is empty**, so every constraint added here validates instantly and needs no backfill. `profiles` is the opposite: a trigger fires only on future inserts, so existing accounts need an explicit backfill in the same migration.

## What We're NOT Doing

- **No match play.** Submitting moves, the hidden-until-both-commit reveal, and the round loop are S-03's. This slice creates the matches and points players at each other; it does not let them play.
- **No move persistence, and no design for it.** S-04 needs the round-by-round move history; the Durable Object is the only component that knows the moves and holds no database client and no credential. Recorded as S-03's to own — see Open Risks.
- **No scoring or statistics.** S-04.
- **No forfeit, timeout or "opponent is absent" handling.** FR-004 defers it out of MVP; the `abandoned` status is added but nothing writes it yet.
- **No tournament conclusion.** `status = 'finished'` stays unreachable through the policy layer; S-04 owns the definer function that ends a tournament.
- **No full-schedule view.** By explicit decision a player sees one opponent, not their 49-match schedule.
- **No creator-kick path.** Still absent, and the `restrict` FK chosen here deliberately blocks adding one until someone decides what kicking should do to match history.
- **No rate limiting**, and no revisiting the accepted 6-digit join-code risk.
- **No double round-robin.** The normalised-pair unique index makes a rematch impossible within a tournament, and that is not being changed.

## Implementation Approach

The riskiest thing here is not the algorithm — it is that this slice adds a **second `SECURITY DEFINER` function** and simultaneously **removes a production-verified RLS policy**. Each definer function is a place where a forgotten `auth.uid()` check is a complete authorization bypass, so the value is in copying `join_tournament`'s structure exactly rather than writing something cleverer.

Phase 1 therefore lands the schema and the function together, because they are one atomic idea: a `started` tournament must never be able to exist without a complete schedule. Splitting them would create precisely the bricked-tournament window the design exists to prevent.

Identity comes before the opponent view because that view is unreadable without it, but after pairing because pairing is the core mechanic and should not wait on a trigger-and-backfill migration.

## Critical Implementation Details

**The creator-only check moves from a policy into PL/pgSQL, and must be re-verified by hand.** Dropping `tournaments_update_creator_in_lobby` and revoking `update (status)` removes a check that was verified against production during S-01's review. Inside the function it becomes an `if` statement. A non-creator calling `start_tournament` on someone else's tournament must return the *same* token as a nonexistent id — otherwise the function becomes an existence oracle for tournament UUIDs.

**The generation must be idempotent under a lost response.** If the client retries after a timeout, the second call must not attempt a second schedule. `join_tournament`'s ordering is the model: short-circuit on the already-done state *before* the state gates, not after.

**`least`/`greatest` ignore NULLs**, which is why the normalised-pair index cannot represent byes and why no bye row should ever be written. With every match generated at once there are no byes to represent — a player simply has no row for one round ordinal.

## Phase 1: Pairing schema & generation

### Overview

One migration carrying the schema changes and the function that writes pairings. After this phase a tournament can be started and its matches exist, with no UI change.

### Changes Required:

#### 1. Schema changes to `matches`

**File**: `supabase/migrations/<timestamp>_pairing_schema.sql` (via `npx supabase migration new pairing_schema`)

**Intent**: Give `matches` the round ordinal the opponent view needs, a terminal-but-unplayed state, and a constraint that a match's players actually belong to its tournament.

**Contract**: Adds `round_number integer not null` (no default — every row is written by the generator). Replaces `matches_status_check` to add `abandoned`, keeping `pending | in_progress | finished`. Adds two composite foreign keys to `public.tournament_players (tournament_id, user_id)` — one for each player column — **`on delete restrict`**, so match history cannot be silently erased by a membership deletion. The table is empty, so all three validate instantly.

Note the consequence to record in the migration comment: `restrict` means a future creator-kick path is blocked until someone decides what kicking does to history. That is deliberate — it forces the decision rather than defaulting to silent deletion.

#### 2. The pairing and start function

**File**: same migration

**Intent**: Make starting a tournament and generating its complete schedule one transaction, so a `started` tournament can never exist without matches.

**Contract**: `public.start_tournament(p_tournament_id uuid) returns integer`, declared `security definer set search_path = ''`, returning the number of matches created. `revoke execute … from public, anon; grant execute … to authenticated`.

Behaviour, in order — the ordering is the contract, not an implementation detail:

1. Reject a null `auth.uid()` with `28000` / `not_authenticated`.
2. `select … for update` the tournament, serialising concurrent starts.
3. If not found **or** the caller is not the creator, raise `P0002` / `tournament_not_found`. The same token for both, so this is not an existence oracle.
4. If already `started`, return the existing match count — idempotent under a retried request. This must precede the remaining gates.
5. If not `lobby`, raise `P0001` / `tournament_finished`.
6. If fewer than two members, raise `P0001` / `not_enough_players`.
7. Generate the schedule and insert it.
8. Flip `status` to `started`.

The pairing itself is the circle method: with the roster ordered deterministically, one player is held fixed while the rest rotate, and round *r* pairs position *i* against position *n−1−i*. Every unordered pair appears exactly once across n−1 rounds, so `matches_distinct_players` and `matches_tournament_pair_uniq` are satisfied by construction rather than by checking. For odd rosters one player sits out each round and simply has no row for that ordinal.

#### 3. Close the bypass

**File**: same migration

**Intent**: Make the function the only route to `started`, so the bricked state is unreachable rather than merely unlikely.

**Contract**: `drop policy tournaments_update_creator_in_lobby on public.tournaments` and `revoke update (status) on public.tournaments from authenticated`. After this, a direct `PATCH` setting `status` affects zero rows, and `matches` still has no INSERT policy — the same "one owned write path" shape `tournament_players` already has.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db push --linked`
- No pending migrations remain: `--dry-run`
- Types regenerate and expose the new function: `npx supabase gen types typescript --linked --schema public` contains `start_tournament`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Starting a 4-player tournament creates exactly 6 matches, each pair appearing once
- Every player appears in exactly 3 matches, and no match pairs anyone with themselves
- Round numbers form a complete schedule: 3 rounds of 2 matches, with no player appearing twice in one round
- Starting a 1-player tournament is refused with `not_enough_players` and the status stays `lobby`
- A non-creator calling `start_tournament` on someone else's tournament gets `tournament_not_found`, and the status does not change
- Calling `start_tournament` twice returns the same match count and creates no duplicate matches
- A direct `PATCH` setting `status` to `started` now affects zero rows

**Implementation Note**: The non-creator and double-call checks must be exercised by hand-crafted requests, not through the UI — they are the two properties that moved out of a verified policy into PL/pgSQL. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 2: Wire the start route

### Overview

Replace the route's table `UPDATE` with an RPC call, and map the function's failure tokens to Polish.

### Changes Required:

#### 1. Start endpoint

**File**: `src/pages/api/tournaments/[id]/start.ts`

**Intent**: Call the new function instead of updating the table, and tell the user which of the several distinct failures occurred.

**Contract**: `supabase.rpc("start_tournament", { p_tournament_id: id })`, following the calling convention in `src/pages/api/tournaments/join.ts:41-48` — read the failure token from `error.details`, never `error.message`. The `.select("id")` / zero-rows / status re-read branch added by S-01's review F7 is removed, since the function now reports refusal explicitly rather than the route having to infer it.

#### 2. Error tokens

**File**: `src/lib/tournament.ts`

**Intent**: Mirror the function's `DETAIL` vocabulary in one typed place, as `JOIN_TOURNAMENT_ERRORS` already does.

**Contract**: Exports `START_TOURNAMENT_ERRORS` with `not_authenticated`, `tournament_not_found`, `tournament_finished`, `not_enough_players`, plus an `isStartTournamentError` narrowing guard. Comment points at the migration that owns the tokens, matching the existing pointer discipline.

#### 3. Regenerated types

**File**: `src/db/database.types.ts`

**Intent**: Give the RPC call a checked signature.

**Contract**: Output of `npx supabase gen types typescript --linked --schema public`, committed. `start_tournament` appears in the `Functions` block.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- The route no longer updates the table directly: `grep -n 'from("tournaments").update' src/pages/api/tournaments/[id]/start.ts` returns nothing

#### Manual Verification:

- The creator starts a tournament from the UI and lands back on the tournament page with matches created
- Starting with one player shows a Polish message naming the minimum, and the tournament stays in lobby
- A non-creator's hand-crafted start POST shows a Polish not-found or permissions message and changes nothing
- Pressing start twice is harmless

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 3: Player identity

### Overview

Give players a display name, so the opponent view can name a person rather than a UUID prefix.

### Changes Required:

#### 1. Profiles table and trigger

**File**: `supabase/migrations/<timestamp>_player_profiles.sql`

**Intent**: Store one display name per account, populated automatically so no code path can create an account without one.

**Contract**: `public.profiles (id uuid primary key references auth.users (id) on delete cascade, display_name text not null, created_at timestamptz not null default now())`, row-level security enabled. A `SECURITY DEFINER` trigger function on `auth.users AFTER INSERT` inserts the row, taking the name from the signup metadata and falling back to a **pseudonym derived from the user id** — never the email. The migration also backfills existing accounts, because a trigger fires only on future inserts and the test accounts already exist.

The email fallback is the thing to get right: the persona is youth-camp participants including minors, emails are frequently `firstname.lastname@`, and `prd.md:106` deliberately declines to give players a contact channel. A UUID-derived pseudonym is the correct floor.

#### 2. Co-member read policy

**File**: same migration

**Intent**: Let a player see the names of people they share a tournament with, and nobody else's.

**Contract**: A `private.my_co_member_ids()` helper — `security definer stable set search_path = ''`, in the non-exposed `private` schema, with both `usage` and `execute` granted to `authenticated` — returning the user ids of everyone sharing a tournament with the caller. A SELECT policy on `profiles` using it, plus the caller's own row.

The helper is not optional: a policy on `profiles` that queries `tournament_players` directly re-enters that table's policies and raises `42P17`. This is the same trap `private.my_tournament_ids()` exists to solve.

#### 3. Display name at signup

**File**: `src/pages/api/auth/signup.ts`, `src/components/auth/SignUpForm.tsx`

**Intent**: Collect a name so the trigger has something better than a pseudonym to store.

**Contract**: The signup form gains a display-name field; the route passes it through `options: { data: { display_name } }` on `signUp`, which is where the trigger reads it from. Validated with zod alongside the existing fields. These are the existing English auth screens — the field label follows their language, not the Polish product UI.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db push --linked`
- No pending migrations remain: `--dry-run`
- Types regenerate with the new table: output contains `profiles`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- A new signup with a display name produces a `profiles` row containing it
- Pre-existing accounts have a backfilled row, and none of them contains an email address
- A player can read the profile of someone in their tournament
- A player **cannot** read the profile of someone they share no tournament with
- The lobby roster shows names instead of truncated UUIDs

**Implementation Note**: The fourth item is the one that matters — a `using (true)` policy would make every registered camper enumerable by every other. Verify it by requesting a specific unrelated profile directly, not through the UI. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 4: Opponent view

### Overview

Once a tournament is started, replace the lobby with the single opponent the player should go and find.

### Changes Required:

#### 1. Current-opponent query

**File**: `src/pages/api/tournaments/[id]/opponent.ts` (new) or the tournament page's server render

**Intent**: Resolve the one opponent to show — the other player in the caller's lowest-numbered unplayed match.

**Contract**: Returns the opponent's display name, the match id, and the round number, or an explicit "no matches left" state. Access control is the existing `matches_select_member` policy plus a filter to the caller's own matches — the caller must never receive a match they are not in. Ordering by `round_number` is what makes the pairing mutual: both players in a given round-*r* match reach it at the same ordinal.

#### 2. Started-tournament view

**File**: `src/pages/tournaments/[id].astro`

**Intent**: Show the opponent instead of the join code and roster once the tournament has started, resolving the stale-chrome finding S-01's review left open.

**Contract**: When `status` is not `lobby`, the page renders the opponent's name, their round number, and nothing else about the schedule — no list of remaining opponents, by explicit decision. The join code, share link, start button and leave button are all absent in this state. All text Polish.

The mutuality caveat belongs in the UI copy rather than being hidden: because players progress independently, the named opponent may currently be playing someone else. The screen should say who to find, not promise they are waiting.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- The started view does not render the join code: `grep -n "join_code" src/pages/tournaments/[id].astro` appears only within the lobby branch

#### Manual Verification:

- With four accounts in a started tournament, each player sees exactly one opponent name
- Two players in the same round-1 match see **each other** — the pairing is mutual
- No player can see the full schedule or any match they are not in
- The join code, start button and leave button are all gone once started
- Requesting the opponent endpoint for a tournament the caller is not in returns nothing

**Implementation Note**: The mutuality check is the point of the whole slice — verify it with two browsers side by side, not by reading the database. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Testing Strategy

No test runner is configured and introducing one stays out of scope, so verification is build-level plus manual. The manual half carries the weight because every meaningful failure here is either an authorization outcome or a scheduling-correctness property, neither of which types or builds can observe.

### Automated (per phase):

- `npx tsc --noEmit` — the only genuine typecheck; Vite strips types without checking them
- `npm run build`, `npm run lint`
- `npx supabase db push --linked --dry-run` (Phases 1 and 3)

### Manual Testing Steps:

Four accounts make the scheduling properties visible; two cannot distinguish a correct schedule from a broken one. Three exist already (`f02-test-1/2/3@example.com`).

1. Create a tournament, join with three more accounts, start it
2. Confirm 6 matches exist, each pair once, 3 rounds of 2
3. Confirm each player's screen names exactly one opponent, and that round-1 pairs name each other
4. Confirm no screen exposes the full schedule
5. Start a 1-player tournament; confirm refusal and that status stays `lobby`
6. Hand-craft a non-creator start POST; confirm refusal and no status change
7. Hand-craft a second start POST as the creator; confirm no duplicate matches
8. Request an unrelated account's profile directly; confirm refusal
9. Confirm the started view has no join code, start button or leave button

### Deferred to later slices:

Playing a match (S-03), move persistence (S-03, see Open Risks), scoring and statistics (S-04), concluding a tournament (S-04), and forfeit or timeout handling (deferred out of MVP by FR-004).

## Performance Considerations

A 50-player tournament produces 1225 matches in one `INSERT … SELECT` — fine as a statement, and fine as rows. Durable Objects are created lazily by `idFromName`, so 1225 rows create **zero** objects; at most 25 are live at once.

The real cost is not technical. 49 matches × 10 rounds is 490 hidden-move exchanges per player, up to 980 at the maximum round count, which against `prd.md:24`'s "fast enough to run many rounds without losing the room" is hours of play. Neither pairing design fixes that; it is a format question this slice makes visible for the first time.

## Migration Notes

Two migrations, both additive except for the two dropped grants. `matches` is empty so every constraint validates instantly; `profiles` needs an explicit backfill because a trigger fires only on future inserts.

The irreversible-in-practice step is dropping `tournaments_update_creator_in_lobby` and revoking `update (status)`: rollback means restoring both and reverting the route, and any tournament started through the function in between keeps its matches. Migrations must be applied before the deploy that calls `start_tournament`, or the route will call a function that does not exist.

## References

- Research: `context/changes/generate-round-robin-pairing/research.md`
- Roadmap item: `context/foundation/roadmap.md` → S-02
- PRD: `context/foundation/prd.md` → FR-003, Business Logic, the pace NFR at line 84, US-01
- The definer-function template: `supabase/migrations/20260729192744_join_tournament_membership_shortcircuit.sql:14-81`
- The recursion-breaking helper pattern: `supabase/migrations/20260729174939_tournament_rls.sql:27-51`
- RPC calling convention: `src/pages/api/tournaments/join.ts:41-48`
- Upstream reviews: `context/changes/tournament-data-model/reviews/impl-review.md`, `context/changes/create-and-join-tournament/reviews/impl-review.md`

## Addendum — implementation review, 2026-08-01

`reviews/impl-review.md`, verdict NEEDS ATTENTION, 9 findings, no material drift across any of
the four phases.

**One correction to this plan, not to the code.** The Desired End State (line 21) promises
"players who move faster are never blocked by players who move slower", and Phase 4's contract
(line 259) promises that ordering by `round_number` makes the naming mutual. Under a
single-named-opponent rule those two properties are mutually exclusive, and this plan should not
have asserted both. Mutuality holds only while every player has completed the same number of
matches — true today only because nothing marks a match finished.

Decided as S-03's to resolve, recorded in `change.md`, with the false invariant corrected in
`src/pages/tournaments/[id].astro`. Criterion 4.6 remains legitimately met: it tests the
all-players-at-zero state, which is exactly the state this slice can produce.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Pairing schema & generation

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db push --linked` — fe9db0d
- [x] 1.2 No pending migrations remain: `--dry-run` — fe9db0d
- [x] 1.3 Types regenerate and expose `start_tournament` — fe9db0d
- [x] 1.4 Type checking passes: `npx tsc --noEmit` — fe9db0d
- [x] 1.5 Linting passes: `npm run lint` — fe9db0d
- [x] 1.6 Build succeeds: `npm run build` — fe9db0d

#### Manual

- [x] 1.7 A 4-player tournament creates exactly 6 matches, each pair once — d209690
- [x] 1.8 Every player appears in exactly 3 matches, none paired with themselves — d209690
- [x] 1.9 Round numbers form 3 rounds of 2 with no player twice in a round — d209690
- [x] 1.10 A 1-player start is refused with `not_enough_players`, status stays lobby — d209690
- [x] 1.11 A non-creator start returns `tournament_not_found` and changes nothing — d209690
- [x] 1.12 Calling start twice returns the same count and creates no duplicates — d209690
- [x] 1.13 A direct PATCH setting status to started affects zero rows — d209690

### Phase 2: Wire the start route

#### Automated

- [x] 2.1 Type checking passes: `npx tsc --noEmit` — d209690
- [x] 2.2 Linting passes: `npm run lint` — d209690
- [x] 2.3 Build succeeds: `npm run build` — d209690
- [x] 2.4 The route no longer updates the tournaments table directly — d209690

#### Manual

- [x] 2.5 The creator starts from the UI and matches are created — d209690
- [x] 2.6 Starting with one player shows a Polish message; status stays lobby — d209690
- [x] 2.7 A non-creator's start POST shows a Polish message and changes nothing — d209690
- [x] 2.8 Pressing start twice is harmless — d209690

### Phase 3: Player identity

#### Automated

- [x] 3.1 Migration applies cleanly: `npx supabase db push --linked` — a315659
- [x] 3.2 No pending migrations remain: `--dry-run` — a315659
- [x] 3.3 Types regenerate with `profiles` — a315659
- [x] 3.4 Type checking passes: `npx tsc --noEmit` — a315659
- [x] 3.5 Linting passes: `npm run lint` — a315659
- [x] 3.6 Build succeeds: `npm run build` — a315659

#### Manual

- [x] 3.7 A new signup with a display name produces a matching `profiles` row — a315659
- [x] 3.8 Pre-existing accounts are backfilled, and no row contains an email address — a315659
- [x] 3.9 A player can read the profile of someone in their tournament — a315659
- [x] 3.10 A player cannot read the profile of an unrelated account — a315659
- [x] 3.11 The lobby roster shows names instead of truncated UUIDs — a315659

### Phase 4: Opponent view

#### Automated

- [x] 4.1 Type checking passes: `npx tsc --noEmit` — e4386f3
- [x] 4.2 Linting passes: `npm run lint` — e4386f3
- [x] 4.3 Build succeeds: `npm run build` — e4386f3
- [x] 4.4 The started view does not render the join code — e4386f3

#### Manual

- [x] 4.5 Each player in a started 4-player tournament sees exactly one opponent — 7c5aa29
- [x] 4.6 Two players in the same round-1 match see each other — 7c5aa29
- [x] 4.7 No player can see the full schedule or a match they are not in — 7c5aa29
- [x] 4.8 The join code, start button and leave button are gone once started — 7c5aa29
- [x] 4.9 The opponent endpoint returns nothing for a non-member — 7c5aa29
