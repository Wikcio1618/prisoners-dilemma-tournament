---
change_id: create-and-join-tournament
title: Player creates a tournament and others join via code
status: impl_reviewed
created: 2026-07-30
updated: 2026-07-30
archived_at: null
---

## Notes

@context/foundation/roadmap.md

Roadmap S-01 — the north star slice. Outcome: a logged-in user can create a tournament
(setting a fixed round count) and share a join code/link that lets other logged-in players
join before it starts. Prerequisites: F-01, which has landed.

### Constraints inherited from F-01 (verify before planning)

These were decided or discovered while implementing `tournament-data-model` and are binding
on this slice. Sources: `context/changes/tournament-data-model/plan.md` (see its `## Addendum`)
and that change's `reviews/impl-review.md`.

- **Membership inserts have no RLS policy.** Every join — including the creator's own — must
  go through `public.join_tournament(p_join_code text)`. Direct inserts into
  `tournament_players` are denied by default.
- **Join codes must match `^[A-Z0-9]{8,}$`** (database CHECK, added during review triage) and
  are **client-supplied on insert** — S-01 owns generating them server-side. Codes are
  globally unique and never released, so generation needs collision retry.
- **Failure reasons come back in `error.details`**, not the message: `tournament_not_found`,
  `tournament_already_started`, `tournament_full`, `not_authenticated`. Use
  `JOIN_TOURNAMENT_ERRORS` / `isJoinTournamentError` from `src/lib/tournament.ts`.
- **`rounds_per_match` has no database constraint** by explicit decision — bounds live in
  `MIN_ROUNDS_PER_MATCH` / `MAX_ROUNDS_PER_MATCH` (1–20, default 10) and currently have zero
  call sites. This slice is the first one obliged to enforce them.
- **The 50-player cap exists in two places** — `MAX_PLAYERS_PER_TOURNAMENT` and a literal
  inside `join_tournament()` — coupled only by comments.
- **Starting a tournament is `lobby → started` only.** `status = 'finished'` is deliberately
  unreachable through RLS and needs a `SECURITY DEFINER` function that S-04 will add.

### Open from F-01's review, relevant here

- **No policy behaviour has ever been exercised by a real user.** F-01 shipped with its RLS
  deliberately unverified; this slice is where recursion, grant and visibility mistakes will
  first surface — at query time, not migration time.
- There is no creator-kick path: a member can only remove themselves, and only while in lobby.
