---
date: 2026-07-31T19:02:41+02:00
researcher: Wikcio1618
git_commit: adac1caa09bc74b667d38d5032b27986a7c69dc2
branch: master
repository: Wikcio1618/prisoners-dilemma-tournament
topic: "Round-robin pairing generation for S-02"
tags: [research, codebase, pairing, matches, rls, security-definer, identity, s-02]
status: complete
last_updated: 2026-07-31
last_updated_by: Wikcio1618
---

# Research: Round-robin pairing generation for S-02

**Date**: 2026-07-31T19:02:41+02:00
**Researcher**: Wikcio1618
**Git Commit**: adac1caa09bc74b667d38d5032b27986a7c69dc2
**Branch**: master
**Repository**: Wikcio1618/prisoners-dilemma-tournament

## Research Question

How should S-02 generate round-robin pairing? Specifically: all matches at start or one round at a time; how pairings are written given `matches` has no INSERT policy; how a player's identity can be displayed; and what must be true of `matches` before S-03 can open a live match room.

## Summary

**Generate every match at once, transactionally with the start.** The PRD contradicts itself, but one-sidedly: its normative sections say one shot, its descriptive Business Logic prose says round-by-round, and its own pace NFR rules out round-by-round. Round barriers are not merely awkward here — combined with the deferred forfeit decision they make one absent player halt the entire tournament permanently.

**Write pairings through a `SECURITY DEFINER` function that replaces the current status flip**, rather than adding an INSERT policy. `matches` has no column grants, so an INSERT policy would let a creator write every column including `status` and `id`, and a per-row `WITH CHECK` cannot express "this is a complete, correct round-robin". More decisively: if the flip and the pairing are separate calls and the second fails, the tournament is **permanently bricked** — every recovery policy requires `lobby`.

**There are no display names anywhere**, not even a mechanism to obtain one: signup collects only email and password, `auth.users` is unreachable three ways over, and **no `service_role` key exists**, so the usual server-side escape hatch is unavailable without provisioning a new secret. S-02 needs this more than S-03 does, because its own outcome — "every player then sees their pairing" — is unreadable as truncated UUIDs.

**The biggest unowned gap is move persistence.** S-04 needs the round-by-round move history, the Durable Object is the only component that knows the moves, and it holds no database client and no credential. No slice currently owns bridging that.

## Detailed Findings

### The pairing model: one shot, resolved

The contradiction is real and not terminological. Business Logic genuinely means tournament-rounds, settled by `prd.md:95` — *"A player encounters the pairing output at the start of each round, when they see who their **next opponent** is"* — which is incoherent under a rounds-within-a-match reading, since the opponent is constant across all `rounds_per_match` exchanges.

Four independent lines of evidence resolve it toward one shot:

1. **The pace NFR forbids barriers.** `prd.md:84`: *"no player's progress is blocked or corrupted by another player's pace or absence."* Generating round N+1 requires round N complete — a global join across all ⌊n/2⌋ concurrent matches. At n=50 that is 25 pairs that must all finish before anyone advances, 49 times over.
2. **No forfeit means a barrier is unrecoverable.** `prd.md:70` defers forfeit/timeout out of MVP — *"an absent player is handled socially (counselor intervenes) for v1"*. With a round barrier, one abandoned match means round N never completes and **the tournament halts forever**. Under one shot, the same abandonment strands exactly one pair.
3. **The roster is frozen after start**, so incremental pairing's reason for existing does not apply. Three shipped mechanisms: the membership-delete policy requires `lobby` (`20260731163754:17-30`), `join_tournament` raises `tournament_already_started` (`20260729192744:54-57`), and FR-002 states the join window closes on start. Recomputing from "currently active players" each round would produce, every time, exactly the schedule computable at t=0.
4. **The zero-balanced score requirement presupposes uneven completion.** `prd.md:93` asks for a score *"weighted so that playing more matches doesn't itself confer an advantage"*. In a completed round-robin everyone plays n−1 matches and that weighting is a no-op — it is only meaningful if players finish **different numbers** of matches, which is what one-shot generation plus no-forfeit produces.

**"No repeat opponent" is automatic.** A round-robin is by definition the schedule where every unordered pair occurs exactly once; `prd.md:91`'s constraint restates the definition rather than adding one. It is a live constraint only for greedy/Swiss pairers, which can strand the last two unpaired players having already met. Keep `matches_tournament_pair_uniq` as a generator backstop — a bug surfaces as `23505` rather than as silent duplication corrupting the score.

**Rounds survive as presentation, not synchronisation.** The circle method computes the whole n−1-round schedule from the player list alone, needing no results. Stamping each match with a round ordinal gives the UI "your next opponent" instead of a wall of 49 names — recovering the Business Logic *experience* while dropping only the global barrier the NFR forbids.

### Scale and degenerate counts

C(50,2) = **1225 matches**, 49 rounds × 25 concurrent. Not a problem for the schema (narrow rows, indexed on `tournament_id`), and explicitly accepted at `prd.md:68`.

**Not a problem for F-02 either**, which is the intuitive worry: Durable Objects are created lazily via `idFromName`, so 1225 rows create **zero** objects. At most 25 are live at once, and each wipes its own storage when terminal.

The real cost is the UI — 49 opponents is a directory, not a next action, which is the argument for the round ordinal.

**Degenerate counts, given nothing enforces a minimum:**

| n | matches | note |
| --- | --- | --- |
| 1 | 0 | flips to `started` and is instantly complete-but-empty; `finished` is unreachable through RLS, so it is stuck forever |
| 2 | 1 | the two designs are identical here — a manual test with 2 players cannot distinguish them |
| 3 | 3 | one shot needs no byes |
| 50 | 1225 | 49 matches per player |

S-02 should add a **≥2-player gate** regardless of which model wins.

**Byes are a round-based problem only, and the schema fights them.** `player_b_id` is `NOT NULL`, and even without that, `least`/`greatest` ignore NULLs — so two byes for the same player both key to `(tournament_id, a, a)` and the second collides. Byes would have to live outside `matches`.

**Also foreclosed:** the normalised-pair index is lifetime-scoped, so the same pair can *never* meet twice in a tournament. That rules out a double round-robin — worth noting since `shape-notes.md:61` grounds the product in Axelrod, whose tournaments ran the round-robin five times.

### The write path: a definer function replacing the flip

**`matches` has no grants anywhere in the repo.** Exhaustive check across all nine migrations: the only privilege statements are the `private` schema grants, the `tournaments` column grant, and function-execute grants. So `authenticated` holds Supabase's stock `ALL PRIVILEGES` on `matches` — which is precisely why the `tournaments` revoke exists (`20260729174939:161-166`).

**Consequence: RLS is the sole gate, and an INSERT policy would be materially unsafe.**

- A `WITH CHECK` is evaluated per candidate row and **cannot see the set**, so it can never express "this is a complete, correct round-robin over the roster". A creator could insert a partial bracket, or pair themselves only against the weakest player, or keep adding matches after play begins.
- Every column would be writable — a creator could insert rows with `status = 'finished'`, a chosen `id`, or a backdated `created_at`. Closing that needs the column-grant dance *in addition to* the policy.
- Combined with the missing FK, a creator could name any user in `auth.users`.

**By contrast, a definer function makes the write content entirely non-attacker-controlled**: pairings are derived server-side from `tournament_players`, so the caller cannot choose opponents, omit matches, name a non-member, or pre-set any column. The caller passes a uuid and nothing else.

**Atomicity is the decisive argument.** If the flip succeeds and pairing fails, there is **no recovery path at all**:

| Escape | Blocked by |
| --- | --- |
| Members leave | delete policy requires `lobby` |
| Creator rolls back to lobby | update policy `USING` requires `lobby` |
| Creator deletes the tournament | delete policy requires `lobby` |
| New players join | `join_tournament` raises `tournament_already_started` |

A `started` tournament with no matches is **permanently bricked**. Note this is strictly worse than the create-tournament case, which has a compensating delete precisely because the tournament is still in `lobby`.

Inside a `SECURITY DEFINER` function owned by the migration role, policies on `tournaments` are not consulted and the column grant is irrelevant — the same mechanism by which `join_tournament` already inserts into a table with no INSERT policy. So one function can gate, pair and flip in a single transaction.

**A bypass to close alongside it:** leaving `tournaments_update_creator_in_lobby` and `grant update (status)` alive means a bare `PATCH` could still reach `started` without pairing, manufacturing the bricked state. Dropping both makes the function the sole `lobby → started` path — mirroring `tournament_players`' "no INSERT policy, one function" shape. The tradeoff is that the creator-only check migrates from a production-verified policy into PL/pgSQL and must be re-verified.

**Runner-up worth recording:** an `AFTER UPDATE` trigger on `tournaments` gated on `lobby → started` gives atomicity for free and makes it structurally impossible to reach `started` without a pairing, including via a direct `PATCH`. Against it: no trigger precedent exists in this codebase, and these migrations consistently prefer named entry points over implicit side effects.

### The missing FK, and why it is an atomicity problem in disguise

`matches.player_a_id`/`player_b_id` reference `auth.users`, not membership. `tournament_players` has PK `(tournament_id, user_id)`, so a composite FK works directly and is index-served, and `matches` is empty so validation is instant.

**What breaks without it** is worse than "bad data":

1. A match naming a non-member is **invisible to that non-member** — `matches_select_member` keys on tournament membership.
2. Once S-03 adds its membership check, the failure inverts: they are **locked out of a match they are formally assigned to**, their opponent waits in a room that never fills, and no forfeit path exists. A permanently hung match.
3. The pairing is silently arithmetically wrong, so the zero-balanced score is computed over an inconsistent denominator.

**The realistic cause is a race, not a bug.** A non-creator may leave while `lobby`. If pairing reads the roster and writes matches non-atomically with the flip, a player leaving in between is paired but gone — no defect in the pairing code required. This is why the FK and the atomicity requirement are the same requirement.

**Decide the delete action explicitly.** `cascade` means a leaving player deletes their matches — harmless today (leaving is lobby-only, matches exist only after start) but live the moment a creator-kick path lands. `restrict` protects history but would block a kick. This is the retention question F-01's review deferred to S-04; S-02 should state its choice rather than inherit `cascade` by default.

**Side effect on types:** two FKs from `matches` to the same parent makes PostgREST embedding ambiguous, requiring hint syntax. Nothing embeds today; S-03 wanting opponent info would hit it.

### Identity: nothing exists, and the usual escape hatch is unavailable

**Three independent blocks on `auth.users`:** it is not in `config.toml`'s exposed `schemas`; no grant on it exists in any migration; and **no `service_role` key is configured** — `astro.config.mjs` declares exactly two secrets and CI syncs only those. So even a server-rendered page cannot call `auth.admin.listUsers()` without provisioning a new secret through CI, Cloudflare and local env.

**There is also nothing to display.** `signup.ts` collects only email and password, with no `options.data` metadata. A grep for `profile|display_name|username|nickname` across `src/`, `supabase/` and `context/foundation/` returns **zero hits** — the concept does not exist even in planning.

| Option | Cost | Touches `join_tournament`? | Backfill |
| --- | --- | --- | --- |
| `public.profiles` + trigger | migration, RLS policy needing a **second definer helper** to avoid `42P17`, plus a PostgREST embed problem (FK points at `auth.users`, not `profiles`) | no | **yes, mandatory** |
| Name on `tournament_players` at join | new function signature + grants + caller change; or the function reads `auth.users` itself (it can — it is definer-owned) | **yes** | rows only |
| View over `auth.users` | cheapest on writes, riskiest on coupling; with `security_invoker` it returns nothing, without it it exposes every email | no | no |
| Deterministic pseudonym from uuid | zero migration | no | no |

**Privacy, stated plainly.** The persona is *"a youth-camp participant, age roughly 15-40"* under a flat model with no admin role. The cheapest options mean **every player sees every other player's email** — frequently `firstname.lastname@`, durable off-platform contact handles, for a group including minors. It also hands players exactly the contact channel `prd.md:106` deliberately declined to build (*"No in-app chat or messaging between players"*), in a form the app cannot moderate. **Do not default a display name to the email in any option.** Whatever the read policy, scope it to co-members via a `my_tournament_ids`-style helper, never `using (true)`.

**S-02 or S-03?** US-01 is formally S-03's. But S-02's own stated outcome — *"every player then sees their automatically generated round-robin pairing"* — does not survive rendering as `3f8a2b91`, and the lobby already ships that gap today (`LobbyRoster.tsx:94`). S-02 is also already writing a migration, so bundling avoids two migrations touching membership in the same week.

### What S-03 needs, and the gap nobody owns

**The match room validates nothing about matches.** Exhaustively, `worker.ts` checks: UUID shape, authenticated, and forwards the user id as a header. `match-room.ts` imports only `DurableObject` — **no code in the repository reads or writes `matches` at all.** Seating is first-come-first-served among any logged-in users; identity binding makes reconnection safe but says nothing about entitlement.

S-03's membership check is expressible with no new grant — `worker.ts` already builds an authenticated client, and `matches_select_member` scopes the read. Two caveats: the round-trip must precede `idFromName` (which is also what stops arbitrary UUIDs minting billed objects — a benefit), and the policy admits **any tournament member**, so the `user.id in (player_a_id, player_b_id)` test must be written in the Worker, not delegated to RLS.

**Rounds are absent from both schema and room.** No round column, no rounds table, no `rounds_per_match` snapshot. F-02 plays exactly one round and is terminal by construction; storage keys are `move:a`/`move:b` with **no round dimension**. S-03 must re-key or hold the loop in the DO.

**The largest unbuilt piece: move persistence, and it has no owner.** S-04 needs the complete round-by-round move sequence for forgiveness and initial aggression. The DO is the only component that knows the moves and it holds **no database client and no credential**. The three conceivable routes are: give the DO a service credential (does not exist), have each client write its own move under RLS (reintroduces the hidden-move problem at the database layer), or broker through a trusted Astro route. **None is designed.**

**`matches.status` is provisional and this is the last cheap moment.** The constraint swap is instant only while the table is empty, and S-02 is what makes it non-empty. Three problems: no round dimension (so Postgres cannot answer "where was I?" after a deploy drops a socket); no terminal-but-unplayed state, so an abandoned match is indistinguishable from one never started and S-04's "tournament concluded" signal never fires; and nothing can currently move a row off `pending` at all, since `matches` has no UPDATE policy and the DO has no credential. The DO *already* has an abandonment concept — a 30-minute alarm — but writes nothing to Postgres, so the expiry is invisible to the tournament.

## Code References

- `supabase/migrations/20260729164628_tournament_tables.sql:64-85` — `matches` shape, distinct-players check, normalised-pair unique index
- `supabase/migrations/20260729174939_tournament_rls.sql:150-156` — the only policy on `matches`; explicit note that S-02 decides the write path
- `supabase/migrations/20260729174939_tournament_rls.sql:27-51` — `private.my_tournament_ids()`, the recursion-breaking helper and its two required grants
- `supabase/migrations/20260729174939_tournament_rls.sql:161-166` — the revoke/grant pair proving `authenticated` holds stock privileges by default
- `supabase/migrations/20260729192744_join_tournament_membership_shortcircuit.sql:14-81` — the live `join_tournament` body; the template a pairing function should copy
- `supabase/migrations/20260729192557_tighten_tournament_update_policy.sql:25-28` — `lobby → started` only; why rollback is impossible
- `supabase/migrations/20260729193532_match_status_text_check.sql:14-32` — provisional status vocabulary, and the note that swapping it is instant only while empty
- `supabase/migrations/20260731163754_creator_cannot_leave_own_tournament.sql:17-30` — membership deletes are lobby-only
- `src/pages/api/tournaments/[id]/start.ts:29-33` — today's bare UPDATE, to be replaced by an RPC
- `src/pages/api/tournaments/join.ts:41-48` — the RPC + `error.details` calling convention to follow
- `src/lib/tournament.ts:74-86` — `JOIN_TOURNAMENT_ERRORS` and its narrowing guard; the pattern for a `START_TOURNAMENT_ERRORS`
- `src/worker.ts:29,41-44,53-64` — every check the match room performs before seating
- `src/durable/match-room.ts:1` — imports only `DurableObject`; no database client anywhere
- `src/components/tournament/LobbyRoster.tsx:94` — truncated UUID rendering, the shipped identity gap
- `src/db/database.types.ts:106-111` — no views, one function: the entire client-visible surface
- `supabase/config.toml:13` — exposed schemas; why `auth` is unreachable

## Architecture Insights

- **One owned write path per table.** `tournament_players` has no INSERT policy and exactly one definer function. Applying the same shape to `matches` keeps the access story uniform and makes the write content non-attacker-controlled.
- **Policies gate *who*; definer functions gate *what*.** A `WITH CHECK` is per-row and set-blind, which is why set-level invariants like "a complete round-robin" belong in a function.
- **Irreversibility concentrates at `started`.** Every recovery policy requires `lobby`, so any operation that crosses that boundary must be atomic or it can strand the tournament.
- **The PRD's normative and descriptive sections disagree**, and Success Criteria plus Functional Requirements should win over Business Logic prose. Worth remembering for later slices.
- **Deferred decisions accumulate at the schema.** `matches.status`, the FK delete action, and the round vocabulary are all "cheap now, expensive once rows exist" — and S-02 is the slice that creates the rows.

## Historical Context (from prior changes)

- `context/changes/tournament-data-model/plan.md` — the `matches` contract and its Addendum; the deliberate decision to leave the write path to S-02
- `context/changes/tournament-data-model/reviews/impl-review.md` — F6 (unindexed player FKs) and F10 (cascade retention deferred to S-04); the composite-FK recommendation originates here
- `context/changes/create-and-join-tournament/plan.md:57` — the non-atomic create precedent and its compensating delete, the pattern that does *not* generalise past `started`
- `context/changes/create-and-join-tournament/reviews/impl-review.md` — F4/F7 made the zero-player start concretely reachable; F2 records the accepted join-code risk
- `context/changes/realtime-match-scaffold/plan.md:39` — F-02's explicit deferral of the match-existence and membership checks to S-03
- `context/changes/realtime-match-scaffold/change.md:34-35` — the recorded statement that membership verification "needs rows that S-02 has yet to write"

## Related Research

None — this is the first research artifact in this repository. Prior changes went straight from `/10x-new` to `/10x-plan`.

## Open Questions

1. **Does the facilitator want the room synchronised on purpose?** Everyone plays round 1, the counselor talks for two minutes, then round 2. If so the barrier is a *feature* and the NFR was written without that ritual in mind — this is the one thing that would flip the recommendation. It is a product question the documents cannot answer.
2. **Who owns move persistence?** S-04 needs the move history; the DO holds it and has no credential; no slice currently owns the bridge. This should be assigned before S-03 starts, not discovered during it.
3. **Does S-02 take on display names, or ship pairings against UUIDs?** Its own outcome statement argues for taking it on; the roadmap assigns US-01 to S-03.
4. **`cascade` or `restrict` on the new composite FK?** Tied to the account-deletion retention question already deferred to S-04, and to whether a creator-kick path is coming.
5. **Is a 50-player round-robin actually playable?** 49 matches × 10 rounds = 490 hidden-move exchanges per player, up to 980 at the maximum round count. Against `prd.md:24`'s "fast enough to run many rounds without losing the room", this is hours of play. Neither pairing model fixes it; it is a format question that S-02 makes visible.
