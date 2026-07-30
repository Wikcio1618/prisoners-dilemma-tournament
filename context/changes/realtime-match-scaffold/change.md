---
change_id: realtime-match-scaffold
title: Minimal live-room scaffold for one hidden-then-revealed round
status: implemented
created: 2026-07-28
updated: 2026-07-30
archived_at: null
---

## Notes

from @context/foundation/roadmap.md

### Implementation close-out (2026-07-30)

All four phases landed and deployed (active version `b5fe3f0a`). Two Progress rows were
closed on evidence rather than direct observation, recorded here so S-03 knows what is
actually unexercised:

- **4.4** — the protocol was verified against the deployed Worker at the wire (distinct
  seats, third socket refused, no move value on the wire before both commits, simultaneous
  reveal, storage wiped). The harness *page* was only exercised in a browser locally, not
  against production.
- **4.5** — the production auth path was proven to reach Supabase and redirect correctly
  (`POST /api/auth/signin` → 302 → `?error=Invalid login credentials`), which retires the
  `TypeError: Can't modify immutable headers` risk that motivated the custom entrypoint. A
  *successful* login's session cookie round-trip was never exercised end to end.

Carried into S-03, beyond the plan's "What We're NOT Doing":

- The room endpoint is **live and unauthenticated** at
  `wss://prisoners-dilemma-tournament.ciolekwiktor.workers.dev/ws/match/<uuid>`. Anyone can
  open rooms on random UUIDs; containment is structural only (UUID validation, two-socket
  cap, storage wipe on terminal).
- Criterion 1.6's wording ("receives its echoed frame") describes the Phase 1 scaffold. Phase 2
  replaced the echo with the `seat`/`state` protocol — the row is checked on verified handshake
  behaviour, not on an echo that no longer exists.
- Testing gotcha: curl negotiates HTTP/2 over HTTPS, which has no `Upgrade` header, so room
  requests fall through to Astro and 404. Use `--http1.1`. Browsers are unaffected.
- Astro's CSRF check (`security.checkOrigin`) rejects POSTs without a matching `Origin`, so
  scripted auth probes need the header set explicitly.

### Sequencing decision (2026-07-28)

Planning was started via `/10x-plan realtime-match-scaffold` and **deliberately deferred**. Rooms will be
keyed on real tournament match ids rather than throwaway strings, which requires the tournament data
model (F-01, `tournament-data-model`) to exist first. F-02 is therefore no longer parallel-with F-01 —
it now depends on it. Roadmap updated to match.

Resume with `/10x-plan realtime-match-scaffold` after F-01 lands.

### Decisions already locked (carry into the eventual plan)

| Decision | Choice | Why |
| --- | --- | --- |
| Socket authentication | **None in this scaffold** | Small app, small single event, no adversarial users expected. Keeps exactly one unfamiliar thing (Durable Objects) in the change so failures are attributable. The message protocol still carries a `playerId` field, so S-03 adds *verification* rather than restructuring the handshake. **Revisit in S-03 before real players use it.** |
| Rounds played | **Exactly one, then terminal** | Matches the roadmap's F-02 outcome verbatim; unambiguous pass/fail on the simultaneous reveal. Multi-round loop belongs to S-03. |
| Room addressing | **Real tournament match id** | Chosen over a throwaway URL string — this is what creates the F-01 dependency above. |
| Verification | **Throwaway page opened in two browser tabs** | No test runner exists in this repo. Two tabs make the core guarantee directly observable: commit in tab A, tab B stays blind, then both flip together. Keep the page off real navigation. |

### Research findings (verified 2026-07-28 against installed source + current Cloudflare/Astro docs)

Versions in play: `astro@^6.3.1`, `@astrojs/cloudflare@^13.5.0`, `wrangler@^4.90.0`,
`compatibility_date: 2026-05-08`, `compatibility_flags: ["nodejs_compat"]`.

**Blocking architectural constraint — the WebSocket route must NOT be an Astro API route.**
`@astrojs/cloudflare/dist/utils/handler.js` appends `Set-Cookie` headers to every response. A response
returned from a Durable Object stub is a subrequest response with **immutable headers**, so the append
throws `TypeError: Can't modify immutable headers`. `src/middleware.ts:12` calls
`supabase.auth.getUser()` on every request and `@supabase/ssr` writes refreshed auth cookies — so this
would fail *intermittently*, only when a token refresh happens. The upgrade must be intercepted in a
custom worker entrypoint before Astro's handler runs. (Same failure Hono hit: honojs/hono#1102.)

- **Worker entrypoint:** change `wrangler.jsonc` `main` from `@astrojs/cloudflare/entrypoints/server` to
  a local `./src/worker.ts` that re-exports `handle` from `@astrojs/cloudflare/handler` plus the DO class.
  The adapter respects a user-supplied `main` (`config.main ?? default`, `dist/wrangler.js:31`), so
  nothing is clobbered. Note this file then sits in front of *every* request to the live site.
  `workerEntryPoint` as an adapter option was removed in Astro 6 — don't look for it.
- **`new_sqlite_classes` is mandatory and one-way.** KV-backed DO namespace creation was blocked
  account-wide on 2026-07-09, and the SQLite backend cannot be switched on for an already-deployed
  class. Get it right on the first deploy. (`wrangler@4.90.0` does not support the newer declarative
  `exports` field — verified empirically; use `migrations`.)
- **Local dev works:** `astro dev` runs real `workerd` via the Cloudflare Vite plugin in Astro 6, so
  Durable Objects work locally with no separate `wrangler dev`. State lands under `.wrangler/state`.
- **State must go to `ctx.storage`, not memory.** Hibernation discards in-memory fields. Use
  `serializeAttachment` for per-socket identity/seat only; committed moves belong in `ctx.storage` so
  they survive both hibernation and a player reconnecting.
- **`setTimeout` blocks hibernation entirely** — any round timer must use the Alarms API.
- **Deploys drop live WebSockets** (documented, by design — new instance takes over ASAP). Client-side
  reconnect plus state resume from storage is required, not optional.
- **No typed `Env` exists in this repo** — `@cloudflare/workers-types` is not a direct dependency and
  there is no `worker-configuration.d.ts`. Run `wrangler types` and add the output to `tsconfig.json`.
- **`Astro.locals.runtime.env` was removed in Astro 6** — the adapter installs getters that throw a
  migration message. Use `import { env } from 'cloudflare:workers'`. In adapter v13 `Runtime` is only
  `{ cfContext: ExecutionContext }`.
- **Adapter docs are ahead of the installed version:** they reference `@astrojs/cloudflare/fetch` and
  `/hono`, neither of which is in 13.5.0's exports map. `./handler` is the one that exists.
- Hibernation API: `ctx.acceptWebSocket(ws, tags?)` (**not** `ws.accept()`, which disables hibernation),
  handlers `webSocketMessage` / `webSocketClose` / `webSocketError`, `ctx.getWebSockets(tag?)`,
  `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` for keepalive without
  waking. Base class is `DurableObject` from `cloudflare:workers`. The DO's single-threaded execution
  makes the "have both players committed?" check race-free with no locking.
