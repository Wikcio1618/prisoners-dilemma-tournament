/**
 * A TEST ORACLE, NOT PRODUCTION CODE.
 *
 * Nothing shipped imports this module, and nothing should. It exists so that rollout Phase 2
 * can run the same rosters through Postgres and compare the resulting schedule against an
 * independent reference.
 *
 * Why it has to exist at all: pairing is 100% SQL-resident inside `start_tournament()`
 * (`supabase/migrations/20260801170219_pairing_set_based.sql`), so it cannot be reached from a
 * unit test. The only verification it has ever had is a hand-trace in
 * `context/changes/generate-round-robin-pairing/reviews/impl-review.md`.
 *
 * ---- What "independent" means here, precisely ----
 *
 * This is written from the circle method's geometric definition, not transcribed from the SQL's
 * modular-arithmetic expressions. That is enough to catch a transcription slip, an off-by-one,
 * or a rotation that drifts — the realistic failure modes.
 *
 * It is NOT enough to catch a shared misunderstanding of the circle method itself, because both
 * implementations would then be wrong the same way. That is why the property tests in
 * `pairing-oracle.test.ts` matter more than the agreement: they check the schedule against what
 * a round robin *is* (every pair once, nobody twice per round), not against another
 * implementation. Agreement with the SQL is corroboration; the properties are the proof.
 *
 * ---- Conventions, copied deliberately so the two schedules are comparable ----
 *
 * - Players are sorted ascending, matching `array_agg(user_id order by user_id)` in the SQL.
 * - Odd rosters get one phantom slot; pairs containing it are dropped, not written as byes.
 *   (A bye row would be a match with a NULL player, and `least()`/`greatest()` ignore NULLs, so
 *   two byes for the same player would collide on `matches_tournament_pair_uniq`.)
 * - Round ordinals are 1-based.
 */

export interface ScheduledPair {
  /** 1-based round ordinal. */
  readonly round: number;
  readonly a: string;
  readonly b: string;
}

/**
 * Builds the complete round-robin schedule for a roster.
 *
 * The circle method: one player is held fixed while everyone else rotates around a circle. In
 * round *r* the fixed player meets whoever currently stands at circle position *r*, and the
 * remaining players pair off symmetrically about that position — the one *k* steps clockwise
 * plays the one *k* steps anticlockwise. After `slots - 1` rounds every pair has met exactly
 * once, because each rotation brings a different player opposite the fixed one and re-mirrors
 * everyone else.
 *
 * @param playerIds roster; duplicates are not checked, callers pass distinct ids
 * @returns every pair with its round ordinal, ordered by round then by position
 */
export function roundRobinSchedule(playerIds: readonly string[]): ScheduledPair[] {
  const players = [...playerIds].sort();
  const count = players.length;
  if (count < 2) {
    return [];
  }

  // An odd roster borrows one phantom slot so the circle has an even circumference; whoever
  // draws it in a given round simply has no match that round.
  const slots = count + (count % 2);
  const rounds = slots - 1;

  /**
   * Resolves a position on the rotating circle to a player.
   *
   * Circle position 0 is the second player overall — the first is held fixed and is not on the
   * circle at all. A position past the end of the roster is the phantom.
   */
  const onCircle = (position: number): string | undefined => players[position + 1];

  const schedule: ScheduledPair[] = [];

  /** Records a pair, unless it contains the phantom — in which case that player sits the round out. */
  const push = (round: number, a: string | undefined, b: string | undefined): void => {
    if (a !== undefined && b !== undefined) {
      schedule.push({ round, a, b });
    }
  };

  for (let position = 0; position < rounds; position++) {
    const round = position + 1;

    // The fixed player meets whoever has rotated into this round's position.
    push(round, players[0], onCircle(position));

    // Everyone else mirrors about that position: the player k steps one way plays the player
    // k steps the other.
    for (let step = 1; step < slots / 2; step++) {
      push(round, onCircle((position + step) % rounds), onCircle((position - step + rounds) % rounds));
    }
  }

  return schedule;
}
