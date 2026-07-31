# Create and Join Tournament Implementation Plan

## Overview

Ship the tournament shell: a logged-in player creates a tournament with a fixed round count, shares a 6-digit code or link, other logged-in players join before it starts, and the creator closes the lobby by starting it. This is roadmap **S-01**, the north star slice — the smallest end-to-end flow that proves the tournament shell works before the riskier hidden-move mechanic in S-03.

## Current State Analysis

F-01 landed the schema and F-02 landed the realtime scaffold, but no tournament-domain UI or API exists. `src/pages/api/` holds only the three auth routes; `dashboard.astro` is a placeholder that renders the user's email.

Five findings shape this slice:

- **F-01's row-level security has never been exercised by a real user.** It shipped with behavioural verification deliberately deferred to this slice. Recursion, grant and visibility mistakes fail at *query* time, not migration time, so this is where they surface. Every phase below therefore verifies a policy path as a first-class success criterion, not as a side effect.
- **The established API convention is redirect-based.** `src/pages/api/auth/signin.ts:16` redirects with `?error=<message>`; there is no JSON endpoint and no client fetch layer anywhere in the codebase.
- **zod is not installed**, despite `AGENTS.md:10` mandating it for API routes. The auth routes cast `form.get()` to `string` unchecked. `rounds_per_match` has **no database constraint** by explicit F-01 decision, so a server-side bound is the only thing standing between a client and `rounds_per_match = 2147483647`.
- **All existing UI is English** (`SignInForm.tsx:83`, `dashboard.astro:14`, `Topbar.astro`), but `prd.md:82` requires Polish for player-facing text and US-01 fixes Polish move labels. S-01 creates the product vocabulary.
- **`src/middleware.ts:18-22` redirects unauthenticated users to `/auth/signin` with no return path.** A shared join link opened by a signed-out invitee currently loses the code.

## Desired End State

A logged-in player opens the app, creates a tournament choosing a round count, and lands in a lobby showing a 6-digit code and a shareable link. Sending that link to a second player — signed out — takes them through sign-in and deposits them in the same lobby, listed on the roster. Both see the roster grow without reloading. A member can leave while the tournament is in lobby. The creator presses start, the join window closes, and further join attempts are rejected with a distinct reason.

Verify by: `npm run build`, `npm run lint` and `npx tsc --noEmit` passing; `npx supabase db push --linked --dry-run` reporting no pending migrations; and the manual two-account flow above completing end to end against the deployed app.

### Key Discoveries:

- **Every membership insert must go through `public.join_tournament(p_join_code text)`** — including the creator's own. `tournament_players` has no INSERT policy, so a direct insert is denied by default. Creating a tournament is therefore inherently **two steps**: insert the row, then call the function. They are not atomic; see Critical Implementation Details.
- **Failure reasons arrive in `error.details`, not `error.message`.** `JOIN_TOURNAMENT_ERRORS` and `isJoinTournamentError` in `src/lib/tournament.ts` exist precisely so this slice never matches on prose. The tokens are `not_authenticated`, `tournament_not_found`, `tournament_already_started`, `tournament_full`.
- **`tournaments` SELECT is `id IN (SELECT private.my_tournament_ids()) OR creator_id = auth.uid()`.** A player can only ever see tournaments they created or belong to — there is no "browse tournaments" query to write, and a join-by-code lookup from the client would return zero rows. Resolution by code happens *only* inside `join_tournament`.
- **The UPDATE policy permits `lobby → started` and nothing else.** `USING` requires `status = 'lobby'` and `WITH CHECK` requires `status = 'started'`, composed with a column-level grant restricting the update to `status` alone. A second start therefore affects zero rows rather than erroring.
- **`tournament_players` DELETE is self-only and lobby-only.** There is no creator-kick path, which is why leaving is in scope.
- `src/lib/tournament.ts` currently exports `MAX_PLAYERS_PER_TOURNAMENT` (50), `MIN_/MAX_/DEFAULT_ROUNDS_PER_MATCH` (1/20/10), `JOIN_CODE_PATTERN`, `JOIN_CODE_LENGTH` and the error helpers — all with **zero call sites**. This slice is the first consumer.
- The form pattern to follow is a React island posting to an API route, with the server error passed back as a prop from a query parameter (`signin.astro:5`, `SignInForm.tsx:43`).

## What We're NOT Doing

- **No pairing generation.** S-02 owns round-robin and writes the first `matches` rows. Starting a tournament here only flips `status`.
- **No match play, moves, or scores.** S-03 and S-04.
- **No started-tournament screen beyond a placeholder.** Once started, the lobby says so; what a started tournament looks like is S-02's to design.
- **No creator-kick.** F-01 has no policy for it; a member removes themselves or nobody does.
- **No rate limiting on join attempts.** Deferred to S-03 — see Open Risks, because the 6-digit code makes this a real exposure.
- **No translation of the existing auth screens.** New product UI is Polish; `signin.astro`, `signup.astro`, `dashboard.astro` and `Topbar.astro` keep their English strings.
- **No zod retrofit of the auth routes.** New routes only.
- **No Supabase Realtime.** The roster is polled; the only realtime mechanism in this project stays F-02's Durable Objects.
- **No tournament editing or deletion.** F-01 has a creator-delete policy; nothing in this slice calls it.

## Implementation Approach

Phase 1 is deliberately UI-free. The join-code format change carries a migration and touches constants with no call sites yet, so landing it alone means a failure there is unambiguous.

After that each phase ends at something a human can do, and each one is chosen to exercise a different F-01 policy: creating exercises INSERT plus the `join_tournament` path, joining exercises the function's error tokens, the lobby exercises both SELECT policies, and leave/start exercise DELETE and the UPDATE-plus-column-grant pair. By the end of Phase 5 every policy F-01 shipped has been driven by a real session — which is the actual point of this slice, beyond the user-facing feature.

Mutations are redirect-based to match the auth routes. The roster endpoint is the single exception and returns JSON, because polling a redirect makes no sense; that split is deliberate rather than per-endpoint improvisation.

## Critical Implementation Details

**Creating a tournament is not atomic.** The insert and the creator's `join_tournament` call are two round trips, and F-01 has no `create_tournament` function to make them one. If the second fails, an empty tournament sits in lobby, visible to its creator through the `creator_id` clause of the SELECT policy and startable with zero players. The create route must handle that failure explicitly rather than assuming success — either by surfacing it, or by deleting the orphan through the creator-delete policy.

**Join-code collision retry must distinguish two failures.** The unique violation on `join_code` (SQLSTATE `23505`) means "retry with a new code"; anything else means stop. A blanket retry loop will spin on an unrelated error. With 6 digits and camp-scale volume a collision is rare, but the retry is what makes it invisible rather than a user-facing error.

**The `next` return path is an open-redirect surface.** Sign-in must accept only a relative path — reject anything not starting with `/`, and reject `//` which browsers treat as protocol-relative.

---

## Phase 1: Join-code groundwork

### Overview

Relax the join-code format to 6 digits, add the generator and validation layer, and install zod. No user-visible change.

### Changes Required:

#### 1. Join-code format migration

**File**: `supabase/migrations/<timestamp>_join_code_six_digits.sql` (created via `npx supabase migration new join_code_six_digits`)

**Intent**: Replace the `^[A-Z0-9]{8,}$` CHECK with a 6-digit numeric format, so codes are short enough to read aloud in a noisy room.

**Contract**: Drops `tournaments_join_code_format` and adds it back as `check (join_code ~ '^[0-9]{6}$')`. The table is empty, so the constraint validates instantly. Note this *narrows* the keyspace from ~10^11 to 10^6 — recorded under Open Risks.

#### 2. Domain constants and generator

**File**: `src/lib/tournament.ts`

**Intent**: Bring the constants in line with the new format and add the server-side generator this slice needs, replacing the placeholder pattern that has no call sites.

**Contract**: `JOIN_CODE_PATTERN` becomes `/^[0-9]{6}$/` and `JOIN_CODE_LENGTH` becomes `6`, both keeping their comment pointing at the migration that enforces them. Adds a generator returning a 6-digit string with a leading zero preserved (a numeric type would drop it — the column is `text` for this reason). Uses `crypto.getRandomValues`, not `Math.random`, since the code is the entry credential.

#### 3. zod dependency and schemas

**File**: `package.json`, `src/lib/schemas.ts` (new)

**Intent**: Make `AGENTS.md`'s validation rule true, and give the create/join routes a single place to enforce the bounds the database deliberately does not.

**Contract**: zod added to `dependencies`. `src/lib/schemas.ts` exports a create schema (`rounds_per_match` coerced from the form string, integer, bounded by `MIN_/MAX_ROUNDS_PER_MATCH`) and a join schema (`join_code` matching `JOIN_CODE_PATTERN`). Both derive their bounds from the constants rather than restating literals.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db push --linked`
- No pending migrations remain: `npx supabase db push --linked --dry-run`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Inserting a tournament with a 6-digit `join_code` succeeds in the Supabase SQL editor; a 5-digit and an 8-character alphanumeric code are both rejected
- The generator produces codes with leading zeros preserved over repeated calls

**Implementation Note**: The leading-zero check is the one that catches a numeric-typed generator, which passes a casual test and then produces 5-character codes roughly one time in ten. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 2: Create a tournament

### Overview

The creator flow: a Polish form, a validated endpoint that generates a code and enrols the creator, and a redirect into the lobby.

### Changes Required:

#### 1. Create endpoint

**File**: `src/pages/api/tournaments/index.ts` (new)

**Intent**: Create the tournament row and enrol its creator, which the schema requires be two separate operations.

**Contract**: `POST` with `export const prerender = false`. Validates the form with the create schema; on failure redirects back with an error token. Inserts `{ creator_id, rounds_per_match, join_code }` retrying on `23505` only, then calls `supabase.rpc("join_tournament", { p_join_code })` to enrol the creator. On success redirects to the lobby for the new tournament. If enrolment fails after the insert succeeded, the orphan tournament must be handled rather than ignored — see Critical Implementation Details.

#### 2. Create form and page

**File**: `src/components/tournament/CreateTournamentForm.tsx` (new), `src/pages/tournaments/new.astro` (new)

**Intent**: Give the creator a round-count choice and nothing else, in Polish.

**Contract**: React island following the `SignInForm` pattern — `method="POST" action="/api/tournaments"`, client-side validation mirroring the zod bounds, `serverError` passed as a prop from the page's `error` query parameter. Round count defaults to `DEFAULT_ROUNDS_PER_MATCH` and is bounded by the same constants the schema uses. The page is added to `PROTECTED_ROUTES` in `src/middleware.ts`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- The route is gated: `/tournaments` appears in `PROTECTED_ROUTES` in `src/middleware.ts`

#### Manual Verification:

- Creating a tournament as a signed-in user lands on a lobby showing a 6-digit code
- The creator appears on their own roster — confirming the `join_tournament` call ran, not just the insert
- Submitting a round count of 0, 21, or a non-number is rejected without reaching the database
- Visiting `/tournaments/new` signed out redirects to sign-in

**Implementation Note**: The second item is the one that catches a create route that inserts and forgets to enrol — the tournament exists and looks fine to its creator through the `creator_id` clause, but has zero members. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 3: Join by code and by link

### Overview

The invitee flow: a code-entry form, a shareable `/join/<code>` link, and a return path through sign-in so the link survives a signed-out visitor.

### Changes Required:

#### 1. Join endpoint

**File**: `src/pages/api/tournaments/join.ts` (new)

**Intent**: Resolve a join code to a membership, translating the database's failure tokens into Polish messages.

**Contract**: `POST`, validates with the join schema, calls `supabase.rpc("join_tournament", { p_join_code })`. Maps `error.details` through `isJoinTournamentError` to a Polish message — never `error.message`, which is English prose and may be reworded. On success redirects to the lobby for the returned tournament id. An already-joined caller succeeds idempotently and lands in the lobby, which is the function's documented behaviour.

#### 2. Join form, page, and shareable link route

**File**: `src/components/tournament/JoinTournamentForm.tsx` (new), `src/pages/tournaments/join.astro` (new), `src/pages/join/[code].astro` (new)

**Intent**: Let a player enter a code manually, and let a shared link pre-fill it.

**Contract**: The form follows the `SignInForm` pattern, posting to `/api/tournaments/join` with a 6-digit numeric input. `/join/[code]` reads the code from the route parameter and pre-fills the same form. Both pages are gated.

#### 3. Return path through sign-in

**File**: `src/middleware.ts`, `src/pages/auth/signin.astro`, `src/components/auth/SignInForm.tsx`, `src/pages/api/auth/signin.ts`

**Intent**: Make a shared link work for the person it was sent to, whatever their session state.

**Contract**: The middleware appends the requested path as a `next` query parameter when redirecting to sign-in. `signin.astro` reads it and passes it to the form, which carries it as a hidden field. The sign-in route redirects to `next` when present instead of `/`, accepting **only** relative paths — reject anything not starting with `/`, and reject `//`. This is the one change in this slice that touches existing auth code, and it is load-bearing for the open-redirect boundary.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- A second account joins via the code-entry form and appears on the roster
- Opening `/join/<code>` while signed out redirects to sign-in and, after signing in, lands in the correct lobby
- An unknown code, and a code for a tournament that has already started, each produce a distinct Polish message
- `next=https://example.com` and `next=//example.com` on the sign-in URL do **not** redirect off-site
- Joining a tournament twice is idempotent — the second attempt lands in the lobby rather than erroring

**Implementation Note**: The open-redirect items are the security check of this slice; verify them by hand-editing the URL, not through the UI. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 4: Lobby with live roster

### Overview

The shared screen: who is here, what the code is, and a list of the player's tournaments. The roster updates by polling.

### Changes Required:

#### 1. Roster endpoint

**File**: `src/pages/api/tournaments/[id]/players.ts` (new)

**Intent**: Serve the current roster for polling — the one read this slice makes over JSON rather than a page render.

**Contract**: `GET` returning JSON. Selects members for the tournament, relying on the `tournament_players` SELECT policy to scope visibility rather than filtering by hand; a non-member receives an empty set from the policy, which the route surfaces as 404 rather than an empty roster, so membership is not probeable. Returns the tournament's `status` alongside the roster so a poller notices a start.

#### 2. Lobby page

**File**: `src/pages/tournaments/[id].astro` (new), `src/components/tournament/LobbyRoster.tsx` (new)

**Intent**: Show the code, the shareable link, and the roster as it fills.

**Contract**: Server-renders the tournament and initial roster; the island polls the roster endpoint on an interval and reconciles. Polling stops when the tournament is no longer in lobby, and on unmount. Displays the 6-digit code and a copyable `/join/<code>` link. A started tournament renders a placeholder noting pairing is not built yet — S-02 replaces it. All text Polish.

#### 3. Tournament list

**File**: `src/pages/tournaments/index.astro` (new)

**Intent**: Give a returning player a way back into their tournaments, since nothing else links to them.

**Contract**: Lists tournaments the `tournaments` SELECT policy returns — the caller's memberships plus anything they created. No filtering by hand: the policy is the access control, and writing a redundant `WHERE` would mask a policy failure. Linked from `Topbar.astro`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- With the lobby open in one browser, a second account joining appears on the roster within the poll interval and without a reload
- The tournament list shows a created tournament and a joined tournament, and **omits** a tournament belonging to neither
- Requesting the roster endpoint for a tournament the caller is not in returns 404, not an empty roster
- Copying the shareable link and opening it in a clean browser session reaches the right lobby
- Polling stops once the tournament is started — confirmed by watching network requests cease

**Implementation Note**: The third item is the first direct test of the `tournament_players` SELECT policy and the second is the first test of the `tournaments` SELECT policy — both shipped unverified in F-01. If either leaks a row it belongs to somebody else, stop and fix the policy before continuing. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Phase 5: Leave and start

### Overview

The two mutations that close out the lobby lifecycle, and the last two unverified F-01 policies.

### Changes Required:

#### 1. Leave endpoint and control

**File**: `src/pages/api/tournaments/[id]/leave.ts` (new), lobby page

**Intent**: Let a member undo a mis-join while the tournament is still in lobby, the only correction available given there is no creator-kick.

**Contract**: `POST` deleting the caller's own `tournament_players` row and redirecting to the tournament list. Relies entirely on the DELETE policy (self-only, lobby-only) for authorisation rather than re-checking in application code. A delete affecting zero rows means the policy refused — surface that as a message rather than reporting success. The control is hidden for the creator, whose leaving would orphan the tournament.

#### 2. Start endpoint and control

**File**: `src/pages/api/tournaments/[id]/start.ts` (new), lobby page

**Intent**: Close the join window, satisfying FR-002's "no new players once started".

**Contract**: `POST` updating `status` to `started`, relying on the UPDATE policy plus column grant for authorisation. Because `USING` requires `lobby`, a second start affects zero rows rather than erroring — treat that as already-started, not failure. The control is shown only to the creator. Whether a minimum player count is required is left to S-02, which owns pairing and is the first thing that cannot work with one player.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- A non-creator member leaves and disappears from the other player's roster within the poll interval
- The creator sees no leave control; a non-creator sees no start control
- After the creator starts, a further join attempt with the same code is rejected as already-started
- Pressing start twice is harmless — the second press reports already-started rather than an error
- A non-creator who crafts a POST to the start endpoint does not change the status

**Implementation Note**: The last item must be tested by hand-crafting the request, not through the UI, since the UI hides the control. It is the only direct test that the UPDATE policy — not merely the hidden button — is what enforces creator-only starting. After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Testing Strategy

No test runner is configured in this repository and introducing one is out of scope, so verification is build-level and manual. The manual half carries the weight here because every meaningful failure mode in this slice is an authorisation outcome, which types and builds cannot observe.

### Automated (per phase):

- `npx tsc --noEmit` — the only genuine typecheck; Vite strips types without checking them, so `npm run build` alone does not cover this
- `npm run build`, `npm run lint`
- `npx supabase db push --linked --dry-run` (Phase 1)

### Manual Testing Steps:

Two accounts are required throughout; three make the negative cases sharper. Accounts already exist from F-02's verification (`f02-test-1/2/3@example.com`).

1. Create a tournament; confirm the creator is on their own roster and a 6-digit code is shown
2. Join from a second account via the code form; confirm both rosters update without reload
3. Open the shared link signed out; confirm sign-in returns to the correct lobby
4. Attempt an unknown code and a started tournament's code; confirm distinct Polish messages
5. From a third account, request the roster endpoint for a tournament it is not in; confirm 404
6. Confirm the tournament list omits tournaments the account neither created nor joined
7. Leave from the second account; confirm removal propagates
8. Start from the creator; confirm further joins are refused and polling stops
9. Hand-craft a start POST from a non-creator; confirm the status does not change
10. Hand-edit `next=https://example.com` on the sign-in URL; confirm no off-site redirect

### Deferred to later slices:

Rate limiting on join attempts (S-03), pairing and the started-tournament screen (S-02), and any concurrency testing of simultaneous joins against the 50-player cap — `join_tournament` serialises on a row lock, which F-01 verified, so this slice inherits that guarantee rather than re-testing it.

## Performance Considerations

Negligible at camp scale. The roster poll is the only repeated request: a handful of rows, a few clients, on an interval measured in seconds. It stops when the tournament leaves lobby and on unmount, which is what keeps an abandoned open tab from polling indefinitely.

## Migration Notes

One migration, narrowing the `join_code` CHECK. The table is empty so it validates instantly, and the change is not backwards compatible with existing 8-character codes — none exist, but this ordering means the migration must land before any code is generated. Rollback is a matching migration restoring the wider pattern.

## References

- Roadmap item: `context/foundation/roadmap.md` → S-01
- PRD requirements: `context/foundation/prd.md` → FR-001, FR-002, Access Control, NFR (Polish UI)
- Inherited constraints: `context/changes/create-and-join-tournament/change.md`
- Upstream schema and its review: `context/changes/tournament-data-model/plan.md` (see `## Addendum`), `context/changes/tournament-data-model/reviews/impl-review.md`
- Form pattern to follow: `src/components/auth/SignInForm.tsx:43`, `src/pages/auth/signin.astro:5`
- Redirect-based route pattern: `src/pages/api/auth/signin.ts:16`
- Route gating: `src/middleware.ts:4`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Join-code groundwork

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db push --linked` — ef663a1
- [x] 1.2 No pending migrations remain: `--dry-run` — ef663a1
- [x] 1.3 Type checking passes: `npx tsc --noEmit` — ef663a1
- [x] 1.4 Linting passes: `npm run lint` — ef663a1
- [x] 1.5 Build succeeds: `npm run build` — ef663a1

#### Manual

- [x] 1.6 6-digit code accepted; 5-digit and 8-char alphanumeric rejected
- [x] 1.7 Generator preserves leading zeros — 2511866

### Phase 2: Create a tournament

#### Automated

- [x] 2.1 Type checking passes: `npx tsc --noEmit` — 62c53c2
- [x] 2.2 Linting passes: `npm run lint` — 62c53c2
- [x] 2.3 Build succeeds: `npm run build` — 62c53c2
- [x] 2.4 `/tournaments` is gated in `PROTECTED_ROUTES` — 62c53c2

#### Manual

- [x] 2.5 Creating a tournament lands on a lobby showing a 6-digit code — 2511866
- [x] 2.6 The creator appears on their own roster — 2511866
- [x] 2.7 Round counts of 0, 21 and non-numbers are rejected before the database — 2511866
- [x] 2.8 `/tournaments/new` signed out redirects to sign-in — 2511866

### Phase 3: Join by code and by link

#### Automated

- [x] 3.1 Type checking passes: `npx tsc --noEmit` — a006f9b
- [x] 3.2 Linting passes: `npm run lint` — a006f9b
- [x] 3.3 Build succeeds: `npm run build` — a006f9b

#### Manual

- [x] 3.4 A second account joins by code and appears on the roster — 2511866
- [x] 3.5 `/join/<code>` signed out returns to the correct lobby after sign-in — 2511866
- [x] 3.6 Unknown code and already-started code give distinct Polish messages — 2511866
- [x] 3.7 `next=https://example.com` and `next=//example.com` do not redirect off-site — 2511866
- [x] 3.8 Joining twice is idempotent — 2511866

### Phase 4: Lobby with live roster

#### Automated

- [x] 4.1 Type checking passes: `npx tsc --noEmit` — f316c2b
- [x] 4.2 Linting passes: `npm run lint` — f316c2b
- [x] 4.3 Build succeeds: `npm run build` — f316c2b

#### Manual

- [x] 4.4 A second account joining appears on the roster without a reload — 2511866
- [x] 4.5 The tournament list shows created and joined tournaments and omits others — 2511866
- [x] 4.6 The roster endpoint returns 404 for a non-member — 2511866
- [x] 4.7 The shared link opened in a clean session reaches the right lobby — 2511866
- [ ] 4.8 Polling stops once the tournament is started

### Phase 5: Leave and start

#### Automated

- [x] 5.1 Type checking passes: `npx tsc --noEmit` — bb5511c
- [x] 5.2 Linting passes: `npm run lint` — bb5511c
- [x] 5.3 Build succeeds: `npm run build` — bb5511c

#### Manual

- [x] 5.4 A member leaving disappears from the other player's roster — 2511866
- [x] 5.5 The creator sees no leave control; a non-creator sees no start control
- [x] 5.6 After start, a further join with the same code is rejected as already-started — 2511866
- [x] 5.7 Pressing start twice reports already-started rather than erroring — 2511866
- [x] 5.8 A hand-crafted start POST from a non-creator does not change the status — 2511866
