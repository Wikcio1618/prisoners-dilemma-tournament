/**
 * The match room's wire vocabulary and its only input-validation boundary.
 *
 * Extracted from `match-room.ts` so it can be unit tested: that module imports
 * `cloudflare:workers`, a virtual specifier that resolves only inside workerd, which makes the
 * whole file unimportable from a plain Node test runner. Nothing here imports anything, so the
 * parser's accept/reject contract can be pinned before S-03 adds socket verification to it.
 *
 * This is a move, not a rewrite — the runtime behaviour is byte-for-byte what shipped.
 */

/** The two moves a player can commit. Mirrors the PRD's Współpraca / Sabotaż. */
export type Move = "cooperate" | "sabotage";

/** Which side of the match a socket is playing. */
export type Seat = "a" | "b";

export const MOVES: readonly Move[] = ["cooperate", "sabotage"];

export const SEATS: readonly Seat[] = ["a", "b"];

/**
 * Client -> server.
 *
 * `playerId` is declared optional here to match what `parse` actually returns. The shipped
 * version declared the return type as a message *without* the field while passing it through
 * at runtime, so the value existed but was invisible to the type checker. Widening the type is
 * the honest fix; dropping the field would be a behaviour change.
 *
 * The room does not trust this field for identity — `src/worker.ts` resolves the real user via
 * `getUser()` and sets `PLAYER_ID_HEADER`, overwriting anything the client sent. It travels in
 * the message only for the dev harness at `/dev/match-room`.
 */
export interface ClientMessage {
  type: "commit";
  move: Move;
  playerId?: string;
}

/** Server -> client. */
export type ServerMessage =
  | { type: "seat"; seat: Seat }
  | { type: "state"; committed: Record<Seat, boolean> }
  | { type: "reveal"; moves: Record<Seat, Move> }
  | { type: "error"; reason: string };

/**
 * Largest frame the room will even attempt to parse, in UTF-16 code units.
 *
 * Bounds the work an unauthenticated caller can force before validation. A commit frame is well
 * under this; anything larger is not a message this room understands.
 *
 * Deliberately NOT a byte count — `raw.length` is code units, so a frame of multi-byte
 * characters can reach roughly 3 KB. That is fine for a work bound, which is all this is, but
 * the name has to say what it measures or a later reader will assume bytes and be wrong.
 */
export const MAX_FRAME_LENGTH = 1024;

/**
 * Parses a raw WebSocket frame into a commit message, or `null` if it is anything else.
 *
 * Every rejection path returns `null` rather than throwing: a malformed frame from one socket
 * must not be able to abort the round for the other player.
 */
export function parse(raw: string): ClientMessage | null {
  if (raw.length > MAX_FRAME_LENGTH) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "commit" &&
      MOVES.includes((parsed as { move?: unknown }).move as Move)
    ) {
      const { move, playerId } = parsed as { move: Move; playerId?: unknown };
      return {
        type: "commit",
        move,
        ...(typeof playerId === "string" ? { playerId } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}
