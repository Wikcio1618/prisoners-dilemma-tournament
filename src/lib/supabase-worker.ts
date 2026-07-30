import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { Database } from "@/db/database.types";

/**
 * A read-only Supabase client for the raw Worker entrypoint.
 *
 * Separate from `createClient` in `./supabase.ts` for two reasons: there is no `AstroCookies`
 * outside Astro's request context, and this module must not import `astro:env/server` — the
 * entrypoint takes its configuration from the Worker `Env` binding instead.
 *
 * Cookie writes are intentionally dropped. This client exists only to answer "who is this
 * request from?" during a WebSocket upgrade, and a 101 response cannot carry `Set-Cookie`
 * anyway. The practical consequence: if the access token has expired, `getUser()` fails
 * rather than silently refreshing, and the caller is treated as anonymous. The browser
 * refreshes on its next normal page load, after which the socket can reconnect.
 */
export function createWorkerClient(requestHeaders: Headers, url: string | undefined, key: string | undefined) {
  if (!url || !key) {
    return null;
  }
  return createServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return parseCookieHeader(requestHeaders.get("Cookie") ?? "").map(({ name, value }) => ({
          name,
          value: value ?? "",
        }));
      },
      setAll() {
        // No-op: a WebSocket upgrade response cannot set cookies.
      },
    },
  });
}
