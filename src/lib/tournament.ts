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
 * Must stay in sync with the literal in `public.join_tournament()`, which enforces the
 * cap under a row lock. The live definition is the most recent migration that replaces
 * that function — currently
 * `supabase/migrations/20260729192744_join_tournament_membership_shortcircuit.sql`.
 * Changing one without the other lets the two disagree silently.
 */
export const MAX_PLAYERS_PER_TOURNAMENT = 50;

/** Fewest rounds a single match may be configured to play. */
export const MIN_ROUNDS_PER_MATCH = 1;

/** Most rounds a single match may be configured to play. */
export const MAX_ROUNDS_PER_MATCH = 20;

/** Round count applied when the creator does not choose one. */
export const DEFAULT_ROUNDS_PER_MATCH = 10;

/**
 * Exact format of a tournament's join code: six digits.
 *
 * Unlike the round bounds above, this one *is* enforced in the database — the join code is
 * the sole credential for entering a tournament, so the constraint lives where it cannot be
 * bypassed. Mirrored by `tournaments_join_code_format`
 * (`supabase/migrations/20260730203114_join_code_six_digits.sql`); a code failing this
 * pattern is rejected by the insert, not by this constant.
 */
export const JOIN_CODE_PATTERN = /^[0-9]{6}$/;

/** Number of digits in a generated join code. */
export const JOIN_CODE_LENGTH = 6;

/**
 * Generates a join code.
 *
 * Returns a *string* with leading zeros preserved — `004821` is a valid code, and deriving it
 * from a number would silently produce a five-character value the database then rejects.
 *
 * Uses `crypto.getRandomValues` rather than `Math.random`: this value is the only credential
 * guarding entry to a tournament, and the keyspace is just 10^6, so predictable output would
 * make guessing trivial rather than merely feasible. Callers must still handle collisions —
 * `join_code` is globally unique, so an insert can fail with SQLSTATE 23505 and should be
 * retried with a fresh code.
 */
export function generateJoinCode(): string {
  const digits = new Uint8Array(JOIN_CODE_LENGTH);
  crypto.getRandomValues(digits);
  // Modulo 10 over a byte is very slightly biased toward 0-5; irrelevant for a join code,
  // and not worth rejection sampling here.
  return Array.from(digits, (byte) => (byte % 10).toString()).join("");
}

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

/**
 * Why a `start_tournament` call was rejected.
 *
 * Same contract as the join tokens above: read from `error.details`, never `error.message`.
 *
 * `NOT_FOUND` is raised both when the tournament does not exist and when the caller is not its
 * creator. That is deliberate — distinguishing them would turn the function into an existence
 * oracle for tournament ids — so callers must not infer "it exists but isn't yours" from it.
 *
 * Mirrored by `public.start_tournament()`
 * (`supabase/migrations/20260731174617_pairing_schema.sql`).
 */
export const START_TOURNAMENT_ERRORS = {
  NOT_AUTHENTICATED: "not_authenticated",
  NOT_FOUND: "tournament_not_found",
  FINISHED: "tournament_finished",
  NOT_ENOUGH_PLAYERS: "not_enough_players",
} as const;

export type StartTournamentError = (typeof START_TOURNAMENT_ERRORS)[keyof typeof START_TOURNAMENT_ERRORS];

/** Narrows a Supabase error's `details` field to a known start failure reason. */
export function isStartTournamentError(details: unknown): details is StartTournamentError {
  return typeof details === "string" && (Object.values(START_TOURNAMENT_ERRORS) as string[]).includes(details);
}
