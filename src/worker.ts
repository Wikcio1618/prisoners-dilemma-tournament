import { handle } from "@astrojs/cloudflare/handler";
import { MatchRoom, PLAYER_ID_HEADER } from "./durable/match-room";
import { createWorkerClient } from "./lib/supabase-worker";

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
 * `idFromName` creates a billed, persistent Durable Object for any string it is given, so
 * restricting the accepted keyspace to UUIDs bounds what a caller can mint. Identity is
 * checked as well (below), but this runs first and costs nothing.
 */
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isWebSocketUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (url.pathname.startsWith(ROOM_PREFIX) && isWebSocketUpgrade) {
      // Lowercased before use: the pattern below is case-insensitive but idFromName is not,
      // so without this a UUID and its uppercase form mint two different Durable Objects —
      // two clients that normalise case differently would silently never meet.
      const roomId = url.pathname.slice(ROOM_PREFIX.length).toLowerCase();
      if (!ROOM_ID_PATTERN.test(roomId)) {
        // Rejected before any stub is obtained, so no object is ever created.
        return new Response("Room id must be a UUID", { status: 400 });
      }
      // Identity is resolved here, before the stub is obtained, because the session cookie
      // is on the upgrade request and the Durable Object has no access to it. Seats bind to
      // this id inside the room, which is what lets a reconnecting player resume their own
      // seat instead of being handed whichever one happens to be free.
      const supabase = createWorkerClient(request.headers, env.SUPABASE_URL, env.SUPABASE_KEY);
      if (!supabase) {
        return new Response("Supabase is not configured", { status: 503 });
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        return new Response("Sign in to join a match room", { status: 401 });
      }

      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(roomId));
      const headers = new Headers(request.headers);
      // Overwritten, never appended: a client-supplied value must not be able to impersonate.
      headers.set(PLAYER_ID_HEADER, user.id);
      return stub.fetch(new Request(request, { headers }));
    }

    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export { MatchRoom };
