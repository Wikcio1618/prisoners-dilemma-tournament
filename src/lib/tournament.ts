/**
 * Tournament domain bounds.
 *
 * These live here rather than as database CHECK constraints by explicit decision —
 * `tournaments.rounds_per_match` accepts any integer at the database level, so every
 * write path is responsible for validating against these constants.
 */

/**
 * Maximum players in a single tournament.
 *
 * Must stay in sync with the literal in `public.join_tournament()`
 * (`supabase/migrations/20260729174939_tournament_rls.sql`), which enforces the cap
 * under a row lock. Changing one without the other lets the two disagree silently.
 */
export const MAX_PLAYERS_PER_TOURNAMENT = 50;

/** Fewest rounds a single match may be configured to play. */
export const MIN_ROUNDS_PER_MATCH = 1;

/** Most rounds a single match may be configured to play. */
export const MAX_ROUNDS_PER_MATCH = 20;

/** Round count applied when the creator does not choose one. */
export const DEFAULT_ROUNDS_PER_MATCH = 10;
