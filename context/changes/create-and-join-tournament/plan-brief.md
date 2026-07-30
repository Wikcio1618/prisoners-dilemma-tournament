# Create and Join Tournament — Plan Brief

> Full plan: `context/changes/create-and-join-tournament/plan.md`

## What & Why

Roadmap **S-01**, the north star slice: a logged-in player creates a tournament with a fixed round count, shares a 6-digit code or link, and other logged-in players join before it starts. It's the smallest end-to-end flow that proves the tournament shell works before the riskier hidden-move mechanic in S-03.

## Starting Point

F-01 shipped the schema and F-02 the realtime scaffold, but no tournament UI or API exists — `src/pages/api/` holds only auth routes and `dashboard.astro` renders the user's email. Critically, **F-01's row-level security has never been exercised by a real user**; it shipped with behavioural verification deferred to exactly this slice.

## Desired End State

A player creates a tournament and lands in a lobby showing a code and shareable link. Sending that link to a signed-out friend takes them through sign-in and into the same lobby. Both watch the roster fill without reloading. A member can leave while in lobby; the creator starts, closing the join window.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Start button | In scope — status flip only | Makes FR-002's "join window closes" testable now; S-02 adds pairing behind it |
| Leaving | In scope | The only correction for a mis-join, since F-01 has no creator-kick, and it exercises an otherwise untested policy |
| UI language | Polish for new product UI only | Honours the PRD NFR where product vocabulary is created; existing auth screens stay English |
| Validation | Add zod, new routes only | `rounds_per_match` has no DB constraint, so the server is the only bound; makes AGENTS.md true |
| Response style | Redirect-based, matching auth | Identical to the three existing auth routes; no client fetch layer to invent |
| Join code | 6 digits, numeric | Shortest to dictate in a noisy room; requires a migration narrowing the CHECK from `{8,}` |
| Roster liveness | Poll a JSON endpoint | Feels live with no new infrastructure; Supabase Realtime would be a second realtime mechanism alongside F-02's Durable Objects |
| Shared link, signed out | Return path through sign-in | The link has to work for whoever it was sent to; needs a `next` parameter that doesn't exist today |

## Scope

**In scope:** join-code migration and generator; zod schemas; create endpoint and Polish form; join endpoint, code form and `/join/<code>`; `next` return path through sign-in; lobby with polled roster; tournament list; leave and start.

**Out of scope:** pairing (S-02); match play, moves, scores (S-03/S-04); creator-kick; rate limiting; translating existing auth screens; zod retrofit; Supabase Realtime; tournament edit/delete.

## Architecture / Approach

```
create form ─POST→ /api/tournaments ─┬→ insert tournaments (retry on 23505)
                                     └→ rpc join_tournament(code)   ← enrols creator
join form / /join/<code> ─POST→ /api/tournaments/join ─→ rpc join_tournament(code)
lobby page ──poll──→ GET /api/tournaments/[id]/players   (JSON; the one non-redirect route)
leave / start ─POST→ …/leave, …/start                    (authorised purely by RLS)
```

Every membership insert goes through `join_tournament` — `tournament_players` has no INSERT policy, so creating a tournament is inherently two non-atomic steps. Failure reasons are read from `error.details`, never `error.message`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Join-code groundwork | 6-digit migration, generator, zod | A numeric-typed generator silently drops leading zeros |
| 2. Create a tournament | Create endpoint + Polish form | Insert succeeds but creator enrolment doesn't, leaving a memberless tournament |
| 3. Join by code and link | Join endpoint, `/join/<code>`, `next` return path | `next` is an open-redirect surface |
| 4. Lobby with live roster | Lobby, polled roster, tournament list | First real test of both SELECT policies — a leak here is an F-01 bug |
| 5. Leave and start | The two closing mutations | Start must be enforced by the UPDATE policy, not by hiding the button |

**Prerequisites:** F-01 landed (done). Two accounts for testing — three sharpen the negative cases; `f02-test-1/2/3@example.com` already exist.
**Estimated effort:** ~2–3 sessions across 5 phases; phases 3 and 4 carry most of the work.

## Open Risks & Assumptions

- **6-digit codes shrink the keyspace to 10⁶ on an unrate-limited endpoint.** The code is the sole entry credential and `join_tournament` resolves it with RLS bypassed. Only lobby tournaments are joinable and a camp runs few at once, but enumeration is reachable by a script in a way 8 characters was not. Rate limiting is deferred to S-03 — this is the assumption most worth revisiting before real players use it.
- **Creating a tournament is not atomic** and F-01 has no `create_tournament` function; a failure between insert and enrolment leaves a memberless tournament that its creator can still see and start.
- **Every F-01 policy is unverified until this slice runs.** The plan spreads that verification across phases deliberately, but a policy defect found in Phase 4 is an F-01 fix, not an S-01 one, and may interrupt this plan.
- **Polish product UI alongside English auth screens** leaves the app mixed-language until someone translates the rest.

## Success Criteria (Summary)

- A player creates a tournament, shares the link, and a second player — starting signed out — ends up on the same roster without being told the code separately.
- Both see the roster change without reloading; a member can leave; the creator starts and further joins are refused.
- No player can see, or act on, a tournament they neither created nor joined — verified directly, not assumed.
