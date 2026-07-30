import { z } from "zod";
import { JOIN_CODE_PATTERN, MAX_ROUNDS_PER_MATCH, MIN_ROUNDS_PER_MATCH } from "@/lib/tournament";

/**
 * Input schemas for the tournament API routes.
 *
 * Bounds are derived from the constants in `./tournament`, never restated as literals, so
 * there is one place to change them. This matters most for `rounds_per_match`: the database
 * deliberately carries no CHECK constraint for it, so this schema is the only thing standing
 * between a client and a tournament configured for two billion rounds.
 */

/** `POST /api/tournaments` — creating a tournament. */
export const createTournamentSchema = z.object({
  // Form values arrive as strings; coerce before bounding, and require an integer so
  // "10.5" is rejected rather than silently truncated.
  rounds_per_match: z.coerce.number().int().min(MIN_ROUNDS_PER_MATCH).max(MAX_ROUNDS_PER_MATCH),
});

/** `POST /api/tournaments/join` — joining by code. */
export const joinTournamentSchema = z.object({
  // Trimmed first: codes get copied out of chat messages with stray whitespace, and the
  // database pattern is anchored, so an untrimmed value fails as "not found".
  join_code: z.string().trim().regex(JOIN_CODE_PATTERN),
});

export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;
export type JoinTournamentInput = z.infer<typeof joinTournamentSchema>;
