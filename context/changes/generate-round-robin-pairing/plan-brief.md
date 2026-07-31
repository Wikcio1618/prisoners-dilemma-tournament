# Generate Round-Robin Pairing — Plan Brief

> Full plan: `context/changes/generate-round-robin-pairing/plan.md`
> Research: `context/changes/generate-round-robin-pairing/research.md`

## What & Why

Roadmap **S-02**. Starting a tournament generates the complete round-robin schedule in one transaction, and every player is then shown exactly one opponent to go and find — the same person that opponent is being told to find. This turns S-01's tournament shell into something with actual matches in it, and unblocks S-03.

## Starting Point

S-01 shipped create, join, lobby, leave and start, all live in production. The start button already flips `lobby → started`. What is missing is everything behind that flip: `public.matches` exists but is empty and has **no write path at all**, there are **no display names anywhere**, and nothing constrains a match's players to be members of its tournament.

## Desired End State

A creator with at least two players presses start. Every pairing is created in the same transaction as the status flip, so a `started` tournament always has a complete schedule. Each player opens the tournament and sees one name: who to go and play. That person sees them back. Faster players are never blocked by slower ones.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Pairing model | All matches at start | The PRD's pace NFR forbids round barriers, and with no forfeit in MVP one absent player would halt the whole tournament permanently. | Research |
| Synchronised rounds | No — independent pacing | Confirmed the facilitator does not want a paced room, so the barrier stays out. | Plan |
| Write path | `SECURITY DEFINER` function replacing the status flip | Starting is a one-way door with no recovery, so flip-then-pair as separate calls can brick a tournament permanently. | Research |
| Route to `started` | Function only — drop the policy, revoke the grant | Makes a schedule-less `started` tournament structurally unreachable rather than merely unlikely. | Plan |
| INSERT policy on matches | Rejected | No column grants exist, so a policy would let a creator write `status`/`id`; and a per-row `WITH CHECK` cannot express "a complete round-robin". | Research |
| Composite FK delete action | `restrict` | Match history becomes immutable once pairing exists, and the leave-during-pairing race fails loudly instead of silently deleting matches. | Plan |
| `round_number` | Yes — circle method | Reversed mid-planning: showing exactly one opponent requires the pairing to be *mutual*, which is what the ordinal provides. | Plan |
| `matches.status` | Add `abandoned` | Without a terminal-but-unplayed state, a no-show is indistinguishable from a match never started and S-04's conclusion signal never fires. | Plan |
| Minimum players | 2 | Closes the confirmed hole where a 1-player tournament starts, generates nothing, and is stuck forever. | Plan |
| Display names | In scope for S-02 | S-02's own outcome — "every player sees their pairing" — is unreadable as `3f8a2b91`. | Plan |
| Name fallback | Pseudonym from user id, never email | Persona includes minors; emails are durable contact handles and the PRD explicitly declines to give players a contact channel. | Research |
| Move persistence | Flagged, not designed | S-03 owns match play and will have more information; recorded so it is a plan item there, not a blocker. | Plan |

## Scope

**In scope:** `round_number` and `abandoned` on `matches`; composite FKs with `restrict`; a `start_tournament()` definer function doing gate + generate + flip atomically; dropping the update policy and column grant; rewriting the start route as an RPC; a `profiles` table with trigger, backfill and co-member read policy; a display-name field at signup; the single-opponent view.

**Out of scope:** match play and moves (S-03); move persistence design; scoring and statistics (S-04); concluding a tournament; forfeit/timeout; a full-schedule view; creator-kick; rate limiting; double round-robin.

## Architecture / Approach

```
start button ─POST→ /api/tournaments/[id]/start
                      └─rpc→ start_tournament(uuid)   ← SECURITY DEFINER, one transaction
                               ├ auth + creator check + FOR UPDATE lock
                               ├ idempotent short-circuit if already started
                               ├ gate: >= 2 players
                               ├ circle-method schedule → INSERT into matches
                               └ flip status to 'started'

tournament page (started) ──→ the caller's lowest-numbered unplayed match
                                └─ opponent's display_name from profiles
```

`matches` keeps zero write policies — one owned write path, the same shape `tournament_players` already has. The caller passes a uuid and nothing else, so the write content is entirely server-derived.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Pairing schema & generation | Migration + `start_tournament()`; matches exist | A second definer function, and the creator-only check moves out of a verified policy into PL/pgSQL |
| 2. Wire the start route | RPC call with Polish failure messages | Small; the failure-token mapping is the only substance |
| 3. Player identity | `profiles` + trigger + backfill + co-member policy | A `using (true)` policy would make every camper enumerable; the read policy needs a `private` helper or it recurses |
| 4. Opponent view | One opponent, mutually consistent | Mutuality is the point of the slice and only shows up with 4 accounts side by side |

**Prerequisites:** S-01 landed and deployed (done). Four test accounts — three exist (`f02-test-1/2/3@example.com`); two accounts cannot distinguish a correct schedule from a broken one.
**Estimated effort:** ~3 sessions across 4 phases; Phase 1 and Phase 3 carry the migrations and most of the risk.

## Open Risks & Assumptions

- **The creator-only start check leaves a production-verified policy for PL/pgSQL.** It must be re-verified by hand, including that a non-creator gets the same token as a nonexistent tournament — otherwise the function becomes an existence oracle.
- **`restrict` deliberately blocks a future creator-kick path** until someone decides what kicking should do to match history. That is the point, but it is a constraint on later slices.
- **Move persistence still has no owner.** S-04 needs the move history; the Durable Object holds it and has no credential; no `service_role` key exists. Assigned to S-03 but undesigned.
- **A 50-player round-robin may not be playable** — 490 hidden-move exchanges per player, up to 980. Neither pairing design fixes it; it is a format question this slice makes visible.
- **Independent pacing means the named opponent may be mid-match** with someone else. The UI says who to find, not that they are waiting.

## Success Criteria (Summary)

- Starting a 4-player tournament creates exactly 6 matches, each pair once, across 3 clean rounds.
- Every player sees exactly one opponent, and two players in the same round see each other.
- A 1-player start, a non-creator start, and a double start are each refused without corrupting state.
