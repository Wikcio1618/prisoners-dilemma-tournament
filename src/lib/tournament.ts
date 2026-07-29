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

/**
 * Why a `join_tournament` call was rejected.
 *
 * The database raises these as the error DETAIL rather than encoding them in the
 * SQLSTATE, because PostgREST derives the HTTP status from the SQLSTATE and maps codes
 * it does not recognise to 500. Read them off `error.details`, never off `error.message`
 * — the messages are prose and may be reworded or translated.
 *
 * Mirrored by `public.join_tournament()`
 * (`supabase/migrations/20260729190621_join_tournament_error_codes.sql`).
 */
export const JOIN_TOURNAMENT_ERRORS = {
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_FOUND: "tournament_not_found",
  ALREADY_STARTED: "tournament_already_started",
  FULL: "tournament_full",
} as const;

export type JoinTournamentError = (typeof JOIN_TOURNAMENT_ERRORS)[keyof typeof JOIN_TOURNAMENT_ERRORS];

/** Narrows a Supabase error's `details` field to a known join failure reason. */
export function isJoinTournamentError(details: unknown): details is JoinTournamentError {
  return typeof details === "string" && (Object.values(JOIN_TOURNAMENT_ERRORS) as string[]).includes(details);
}
