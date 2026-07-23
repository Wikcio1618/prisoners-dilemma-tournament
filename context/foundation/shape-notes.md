---
project: "Prisoner's Dilemma Tournament"
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
created: 2026-07-21
updated: 2026-07-22
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "primary persona"
      decision: "youth participants (age ~15-40), not the counselor"
    - topic: "pain category"
      decision: "missing capability — no app offers closed tournament with automatic pairing + behavioral statistics"
    - topic: "insight"
      decision: "iterated tournament structure (many rounds, aggregate score) reveals strategy patterns; paper-based play is too slow/boring and wastes group focus on operations instead of patterns"
    - topic: "secondary persona"
      decision: "none — counselor uses the same app as any player, leads debrief using end-of-tournament stats"
    - topic: "access model"
      decision: "login (email/password or OAuth); accounts persist across camp sessions"
    - topic: "role separation"
      decision: "flat user model — no elevated/organizer role, anyone can start or join a tournament"
    - topic: "joining mechanism"
      decision: "join code / shareable link"
    - topic: "tournament start trigger"
      decision: "creator manually starts it once players have joined"
    - topic: "rounds per match"
      decision: "fixed number set by the creator at tournament creation"
    - topic: "mvp timeline"
      decision: "3 weeks after-hours; user confirmed feasible (with AI assistance)"
    - topic: "current-match history vs full history"
      decision: "seeing the current match's round-by-round history live is must-have (FR-007); seeing full match history across the tournament stays out of MVP (Secondary)"
    - topic: "UI language"
      decision: "app UI is in Polish (e.g. move choices labeled 'Współpraca' / 'Sabotaż'); to be formalized as an NFR"
    - topic: "scoring balance"
      decision: "scores must be zero-balanced — playing more matches must not itself give a player an advantage; to be formalized in Business Logic"
    - topic: "FR-001 round-count bound"
      decision: "validated against a sensible min/max range at creation"
    - topic: "FR-002 late joiners"
      decision: "join window closes once tournament starts; no mid-tournament joins"
    - topic: "FR-003 round-robin scale"
      decision: "accepted for MVP at camp-sized groups; large tournaments out of scope"
    - topic: "FR-004 absent opponent"
      decision: "no in-app forfeit/timeout in MVP; handled socially by facilitator"
  frs_drafted: 8
  quality_check_status: accepted
---

# Shape Notes

Seed idea: A web app that will allow users to play the prisoner's dilemma game in a tournament setting. The app will keep the score, guard the players' choices until both choose to collaborate or sabotage, match players into tournament pairs, and in the end summarize the tournament (scores and statistics).

Domain grounding: modeled on Robert Axelrod's iterated Prisoner's Dilemma tournaments — round-robin pairing, each pair plays multiple rounds with simultaneous hidden choices revealed together, and per-player cumulative score across all pairings determines the tournament outcome. Axelrod's tournaments also gave rise to post-hoc behavioral classifications of strategies (e.g., "nice" vs not, forgiving vs unforgiving, provocable) — directly relevant to this app's "statistics" goal.

## Vision & Problem Statement

No dedicated app exists for running a closed, iterated Prisoner's Dilemma tournament with automatic pairing and post-tournament behavioral statistics (e.g., forgiveness, initial aggression). A camp counselor or educator who wants to teach game theory experientially is stuck running it manually — paper or whiteboard bookkeeping for hidden choices and running scores across many pairings is slow, error-prone, and burns the group's energy and attention on operations instead of the emerging strategic patterns that are the actual teaching point.

The insight: it is specifically the repeated, aggregated tournament structure — not a single round — that surfaces strategic patterns (like tit-for-tat or forgiveness) worth discussing. That structure only becomes pedagogically useful if the tooling is fast enough to run many rounds without losing the room; paper-based play is too slow to reach that point.

Note: the domain rule (pairing + statistics) does not need to change at scale — a single tournament is never expected to exceed ~50 concurrent players (a camp-group-sized cap; possibly configurable, possibly hardcoded for MVP).

## User & Persona

Primary persona: a youth-camp participant, age roughly 15-40, playing within a session-driven group activity. They are introduced to game theory through a hands-on, iterated Prisoner's Dilemma tournament, and afterward reflect on the strategic patterns — their own and others' — to draw connections to real-life decision-making.

No secondary persona. The counselor/facilitator uses the same app and view as any other player; their distinct value-add is leading the post-tournament debrief using the app's statistics, which requires no special access or role.

## Access Control

Login required (email/password or OAuth) — accounts persist across camp sessions so players and counselors can return over time. Flat user model: no organizer/admin role. Any logged-in user can start a tournament or join one; there is no elevated permission needed to manage pairing, rounds, or view statistics.

## Success Criteria

### Primary
- A logged-in player can create a tournament session (setting a fixed round count per match), share a join code/link, have ≥2 players join, manually start the tournament, have round-robin pairing generated automatically, play each match's rounds with hidden-until-both-commit simultaneous choices, have results persisted as they happen, and reach a concluded tournament with generated statistics (scores + behavioral stats like forgiveness and initial aggression).

### Secondary
- Players can see their own match history/results after the tournament concludes.

### Guardrails
- A player can never see the opponent's choice before both players have committed for that round.
- Round-robin pairing must guarantee no player is ever paired against themselves.
- In-progress match/tournament state and scores survive a dropped connection or page refresh — session data is not lost mid-tournament.

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
- FR-008: Player can see the final statistics and scoreboard after the tournament concludes. Priority: must-have
  > Socrates: No counter-argument; it stands as written.

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

## Business Logic

The app determines each round's opponent pairings from the tournament's active player list and each player's match history so far, and derives every player's zero-balanced score and behavioral statistics from their full recorded move history.

**Inputs.** Pairing draws on the list of players currently active in the tournament and each player's match history within that tournament (who they've already played), so no player is paired against an opponent they've already faced or against themselves. Statistics draw on every match a player has recorded in the tournament — the complete round-by-round sequence of their own and their opponents' moves.

**Output.** Pairing produces a list of opponent pairs for the upcoming round. Statistics produce a set of calculated metrics per player: a zero-balanced score (weighted so that playing more matches doesn't itself confer an advantage) and behavioral classifications derived from move patterns (e.g., forgiveness, initial aggression).

**Product flow.** A player encounters the pairing output at the start of each round, when they see who their next opponent is. They encounter the statistics output once the tournament concludes, on the final scoreboard/summary.

## Non-Functional Requirements

- All player-facing UI text is presented in Polish (e.g., move choices labeled "Współpraca" / "Sabotaż").
- Every round outcome and score change is presented so the player immediately feels the stakes and rivalry of the moment — a friendly, dopamine-inducing sense of competition, not a passive log entry.
- The tournament stays fully usable when pairs progress at very different speeds, and when a player leaves; no player's progress is blocked or corrupted by another player's pace or absence.
- A player's statistics are framed around what they reveal about that player's own playstyle and tendencies across the tournament, not just raw score/rank.

## Non-Goals

- **No tournaments larger than ~50 players.** The product targets a single camp-group scale, not large or public tournaments.
- **No cross-tournament global leaderboards.** Statistics and rankings stay scoped to a single tournament; there is no persistent cross-tournament ranking system.
- **No spectator mode for non-players.** Only participants can view live match state; there is no public/spectator viewing.
- **No in-app chat or messaging between players.** The only player-to-player communication is the move choices themselves.
