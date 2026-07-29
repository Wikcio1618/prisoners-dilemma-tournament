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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isWebSocketUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (url.pathname.startsWith(ROOM_PREFIX) && isWebSocketUpgrade) {
      const roomId = url.pathname.slice(ROOM_PREFIX.length);
      // Phase 2 adds UUID validation here, before any object is created.
      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(roomId));
      return stub.fetch(request);
    }

    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export { MatchRoom };
