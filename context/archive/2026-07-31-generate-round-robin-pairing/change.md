---
change_id: generate-round-robin-pairing
title: Generate round robin pairing
status: archived
created: 2026-07-31
updated: 2026-08-03
archived_at: 2026-08-03T19:58:36Z
---

## Notes

Roadmap S-02. Outcome: the creator manually starts the tournament once players have joined,
and every player then sees their automatically generated round-robin pairing.
Prerequisites: S-01, which has landed and is deployed.

### What S-01 already did, and what it left for this slice

Starting a tournament **already exists** — `POST /api/tournaments/[id]/start` flips
`lobby → started` and closes the join window, verified in production. S-02 owns what happens
*behind* that flip: generating the pairing. The button, the policy, the column grant and the
already-started idempotency are done.

### Binding constraints inherited from F-01 and S-01

Sources: `context/changes/tournament-data-model/plan.md` (`## Addendum`),
`context/changes/create-and-join-tournament/plan.md`, and the `reviews/impl-review.md` in both.

- **`matches` is empty but fully constrained.** Normalised-pair unique index
  (`tournament_id, least(a,b), greatest(a,b)`) so (A,B) and (B,A) cannot coexist; a CHECK that
  `player_a_id <> player_b_id`; FKs to `auth.users` cascading on delete. Pairing must satisfy
  all three — the schema already enforces the PRD's "never paired against themselves" guardrail.
- **`matches.status` is `text` + `matches_status_check`**, not an enum, specifically so S-02 can
  redefine the vocabulary cheaply. Current provisional values: `pending | in_progress |
  finished`. Changing them is a constraint swap, not a type recreation.
- **`matches` has no INSERT policy.** Nothing can write pairings yet. S-02 must decide how they
  are written — a `SECURITY DEFINER` function (following `join_tournament`) or a new policy.
  This is the central design decision of the slice.
- **`matches.player_a_id` / `player_b_id` are indexed** but there is **no FK to
  `tournament_players`**, so nothing currently stops a match naming a non-member. F-01's review
  flagged a composite FK to `(tournament_id, user_id)` as the fix; S-02 is the first slice that
  can act on it.
- **`status = 'finished'` is unreachable through RLS by design.** The UPDATE policy permits only
  `lobby → started`. Concluding a tournament needs a definer function that nobody has written —
  S-04's, unless S-02 needs it sooner.
- **Nothing enforces a minimum player count.** A creator can start a 1-player tournament today;
  `LobbyRoster` only *hints* at needing two. Pairing inherits that.

### Open gap that likely lands here

- **There are no display names.** `tournament_players` stores only `user_id`, `auth.users` is not
  client-readable, and the lobby renders truncated ids. US-01 requires the opponent's identity to
  be visible before a match starts — so a `profiles` table (or equivalent) is probably S-02's to
  introduce, not S-03's.

### Deferred S-01 review findings that touch this ground

From `context/changes/create-and-join-tournament/reviews/impl-review.md`:

- **F10 — stale lobby chrome.** After a poll-detected start, the join code and buttons stay on
  screen until reload. S-02 replaces that view with the pairing, so it may resolve incidentally.
- **F8 — attacker-controlled prose in the error banner.** Any new route that redirects with a
  message inherits it; the fix is opaque error keys, done as one consistent pass.
- **F3 — unbounded creation exhausts the join-code space.** Unrelated to pairing but still open.
- **F2 — accepted risk**: a guessed 6-digit code grants irrevocable membership, no rate limiting
  and no creator-kick path.

### Handed to S-03 by this slice's implementation review (2026-08-01)

`reviews/impl-review.md` F1, decided as "record for S-03" rather than fixed here.

**S-03 must choose a pacing model before it marks a single match finished.** The opponent view
names the other player in the caller's lowest-numbered unplayed match. That is mutual only while
every player has completed the same number of matches — which is true today only because nothing
can mark a match finished. The moment S-03 does, a player who is ahead is sent to someone whose
own lowest unplayed match is against a third person.

This slice's plan asserted both mutual naming and free-pace progression ("players who move faster
are never blocked by players who move slower"). Under a single-named-opponent rule those are
mutually exclusive, so S-03 picks one:

- **Rounds as barriers** — mutual by construction, but a slow pair stalls everyone. Contradicts
  the PRD's pace NFR.
- **Live matching** — name an opponent only when that match is the lowest unplayed for *both*
  players, otherwise show a wait state. Preserves free pace and mutuality; cost is that players
  sometimes wait, and nobody has modelled how often at 50 players.

Manual criterion 4.6 verified mutuality only in the all-players-at-zero state, which is the one
state where it is guaranteed. Any S-03 test of this must start from an uneven completion count.
