---
project: "Prisoner's Dilemma Tournament"
version: 1
status: draft
created: 2026-07-22
context_type: greenfield
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: 2026-08-19
  after_hours_only: true
---

# Prisoner's Dilemma Tournament — PRD

## Vision & Problem Statement

No dedicated app exists for running a closed, iterated Prisoner's Dilemma tournament with automatic pairing and post-tournament behavioral statistics (e.g., forgiveness, initial aggression). A camp counselor or educator who wants to teach game theory experientially is stuck running it manually — paper or whiteboard bookkeeping for hidden choices and running scores across many pairings is slow, error-prone, and burns the group's energy and attention on operations instead of the emerging strategic patterns that are the actual teaching point.

The insight: it is specifically the repeated, aggregated tournament structure — not a single round — that surfaces strategic patterns (like tit-for-tat or forgiveness) worth discussing. That structure only becomes pedagogically useful if the tooling is fast enough to run many rounds without losing the room; paper-based play is too slow to reach that point.

Note: the domain rule (pairing + statistics) does not need to change at scale — a single tournament is never expected to exceed ~50 concurrent players (a camp-group-sized cap; possibly configurable, possibly hardcoded for MVP).

## User & Persona

Primary persona: a youth-camp participant, age roughly 15-40, playing within a session-driven group activity. They are introduced to game theory through a hands-on, iterated Prisoner's Dilemma tournament, and afterward reflect on the strategic patterns — their own and others' — to draw connections to real-life decision-making.

No secondary persona. The counselor/facilitator uses the same app and view as any other player; their distinct value-add is leading the post-tournament debrief using the app's statistics, which requires no special access or role.

## Success Criteria

### Primary
- A logged-in player can create a tournament session (setting a fixed round count per match), share a join code/link, have ≥2 players join, manually start the tournament, have round-robin pairing generated automatically, play each match's rounds with hidden-until-both-commit simultaneous choices, have results persisted as they happen, and reach a concluded tournament with generated statistics (scores + behavioral stats like forgiveness and initial aggression).

### Secondary
- Players can see their own match history/results after the tournament concludes.

### Guardrails
- A player can never see the opponent's choice before both players have committed for that round.
- Round-robin pairing must guarantee no player is ever paired against themselves.
- In-progress match/tournament state and scores survive a dropped connection or page refresh — session data is not lost mid-tournament.

## User Stories

### US-01: Player starts and plays a match round

- **Given** a player is in an active tournament with a pairing generated for them
- **When** they see their next opponent's identity and click "Start match", then for each round submit a choice of "Współpraca" (Cooperate) or "Sabotaż" (Sabotage)
- **Then** the match proceeds round by round, with each round's outcome revealed to both players only after both have committed a choice

#### Acceptance Criteria
- The opponent's identity is visible before the match starts
- A player cannot submit a round choice without an active, started match
- Choice labels are rendered in Polish ("Współpraca" / "Sabotaż")
- A round's outcome (both moves) is withheld from both players until both have submitted

## Functional Requirements

- FR-001: Player can create a tournament session, setting a fixed number of rounds per match. Priority: must-have
  > Socrates: Counter-argument considered: "an unbounded round count could let a creator pick something absurd (e.g. 1000), stalling the session." Resolution: round count is validated at creation against a sensible min/max range; exact bounds are a downstream detail.
- FR-002: Player can join an existing tournament session via a join code/link. Priority: must-have
  > Socrates: Counter-argument considered: "late joiners after pairing has started would break round-robin fairness." Resolution: the join window closes once the creator starts the tournament; no new players can be added mid-tournament.
- FR-003: Tournament creator can manually start the tournament once players have joined, triggering automatic round-robin pairing. Priority: must-have
  > Socrates: Counter-argument considered: "round-robin match count grows O(n²), which may not scale to large groups." Resolution: accepted for MVP — round-robin is fine for realistic camp-sized groups; very large tournaments are out of scope (captured as a non-goal).
- FR-004: Player can play a match against a paired opponent from the tournament. Priority: must-have
  > Socrates: Counter-argument considered: "no forfeit/timeout means an absent opponent leaves the other player stuck indefinitely." Resolution: deferred to nice-to-have, not in MVP — for a facilitator-supervised camp session, an absent player is handled socially (counselor intervenes) for v1.
- FR-005: Player can submit a move (cooperate or defect) for a round without the opponent seeing it before they commit. Priority: must-have
  > Socrates: No counter-argument; it stands as written.
- FR-006: Player can see the opponent's move for a round once both players have committed. Priority: must-have
  > Socrates: No counter-argument; it stands as written.
- FR-007: Player can see the round-by-round history of the current match while it is in progress (moves and outcomes so far). Priority: must-have
  > Socrates: No counter-argument; it stands as written.
- FR-008: Player can see the final statistics and scoreboard after the tournament concludes — score, matches played, initial aggression and forgiveness, each exactly as defined in Business Logic → **Scoring specification**. Priority: must-have
  > Socrates: No counter-argument; it stands as written.

## Non-Functional Requirements

- All player-facing UI text is presented in Polish (e.g., move choices labeled "Współpraca" / "Sabotaż").
- Every round outcome and score change is presented so the player immediately feels the stakes and rivalry of the moment — a friendly, dopamine-inducing sense of competition, not a passive log entry.
- The tournament stays fully usable when pairs progress at very different speeds, and when a player leaves; no player's progress is blocked or corrupted by another player's pace or absence.
- A player's statistics are framed around what they reveal about that player's own playstyle and tendencies across the tournament, not just raw score/rank.

## Business Logic

The app determines each round's opponent pairings from the tournament's active player list and each player's match history so far, and derives every player's score and behavioral statistics from their full recorded move history. The operational definitions of those derived values are specified below under **Scoring specification**.

**Inputs.** Pairing draws on the list of players currently active in the tournament and each player's match history within that tournament (who they've already played), so no player is paired against an opponent they've already faced or against themselves. Statistics draw on every match a player has recorded in the tournament — the complete round-by-round sequence of their own and their opponents' moves.

**Output.** Pairing produces a list of opponent pairs for the upcoming round. Statistics produce a set of calculated metrics per player: a score, the number of matches they played, and two behavioral classifications derived from move patterns — initial aggression and forgiveness. All four are defined operationally under **Scoring specification** below.

**Product flow.** A player encounters the pairing output at the start of each round, when they see who their next opponent is. They encounter the statistics output once the tournament concludes, on the final scoreboard/summary.

### Scoring specification

Ratified 2026-08-01. This subsection is the sole authority for every derived value on the scoreboard. It exists because the earlier prose named the outputs without defining them, which meant no expected value could be computed from the PRD alone — and a statistic that can only be derived from its own implementation cannot be checked against anything.

**Payoff matrix.** Each round awards each player points from their own move and their opponent's, using the standard Axelrod values:

| Own move | Opponent's move | Points to you |
| --- | --- | --- |
| Współpraca | Współpraca | **3** |
| Sabotaż | Współpraca | **5** |
| Współpraca | Sabotaż | **0** |
| Sabotaż | Sabotaż | **1** |

These satisfy both constraints that make this a Prisoner's Dilemma rather than an arbitrary game: `T > R > P > S` (5 > 3 > 1 > 0), so defecting against a cooperator is individually best and mutual defection beats being exploited; and `2R > T + S` (6 > 5), which is what makes sustained mutual cooperation beat alternating exploitation over repeated rounds. Change either constraint and the strategic patterns the tournament exists to teach stop appearing.

**Score.** The plain sum of a player's points across every round they played in the tournament.

> **The "zero-balanced" weighting requirement is withdrawn**, deliberately, on 2026-08-01 — not lost. It was never formalized (it was deferred in `shape-notes.md` and never resolved), and when the round robin completes it ranks identically to any per-round average, because every player plays the same number of matches. Its only effect would be on an incomplete tournament, where the honest fix is showing how much each player actually played rather than hiding it inside a weighting nobody can interpret. See **Matches played**.

**Matches played.** Displayed alongside every score, always. With no forfeit or timeout handling in MVP (see FR-004) and the free-pacing NFR, players can finish different numbers of matches, so a raw total can favour volume over skill. Surfacing the count lets the facilitator see and explain that during the debrief instead of being misled by it. A worked example: a player with 19 points from 7 rounds is ahead on the board of one with 14 points from 5, while being behind on points per round (2.71 vs 2.8).

**Initial aggression.** The fraction of a player's matches in which their *first* move was Sabotaż:

> (matches whose first move by this player was Sabotaż) ÷ (matches in which this player played at least one round)

**Undefined when the denominator is zero** — a player who played no rounds has no initial aggression, which is not the same as zero.

**Forgiveness.** How often a player answered a defection with cooperation. Consider every round *i* within a match where the opponent played Sabotaż at round *i−1* and round *i* exists; forgiveness is the fraction of those in which this player played Współpraca at round *i*.

**Undefined when the player was never provoked.** Note that a match's final round is never a provocation, because no round follows it — a player who defects only on the last round has provoked nobody.

**Rendering undefined values.** Any undefined statistic renders as `—`. Never as `0`, which reads as "never aggressive" or "never forgives" and is the opposite of the truth in the forgiveness case; never as `1.0`; and never by omitting the player from the board.

## Access Control

Login required (email/password or OAuth) — accounts persist across camp sessions so players and counselors can return over time. Flat user model: no organizer/admin role. Any logged-in user can start a tournament or join one; there is no elevated permission needed to manage pairing, rounds, or view statistics.

## Non-Goals

- **No tournaments larger than ~50 players.** The product targets a single camp-group scale, not large or public tournaments.
- **No cross-tournament global leaderboards.** Statistics and rankings stay scoped to a single tournament; there is no persistent cross-tournament ranking system.
- **No spectator mode for non-players.** Only participants can view live match state; there is no public/spectator viewing.
- **No in-app chat or messaging between players.** The only player-to-player communication is the move choices themselves.

## Open Questions

1. **Is the ~50-concurrent-player tournament cap configurable (e.g. via a flag) or hardcoded for MVP?** — Owner: user. By: n/a (non-blocking; can be resolved during implementation planning).
