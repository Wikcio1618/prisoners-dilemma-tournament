---
change_id: tournament-data-model
title: Tournament data model
status: impl_reviewed
created: 2026-07-28
updated: 2026-07-29
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

**2026-07-29 — implementation review** (`reviews/impl-review.md`, verdict NEEDS ATTENTION, 10 findings). Full deviation record and follow-up migration table live in the plan's `## Addendum` section.

Carried into later slices:

- **S-01** owns generating join codes server-side. The database now enforces `^[A-Z0-9]{8,}$` as a floor, but the client still supplies the value on insert, and there is no rate limit on the `join_tournament` RPC. There is also no creator-kick path, so a mis-joined member cannot be removed by anyone but themselves, and only while in lobby.
- **S-01** owns validating `rounds_per_match` against `MIN_/MAX_ROUNDS_PER_MATCH`. The database accepts any integer by explicit plan decision, and those constants currently have zero call sites.
- **S-02** owns match semantics. `public.match_status` (`pending | in_progress | finished`) is provisional and cheap to redefine while `matches` is empty. Also consider a composite FK from `matches (tournament_id, player_*_id)` to `tournament_players (tournament_id, user_id)` — nothing currently constrains a match's players to be members of its tournament.
- **S-04** owns concluding a tournament. `status = 'finished'` is deliberately unreachable through the policy layer and needs a `SECURITY DEFINER` function. S-04 also owns the retention decision behind the `matches` player-FK cascade, which currently lets one account deletion rewrite a finished tournament's standings.
