# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## No status value ships without a demonstrated exit

**Rule.** Every value a state column or storage key can hold must have (a) something that writes it and (b) something that moves out of it. Before a status vocabulary lands, name the writer and the exit for each value. If a value is genuinely terminal, say so and say what makes it terminal.

"Unreachable by design" is not a claim you may assert. Record the *mechanism* that makes it unreachable — a revoked grant, an absent policy, a CHECK — or treat it as reachable. A state nobody can leave is indistinguishable from a bug once real users are in it, and at a live event it means a room full of people waiting while someone reads SQL on their phone.

**Why this is a rule and not an observation.** Three separate implementation reviews each independently rediscovered an instance, which is the definition of a class rather than a bug:

- `tournament-data-model` F1 — `tournaments.status` could reach `finished`, which bricked the row: no policy allowed leaving it, and nothing wrote it either.
- `realtime-match-scaffold` F2 — the round was not terminal, so rooms were infinitely replayable; the fix was to make committed moves themselves the terminal marker.
- `generate-round-robin-pairing` F1 — the opponent view's mutuality invariant holds only while every player has completed the same number of matches, so the first slice that marks a match `finished` breaks it.

All three were caught by human review. Human review is not a mechanism; it catches what a reader happens to notice on the day.

**How to apply.** When reviewing a migration or a storage design, build the transition table before reading the prose: values down one axis, "who writes it" and "how you leave it" across. An empty cell is the finding. The current table lives in `src/lib/state-machine.test.ts`, where each unresolved dead end is a `test.todo` naming its owning slice.

## A constant duplicated between SQL and TypeScript needs a drift test, not a comment

**Rule.** Whenever a literal must agree across the database and application code — a cap, a bound, a regex, an error token, a status vocabulary — add an assertion that reads both and compares them. A comment saying "keep in sync with X" is documentation of an intention, not enforcement of it.

**Why.** This repo shipped the class twice. `tournament-data-model` F3: a player-cap comment pointed at a migration that had already been superseded, so the comment was actively misleading. `generate-round-robin-pairing` F6: the display-name bound was restated as a literal in three places, in a file whose own header says bounds are "never restated as literals." Both were caught by review; neither was caught by anything that runs.

**How to apply.** `src/lib/db-constants.test.ts` is the mechanism and the pattern to copy: read the migration file as a text fixture, extract the literal with a narrow regex, assert against the TypeScript constant, and write the failure message so it names both sides and the migration path. No database required, milliseconds to run. When a migration supersedes one the test reads, update the path deliberately — a drift test silently reading a stale file is the very failure it exists to prevent.
