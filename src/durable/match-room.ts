import { DurableObject } from "cloudflare:workers";

/** The two moves a player can commit. Mirrors the PRD's Współpraca / Sabotaż. */
export type Move = "cooperate" | "sabotage";

/** Which side of the match a socket is playing. */
export type Seat = "a" | "b";

/** Client -> server. */
export interface ClientMessage {
  type: "commit";
  move: Move;
}

/** Server -> client. */
export type ServerMessage =
  | { type: "seat"; seat: Seat }
  | { type: "state"; committed: Record<Seat, boolean> }
  | { type: "reveal"; moves: Record<Seat, Move> }
  | { type: "error"; reason: string };

const SEATS: readonly Seat[] = ["a", "b"];
const MOVES: readonly Move[] = ["cooperate", "sabotage"];

/** Storage key holding a seat's committed move. */
const moveKey = (seat: Seat) => `move:${seat}`;

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

    const seat = this.freeSeat();
    if (!seat) {
      return new Response("Room already has two players", { status: 409 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // The seat is both a tag (so ctx.getWebSockets(seat) can address one side) and an
    // attachment (so the seat survives hibernation).
    this.ctx.acceptWebSocket(server, [seat]);
    server.serializeAttachment({ seat });

    this.send(server, { type: "seat", seat });
    const moves = await this.readMoves();
    if (this.isComplete(moves)) {
      this.send(server, { type: "reveal", moves: moves as Record<Seat, Move> });
    } else {
      this.send(server, { type: "state", committed: this.committedFlags(moves) });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.send(ws, { type: "error", reason: "Expected a text frame" });
      return;
    }

    const message = this.parse(raw);
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
      // Second commit from the same seat is ignored rather than overwriting.
      this.send(ws, { type: "state", committed: this.committedFlags(existing) });
      return;
    }

    await this.ctx.storage.put(moveKey(seat), message.move);

    // Re-read rather than mutating a local copy: the other seat's commit may have landed
    // in a different invocation, possibly separated by a hibernation.
    const moves = await this.readMoves();

    if (this.isComplete(moves)) {
      this.broadcast({ type: "reveal", moves: moves as Record<Seat, Move> });
      // The round is terminal, so nothing needs to survive. Wiping keeps abandoned rooms
      // from accumulating storage, which matters because this endpoint is unauthenticated.
      await this.ctx.storage.deleteAll();
    } else {
      this.broadcast({ type: "state", committed: this.committedFlags(moves) });
    }
  }

  override webSocketClose(ws: WebSocket): void {
    // Frees the seat for a reconnecting player. Committed moves are unaffected — they live
    // in storage, not on the socket.
    ws.close();
  }

  override webSocketError(ws: WebSocket): void {
    ws.close();
  }

  /** First seat with no live socket, or null when the room is full. */
  private freeSeat(): Seat | null {
    const taken = new Set(this.ctx.getWebSockets().map((ws) => this.seatOf(ws)));
    return SEATS.find((seat) => !taken.has(seat)) ?? null;
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

  private isComplete(moves: Partial<Record<Seat, Move>>): boolean {
    return SEATS.every((seat) => moves[seat] !== undefined);
  }

  private committedFlags(moves: Partial<Record<Seat, Move>>): Record<Seat, boolean> {
    return { a: moves.a !== undefined, b: moves.b !== undefined };
  }

  private parse(raw: string): ClientMessage | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { type?: unknown }).type === "commit" &&
        MOVES.includes((parsed as { move?: unknown }).move as Move)
      ) {
        return { type: "commit", move: (parsed as { move: Move }).move };
      }
    } catch {
      return null;
    }
    return null;
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }
}
