import { DurableObject } from "cloudflare:workers";

import { parse, SEATS, type Move, type Seat, type ServerMessage } from "./match-message";

// The wire vocabulary and the frame parser live in `./match-message` so they can be unit
// tested — this module imports `cloudflare:workers`, which only resolves inside workerd.
// Re-exported here so existing importers of match-room keep working unchanged.
export { parse, MOVES, SEATS, MAX_FRAME_LENGTH } from "./match-message";
export type { ClientMessage, Move, Seat, ServerMessage } from "./match-message";

/**
 * Header carrying the authenticated Supabase user id from the entrypoint into the room.
 *
 * Set by `src/worker.ts` after `getUser()`, overwriting anything the client sent. The room
 * trusts it precisely because it is unreachable from outside: every request here arrives
 * through that entrypoint, which resolves identity before obtaining the stub.
 */
export const PLAYER_ID_HEADER = "X-Player-Id";

/** Storage key holding a seat's committed move. */
const moveKey = (seat: Seat) => `move:${seat}`;

/** Storage key holding the Supabase user id occupying a seat. */
const playerKey = (seat: Seat) => `player:${seat}`;

/**
 * How long a room may sit with an unfinished round before it is reclaimed.
 *
 * Generous relative to a single round in a live session, and only ever reached by rooms
 * nobody came back to. Scheduled via the Alarms API rather than `setTimeout`, which would
 * pin the object awake and defeat hibernation.
 */
const ABANDON_AFTER_MS = 30 * 60 * 1000;

/**
 * A live room for one Prisoner's Dilemma round between two players.
 *
 * The room's whole purpose is one guarantee: neither player learns the other's move until
 * both have committed. That is enforced here, server-side — a committed move is never put
 * on the wire until both exist. A client that merely hides a received value is not
 * equivalent, because devtools defeats it.
 *
 * Committed moves live in `ctx.storage`, never in instance fields. The object can hibernate
 * *between* the two commits (player A commits, nothing happens, the object is evicted,
 * player B commits); in-memory state would be gone and the reveal would fire with one real
 * move. This is the correctness constraint that makes a Durable Object the right tool, and
 * the reason every commit re-reads storage rather than trusting anything held in memory.
 *
 * Ordering within a room needs no locking: a Durable Object executes single-threaded, so
 * the "have both committed?" check cannot interleave with another commit.
 *
 * Committed moves are NOT deleted once the round completes. Their presence is what makes the
 * round terminal — the already-committed guard reads them, and a seat holding one is not
 * free. An earlier version wiped storage on reveal, which reset the room instead of sealing
 * it and made rooms infinitely replayable. Storage growth is bounded instead by the alarm
 * below, which reclaims only rooms whose round was never finished.
 */
export class MatchRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive that does not wake the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const playerId = request.headers.get(PLAYER_ID_HEADER);
    if (!playerId) {
      // Unreachable through the entrypoint, which rejects anonymous upgrades first. Kept as
      // a floor so the room is never seatable without an identity, however it is reached.
      return new Response("Missing player identity", { status: 401 });
    }

    // Read before claiming a seat. These are the only awaits ahead of the claim, which keeps
    // the resolve-and-accept step below free of yield points — two simultaneous upgrades
    // therefore cannot both be handed the same seat.
    const [moves, players] = await Promise.all([this.readMoves(), this.readPlayers()]);
    const seat = this.seatFor(playerId, players);

    if (!seat) {
      return new Response(this.isComplete(moves) ? "Round already complete" : "Room already has two players", {
        status: this.isComplete(moves) ? 410 : 409,
      });
    }

    // A returning player is entitled to the result of their own round, so a completed round
    // is replayed to them rather than refused. Only the two recorded players can reach here.
    const alreadyRevealed = this.isComplete(moves);

    // Latest connection wins for a given seat: a reloaded tab must not be locked out by its
    // own predecessor, which may still be enumerated for a moment after the client is gone.
    for (const existing of this.ctx.getWebSockets()) {
      if (this.seatOf(existing) === seat) {
        this.closeQuietly(existing);
      }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // The seat is both a tag (so ctx.getWebSockets(seat) can address one side) and an
    // attachment (so the seat survives hibernation).
    this.ctx.acceptWebSocket(server, [seat]);
    server.serializeAttachment({ seat });

    if (players[seat] === undefined) {
      await this.ctx.storage.put(playerKey(seat), playerId);
    }

    // Scheduled after the seat is claimed so it adds no yield point ahead of the claim.
    // Set once and left alone: the deadline is "this room has been idle since it was first
    // used", not a sliding window, so a room cannot be kept alive indefinitely by reconnects.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ABANDON_AFTER_MS);
    }

    this.send(server, { type: "seat", seat });
    if (alreadyRevealed) {
      this.send(server, { type: "reveal", moves: moves as Record<Seat, Move> });
    } else {
      this.send(server, { type: "state", committed: this.committedFlags(moves) });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleMessage(ws, raw);
    } catch {
      // A throw here would abandon the handler mid-round. Storage is the source of truth and
      // is written before any broadcast, so the round stays recoverable on the next message.
      this.send(ws, { type: "error", reason: "Internal error" });
    }
  }

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.send(ws, { type: "error", reason: "Expected a text frame" });
      return;
    }

    const message = parse(raw);
    if (!message) {
      this.send(ws, { type: "error", reason: "Unrecognised message" });
      return;
    }

    const seat = this.seatOf(ws);
    if (!seat) {
      this.send(ws, { type: "error", reason: "No seat assigned" });
      return;
    }

    const existing = await this.readMoves();
    if (existing[seat] !== undefined) {
      // Already committed. After a reveal both seats are committed, so this is also what
      // makes the round terminal — every later commit lands here and changes nothing.
      this.send(ws, { type: "state", committed: this.committedFlags(existing) });
      return;
    }

    await this.ctx.storage.put(moveKey(seat), message.move);

    // Re-read rather than mutating a local copy: the other seat's commit may have landed
    // in a different invocation, possibly separated by a hibernation.
    const moves = await this.readMoves();

    if (this.isComplete(moves)) {
      this.broadcast({ type: "reveal", moves: moves as Record<Seat, Move> });
    } else {
      this.broadcast({ type: "state", committed: this.committedFlags(moves) });
    }
  }

  /**
   * Reclaims a room whose round was never finished.
   *
   * Completed rounds are deliberately left alone: their stored moves are what keep the round
   * terminal, and wiping them would make the room replayable again — the exact defect that
   * removing `deleteAll()` fixed. Only abandoned rounds are cleared, which is what bounds
   * storage growth from rooms nobody returned to.
   */
  override async alarm(): Promise<void> {
    const moves = await this.readMoves();
    if (this.isComplete(moves)) {
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "error", reason: "Room expired before both players committed" });
      this.closeQuietly(ws);
    }
    await this.ctx.storage.deleteAll();
  }

  override webSocketClose(ws: WebSocket): void {
    // The seat itself is not released: it belongs to a player id in storage, so the same
    // person reclaims it on reconnect and nobody else can take it. Committed moves are
    // likewise unaffected by a socket closing.
    this.closeQuietly(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.closeQuietly(ws);
  }

  /**
   * The seat this player is entitled to: the one they already hold, or the first unclaimed
   * one. Null when both seats belong to other people.
   *
   * Resolving by identity rather than by arrival order is what makes reconnection safe. An
   * earlier version handed out whichever seat had no live socket, which meant a newcomer
   * could inherit a seat that already held someone else's committed move — they could not
   * commit, yet the eventual reveal still reached them, disclosing a move to somebody who
   * never made one.
   */
  private seatFor(playerId: string, players: Partial<Record<Seat, string>>): Seat | null {
    const held = SEATS.find((seat) => players[seat] === playerId);
    if (held) {
      return held;
    }
    return SEATS.find((seat) => players[seat] === undefined) ?? null;
  }

  private seatOf(ws: WebSocket): Seat | null {
    const attachment = ws.deserializeAttachment() as { seat?: Seat } | null;
    return attachment?.seat ?? null;
  }

  private async readMoves(): Promise<Partial<Record<Seat, Move>>> {
    const stored = await this.ctx.storage.get<Move>(SEATS.map(moveKey));
    return {
      a: stored.get(moveKey("a")),
      b: stored.get(moveKey("b")),
    };
  }

  private async readPlayers(): Promise<Partial<Record<Seat, string>>> {
    const stored = await this.ctx.storage.get<string>(SEATS.map(playerKey));
    return {
      a: stored.get(playerKey("a")),
      b: stored.get(playerKey("b")),
    };
  }

  private isComplete(moves: Partial<Record<Seat, Move>>): boolean {
    return SEATS.every((seat) => moves[seat] !== undefined);
  }

  private committedFlags(moves: Partial<Record<Seat, Move>>): Record<Seat, boolean> {
    return { a: moves.a !== undefined, b: moves.b !== undefined };
  }

  /** A socket in teardown throws on send; one dead peer must not abort the round. */
  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Peer is gone. Its seat frees via webSocketClose; storage already holds the truth.
    }
  }

  private closeQuietly(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // Already closed or errored — nothing to do.
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, message);
    }
  }
}
