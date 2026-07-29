import { handle } from "@astrojs/cloudflare/handler";
import { MatchRoom } from "./durable/match-room";

/**
 * Custom Worker entrypoint.
 *
 * This file sits in front of EVERY request to the site, so the gate below is deliberately
 * narrow: a request is only diverted when the path is a match room AND it is a WebSocket
 * upgrade. Everything else is handed to the adapter's own handler on the exact code path
 * it would have taken without this file.
 *
 * The room cannot be an Astro API route. `@astrojs/cloudflare`'s handler appends
 * `Set-Cookie` to every response it returns, and a response produced by a Durable Object
 * stub has immutable headers — the append throws `TypeError: Can't modify immutable
 * headers`. Because `src/middleware.ts` refreshes the Supabase session on every request,
 * that failure would only appear when a token actually refreshes: intermittent, and
 * painful to diagnose. Intercepting before the handler runs avoids it entirely.
 */
const ROOM_PREFIX = "/ws/match/";

/**
 * Room ids must be canonical UUIDs.
 *
 * This endpoint is unauthenticated by design, and `idFromName` creates a billed, persistent
 * Durable Object for any string it is given. Restricting the accepted keyspace to UUIDs is
 * what stops an arbitrary caller minting objects from arbitrary strings — it is a
 * containment measure, not a validation nicety.
 */
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isWebSocketUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (url.pathname.startsWith(ROOM_PREFIX) && isWebSocketUpgrade) {
      const roomId = url.pathname.slice(ROOM_PREFIX.length);
      if (!ROOM_ID_PATTERN.test(roomId)) {
        // Rejected before any stub is obtained, so no object is ever created.
        return new Response("Room id must be a UUID", { status: 400 });
      }
      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(roomId));
      return stub.fetch(request);
    }

    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export { MatchRoom };
