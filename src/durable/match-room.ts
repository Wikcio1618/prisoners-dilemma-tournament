import { DurableObject } from "cloudflare:workers";

/**
 * A live room for one Prisoner's Dilemma round between two players.
 *
 * Phase 1 scaffold: completes the WebSocket handshake and echoes frames. Seats, durable
 * commits and the hidden-until-both-commit reveal arrive in Phase 2.
 *
 * `ctx.acceptWebSocket` is used rather than `ws.accept()` deliberately. Both produce a
 * working socket, but only this one leaves the object able to hibernate — the difference
 * shows up as duration billing and state loss under eviction, never as an error.
 */
export class MatchRoom extends DurableObject<Env> {
  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(typeof message === "string" ? message : "(binary frame)");
  }
}
