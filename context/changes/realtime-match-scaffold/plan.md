# Realtime Match Scaffold Implementation Plan

## Overview

Build the smallest working version of the product's core mechanic: a live room that holds two players' moves for one round and reveals both only once both have committed. This is roadmap **F-02**, the foundation that unblocks S-03 (hidden-move match play). It deliberately contains exactly one unfamiliar technology — Cloudflare Durable Objects with WebSocket hibernation — so the learning cost is paid once, early, and in isolation from match-loop logic.

## Current State Analysis

The deployment and auth layers are live; the realtime layer is entirely absent. `wrangler.jsonc` points `main` at the adapter's own entrypoint, there is no Durable Object anywhere in the repo, and `src/pages/api/` holds only the three auth routes.

Five findings constrain how this can be built:

- **The WebSocket route cannot be an Astro API route.** `node_modules/@astrojs/cloudflare/dist/utils/handler.js:102-105` appends `Set-Cookie` to every response unconditionally. A response returned from a Durable Object stub is a subrequest response with **immutable headers**, so the append throws `TypeError: Can't modify immutable headers`. Because `src/middleware.ts:12` calls `supabase.auth.getUser()` on every request and `@supabase/ssr` only writes cookies when a token actually refreshes, this would fail **intermittently** — the worst possible failure shape. The upgrade must be intercepted before Astro's handler runs.
- **The adapter respects a user-supplied `main`.** `dist/wrangler.js:31` resolves `main: config.main ?? "@astrojs/cloudflare/entrypoints/server"`, and the exports map exposes `./handler` → `./dist/utils/handler.js`, which exports `handle`. A custom entrypoint can therefore delegate all non-WebSocket traffic to the stock handler with nothing clobbered. `workerEntryPoint` as an adapter option was removed in Astro 6 — do not look for it.
- **`new_sqlite_classes` is mandatory and one-way.** KV-backed Durable Object namespace creation was blocked account-wide on 2026-07-09, and the SQLite backend cannot be switched on for an already-deployed class. The first deploy must be right. `wrangler@4.90.0` does not support the newer declarative `exports` field (verified empirically) — use `migrations`.
- **Local dev runs real `workerd`.** Astro 6's Cloudflare Vite plugin means `astro dev` exercises genuine Durable Objects with no separate `wrangler dev`; state lands under `.wrangler/state`.
- **No typed `Env` exists.** `@cloudflare/workers-types` is not a dependency and there is no `worker-configuration.d.ts`. `wrangler types` generates one — and because `tsconfig.json` already sets `"include": [".astro/types.d.ts", "**/*"]`, a root-level generated file is picked up with **no tsconfig edit** (the change folder's research note claiming otherwise is out of date).

### Key Discoveries:

- **Hibernation discards in-memory fields, which makes `ctx.storage` mandatory regardless of reconnect policy.** The room can hibernate *between* the two commits: player A commits, nothing happens for a while, the object hibernates, player B commits. Moves held in instance fields would be gone and the reveal would misfire with one real move. This is the single most important correctness constraint in the change.
- **`ctx.acceptWebSocket(ws, tags?)` is required, not `ws.accept()`** — the latter silently disables hibernation, so the code would appear to work while burning duration billing and losing state on eviction.
- **`setTimeout` blocks hibernation entirely.** Any future round timer must use the Alarms API. Not needed here (no timeout in this scaffold) but relevant the moment S-03 adds one.
- **`serializeAttachment` is for per-socket identity only** — seat assignment survives hibernation through it; committed moves belong in `ctx.storage`.
- **A Durable Object's single-threaded execution makes the "have both committed?" check race-free with no locking.** This is the property that makes a DO the right tool rather than an optimisation.
- **Deploys drop live WebSockets by design** (documented Cloudflare behaviour — a new instance takes over as soon as possible). Accepted here; S-03 owns client retry.
- `matches.status` is `text` with a `matches_status_check` constraint, not an enum — changed during F-01's review triage, after this change folder's research was written.
- `src/middleware.ts:4` gates only `/dashboard` via `PROTECTED_ROUTES`; nothing else is protected.

## Desired End State

Two browser tabs open the same room URL, each is assigned a distinct seat, and each submits a move. Neither tab can see the other's move — not on screen and not on the wire — until both have committed, at which point both reveal simultaneously. The room's state survives the object hibernating between the two commits. The mechanism runs both locally under `astro dev` and on the deployed Worker, and every existing route (all auth flows, `/dashboard`, static pages) behaves exactly as it does today.

Verify by: `npm run build` and `npm run lint` passing, the two-tab manual test above succeeding locally and against production, and `npx wrangler deployments status` plus the Cloudflare dashboard confirming the `MatchRoom` namespace exists with the **SQLite** storage backend.

## What We're NOT Doing

- **No socket authentication.** By explicit decision — small single event, no adversarial users assumed. The protocol carries a `playerId` field so S-03 adds *verification* rather than restructuring the handshake. **This must be added in S-03 before real players use it.**
- **No match-existence check.** By explicit decision, the room accepts any well-formed UUID as its id; it does not read `public.matches` to confirm the match exists or that the connecting player belongs to it. S-03 owns that binding.
- **No multi-round loop.** Exactly one round, then terminal. The iterated game belongs to S-03.
- **No client-side reconnect or retry.** The server sends a state snapshot on connect, but the client does not detect drops or back off. S-03 owns retry policy.
- **No scoring, no persistence to Postgres, no statistics.** Nothing in this change writes to Supabase at all.
- **No round timer.** Which is why the Alarms API does not appear here.
- **No real UI.** The verification page is a throwaway kept off site navigation; S-03 builds the actual match screen.
- **No rate limiting.** Containment is structural (UUID validation, two-socket cap, storage wipe) rather than request-rate-based.

## Implementation Approach

The riskiest change is structural, not algorithmic: replacing the worker entrypoint puts a file of ours in front of **every** request to a site already serving real auth flows in production. Phase 1 therefore lands that change with no game logic at all, so that if existing routes break, the cause is unambiguous. The mechanic goes in only once the front door is proven inert.

The entrypoint gate is deliberately narrow — pathname match **and** `Upgrade: websocket` — so a bug in it can only affect one route, and normal traffic keeps the exact code path it runs today.

Access control is structural. Because the endpoint is open by decision, the plan bounds what an anonymous caller can consume rather than who they are: only well-formed UUIDs create objects, each room accepts at most two sockets, and storage is wiped once the round is terminal so abandoned rooms do not accumulate.

## Critical Implementation Details

**Ordering within Phase 1.** The `migrations` block with `new_sqlite_classes` must be present in `wrangler.jsonc` *before* the class is ever deployed. The SQLite backend cannot be enabled on an already-deployed Durable Object class, so a first deploy without it is not recoverable by editing config — it requires a renamed class. Local `astro dev` does not protect you here; it happily creates local state either way.

**Hibernation is easy to disable by accident.** `ws.accept()` and `ctx.acceptWebSocket(ws)` both produce a working socket in a two-tab test. Only the latter permits hibernation. There is no error to catch — the difference shows up as duration billing and as state loss under eviction, neither visible in the manual test. Treat the choice as load-bearing.

**The reveal must be gated server-side, not client-side.** The opponent's move must not be sent over the wire until both commits exist in storage. A client that hides a received value is not equivalent and violates the PRD guardrail — it is defeated by opening devtools.

---

## Phase 1: Worker entrypoint & Durable Object binding

### Overview

Replace the worker entrypoint with our own, register the Durable Object with a SQLite-backed migration, and generate typed bindings. The room accepts a socket and echoes; it implements no game rules. The goal of this phase is to prove the front door is inert.

### Changes Required:

#### 1. Custom worker entrypoint

**File**: `src/worker.ts` (new)

**Intent**: Intercept the room's WebSocket upgrade before Astro's handler can touch the response, and pass everything else through to the stock adapter handler unchanged.

**Contract**: Default-exports an object with a `fetch(request, env, ctx)` handler, and re-exports the `MatchRoom` class so Wrangler can find it. Delegates to `handle` from `@astrojs/cloudflare/handler` for every request that is not a room upgrade. Room URLs are `/ws/match/<uuid>` — a path with no corresponding Astro route, so nothing shadows a real page.

The gate is the one piece worth spelling out, because its narrowness is the safety property and the delegation target is easy to get wrong:

```ts
const ROOM_PREFIX = "/ws/match/";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (url.pathname.startsWith(ROOM_PREFIX) && isUpgrade) {
      // ... resolve room id, validate, forward to the DO stub
    }
    return handle(request, env, ctx);
  },
};
export { MatchRoom };
```

#### 2. Durable Object registration

**File**: `wrangler.jsonc`

**Intent**: Point the Worker at our entrypoint and register the Durable Object class with the SQLite storage backend.

**Contract**: `main` becomes `./src/worker.ts`. A `durable_objects.bindings` entry binds name `MATCH_ROOM` to class `MatchRoom`. A `migrations` entry declares the class as SQLite-backed. The exact shape matters because it is one-way and because `wrangler@4.90.0` rejects the newer declarative alternative:

```jsonc
"durable_objects": { "bindings": [{ "name": "MATCH_ROOM", "class_name": "MatchRoom" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MatchRoom"] }]
```

#### 3. Minimal room class

**File**: `src/durable/match-room.ts` (new)

**Intent**: Stand up the smallest Durable Object that completes a WebSocket handshake, so the entrypoint wiring can be verified before any game logic exists.

**Contract**: Exports `class MatchRoom extends DurableObject` from `cloudflare:workers`. Its `fetch` creates a `WebSocketPair`, registers the server side with `ctx.acceptWebSocket` (**not** `ws.accept()`), and returns a 101 response. A `webSocketMessage` handler echoes the received frame. No storage, no seats, no validation yet.

#### 4. Typed bindings

**File**: `worker-configuration.d.ts` (generated, committed)

**Intent**: Give `Env` a real type so the binding is checked at build time rather than being `any`.

**Contract**: Output of `npx wrangler types`, committed. No `tsconfig.json` change is needed — `"include": ["**/*"]` already covers a root-level declaration file. Add `@cloudflare/workers-types` only if `wrangler types` output requires it; prefer the generated file alone.

### Success Criteria:

#### Automated Verification:

- Type checking passes with the typed binding: `npx tsc --noEmit`
- Build succeeds with the custom entrypoint: `npm run build`
- Linting passes: `npm run lint`
- `wrangler.jsonc` declares the class as SQLite-backed: `grep -q new_sqlite_classes wrangler.jsonc`

#### Manual Verification:

- Every existing route still behaves as before under `npm run dev`: sign in, sign out, `/dashboard` redirect when logged out, and the static pages
- A WebSocket client connecting to `/ws/match/<uuid>` receives its echoed frame
- A plain (non-upgrade) GET to `/ws/match/<uuid>` is not intercepted — it falls through to Astro and 404s

**Implementation Note**: The third manual check is the one that catches an over-broad gate. After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: Room protocol & hidden reveal

### Overview

Turn the echo room into the mechanic: two seats, durable commits, a reveal that fires only when both are in, and the structural containment that bounds what an anonymous caller can consume.

### Changes Required:

#### 1. Seat assignment and connection limits

**File**: `src/durable/match-room.ts`

**Intent**: Give each socket a distinct, hibernation-surviving identity, and refuse connections beyond the two a match can have.

**Contract**: On connect, the room assigns the first free seat (`"a"` or `"b"`), persists it on the socket via `serializeAttachment`, and passes it as a tag to `ctx.acceptWebSocket` so `ctx.getWebSockets(tag)` can address one seat. A third concurrent socket is rejected before the handshake with a 409. Seat occupancy derives from `ctx.getWebSockets()` plus storage, never from an instance field.

#### 2. Room id validation

**File**: `src/worker.ts`

**Intent**: Bound the keyspace that can create Durable Objects, since the endpoint is open by decision.

**Contract**: The path segment after `/ws/match/` must match a canonical UUID pattern; anything else gets a 400 and no stub is ever obtained. The object id derives deterministically via `env.MATCH_ROOM.idFromName(matchId)` so both tabs on the same URL reach the same instance.

#### 3. Commit, reveal, and durable round state

**File**: `src/durable/match-room.ts`

**Intent**: Hold each player's move server-side until both exist, then reveal both at once — the product's core guarantee.

**Contract**: Four message types over JSON. Server → client: `seat` (assigned seat), `state` (which seats have committed — **never** the opponent's move), `reveal` (both moves, once). Client → server: `commit` (the sender's move, one of `cooperate` / `sabotage`, matching the PRD's Współpraca/Sabotaż). Moves are written to `ctx.storage` keyed per seat. After each commit the room re-reads storage and broadcasts `reveal` only when both keys exist; otherwise it broadcasts `state`. A second `commit` from an already-committed seat is ignored rather than overwriting.

The storage read-after-write on every commit is the non-obvious part: it is what makes the mechanic correct across a hibernation that lands between the two commits, and it is why in-memory move fields must not exist at all.

#### 4. Connection snapshot and terminal cleanup

**File**: `src/durable/match-room.ts`

**Intent**: Let a reloaded tab recover its own view, and stop abandoned rooms accumulating storage indefinitely.

**Contract**: A connecting socket immediately receives `seat` followed by `state` reflecting current commit flags — and, if the round is already revealed, `reveal`. Once the round is terminal, the room calls `ctx.storage.deleteAll()`. Hibernation handlers `webSocketClose` and `webSocketError` are implemented so a closing socket frees its seat. `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` provides keepalive without waking the object.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Build succeeds: `npm run build`
- Linting passes: `npm run lint`
- No in-memory move state exists — committed moves are only ever read from storage: `grep -nE "this\.(moveA|moveB|moves)" src/durable/match-room.ts` returns nothing
- Hibernation is not disabled anywhere: `grep -n "\.accept()" src/durable/match-room.ts` returns nothing

#### Manual Verification:

- A malformed room id (not a UUID) is rejected with 400 and creates no object
- A third socket to an occupied room is rejected
- Two sockets on the same room id are assigned different seats
- Reloading one tab mid-round restores its own commit state without revealing the opponent's move

**Implementation Note**: The two `grep` criteria are cheap proxies for the two mistakes this phase is most likely to make silently — in-memory state that survives the manual test but not hibernation, and `ws.accept()` disabling hibernation with no error. After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 3: Verification page & local two-tab test

### Overview

Build the throwaway page that makes the core guarantee directly observable, and run the two-tab test locally against real `workerd`.

### Changes Required:

#### 1. Throwaway room page

**File**: `src/pages/dev/match-room.astro` (new)

**Intent**: Provide the minimum surface needed to open a socket, submit a move, and watch the reveal — enough to prove the mechanic, not the beginnings of the S-03 match screen.

**Contract**: Reads the room id from a query parameter so both tabs can be pointed at the same room by URL. Renders two buttons (cooperate / sabotage), a connection/seat indicator, and a log of received messages. Deliberately **not** added to `PROTECTED_ROUTES` in `src/middleware.ts` and **not** linked from any navigation. Client-side script only — no server-side Supabase involvement.

Keep the received-message log raw and visible: the guarantee being verified is that the opponent's move is absent from the wire before reveal, and a rendered log is the cheapest way for a human to confirm that without devtools.

### Success Criteria:

#### Automated Verification:

- Build succeeds with the new page: `npm run build`
- Linting passes: `npm run lint`
- The page is not gated: `grep -q "dev/match-room" src/middleware.ts` returns nothing

#### Manual Verification:

- Two tabs on the same room id each show a distinct seat
- Committing in tab A changes nothing visible in tab B, and B's message log contains no move value
- Committing in tab B causes both tabs to reveal both moves at the same time
- Reloading a tab after one commit restores its own state without leaking the opponent's move
- The round is terminal — further commits change nothing

**Implementation Note**: The second manual item is the actual product guarantee; verify it by reading tab B's raw message log, not just its rendered UI. After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 4: Deploy & validate on Cloudflare

### Overview

Ship it and confirm the Durable Object namespace was created with the SQLite backend — the one decision in this change that cannot be corrected by editing config.

### Changes Required:

#### 1. Deploy through CI

**File**: none — uses the existing pipeline

**Intent**: Publish via the project's designed path so the deployed state stays reproducible from git.

**Contract**: Push to `master`. `.github/workflows/ci.yml` runs `astro sync`, `lint` and `build`, then the `deploy` job runs `wrangler deploy` and re-syncs `SUPABASE_URL`/`SUPABASE_KEY` as Workers Secrets. No local `npm run deploy` — that would bypass the CI gate and publish code that is not on the remote.

### Success Criteria:

#### Automated Verification:

- CI completes with both jobs green: `gh run list --branch master --limit 1`
- The deployment is live and current: `npx wrangler deployments status --name prisoners-dilemma-tournament`

#### Manual Verification:

- The Cloudflare dashboard shows the `MatchRoom` Durable Object namespace with the **SQLite** storage backend, not KV
- The two-tab test from Phase 3 passes against the deployed URL
- Existing production auth flows still work — sign in, sign out, `/dashboard` gating
- A malformed room id is rejected in production too

**Implementation Note**: The SQLite-backend check is the one irreversible item in this plan. If the namespace was created KV-backed, the fix is a renamed class and a new migration tag — not a config edit. Verify it before building anything on top. After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Testing Strategy

No test runner is configured in this repository, and introducing one is out of scope for this change. Verification is therefore build-level, grep-level, and manual — with the manual half carrying the real weight, because the property being verified is a timing guarantee.

### Automated (per phase):

- `npx tsc --noEmit` — the only genuine typecheck; Vite strips types without checking them, so `npm run build` alone does not cover this
- `npm run build` — catches entrypoint and adapter wiring errors
- `npm run lint`
- Two structural `grep` checks in Phase 2, standing in for the two failure modes that pass a manual test but break under hibernation

### Manual Testing Steps:

1. Open `/dev/match-room?id=<uuid>` in two tabs; confirm distinct seats
2. Commit in tab A; confirm tab B's rendered UI **and raw message log** contain no move value
3. Commit in tab B; confirm both tabs reveal both moves simultaneously
4. Reload tab A mid-round (before B commits); confirm its own commit state returns and B's move is still absent
5. Open a third tab on the same room id; confirm rejection
6. Request a malformed room id; confirm 400 and that no object is created
7. Exercise every existing route to confirm the custom entrypoint changed nothing: sign in, sign out, `/dashboard` redirect, static pages

### Deferred to S-03:

Socket authentication, verification that the connecting player is actually one of the match's two players, client reconnect with backoff, the multi-round loop, and persistence of round outcomes to Postgres. Each is a deliberate omission recorded above, not an oversight.

## Performance Considerations

Negligible at this scale — two sockets per room, one round, a camp-sized event. Two forms matter anyway because getting them wrong is invisible in a manual test: `ctx.acceptWebSocket` rather than `ws.accept()`, so the object hibernates instead of billing duration while idle; and `setWebSocketAutoResponse` for ping/pong, so keepalive traffic does not wake it. Storage reads are two keys per commit.

## Migration Notes

`new_sqlite_classes` is one-way — the SQLite backend cannot be enabled on an already-deployed Durable Object class, and KV-backed namespace creation has been blocked account-wide since 2026-07-09. If the first deploy lands without it, recovery is a renamed class plus a new migration tag, not a config change. There is no data to migrate; nothing in this change touches Postgres.

Rollback is reverting `main` in `wrangler.jsonc` to `@astrojs/cloudflare/entrypoints/server` and redeploying, which restores the stock request path exactly. The Durable Object namespace persists but becomes unreachable — harmless, since abandoned rooms wipe their own storage.

## References

- Roadmap item: `context/foundation/roadmap.md` → F-02
- Locked decisions and Cloudflare research: `context/changes/realtime-match-scaffold/change.md`
- Upstream dependency: `context/changes/tournament-data-model/plan.md` — F-01 created the `matches` table this change's room ids will eventually reference
- Adapter constraint: `node_modules/@astrojs/cloudflare/dist/utils/handler.js:102-105`
- Adapter entrypoint resolution: `node_modules/@astrojs/cloudflare/dist/wrangler.js:31`
- Existing middleware and route gating: `src/middleware.ts:4,12`
- Project conventions: `AGENTS.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Worker entrypoint & Durable Object binding

#### Automated

- [x] 1.1 Type checking passes: `npx tsc --noEmit` — 3b14376
- [x] 1.2 Build succeeds with the custom entrypoint: `npm run build` — 3b14376
- [x] 1.3 Linting passes: `npm run lint` — 3b14376
- [x] 1.4 `wrangler.jsonc` declares the class as SQLite-backed — 3b14376

#### Manual

- [ ] 1.5 Every existing route still behaves as before under `npm run dev`
- [ ] 1.6 A WebSocket client connecting to `/ws/match/<uuid>` receives its echoed frame
- [ ] 1.7 A plain GET to `/ws/match/<uuid>` is not intercepted and 404s

### Phase 2: Room protocol & hidden reveal

#### Automated

- [x] 2.1 Type checking passes: `npx tsc --noEmit`
- [x] 2.2 Build succeeds: `npm run build`
- [x] 2.3 Linting passes: `npm run lint`
- [x] 2.4 No in-memory move state exists
- [x] 2.5 Hibernation is not disabled anywhere

#### Manual

- [ ] 2.6 A malformed room id is rejected with 400 and creates no object
- [ ] 2.7 A third socket to an occupied room is rejected
- [ ] 2.8 Two sockets on the same room id are assigned different seats
- [ ] 2.9 Reloading one tab mid-round restores its own commit state without revealing the opponent's move

### Phase 3: Verification page & local two-tab test

#### Automated

- [ ] 3.1 Build succeeds with the new page: `npm run build`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 The page is not gated in `src/middleware.ts`

#### Manual

- [ ] 3.4 Two tabs on the same room id each show a distinct seat
- [ ] 3.5 Committing in tab A leaves tab B's UI and raw message log free of any move value
- [ ] 3.6 Committing in tab B reveals both moves in both tabs simultaneously
- [ ] 3.7 Reloading a tab after one commit restores its own state without leaking the opponent's move
- [ ] 3.8 The round is terminal — further commits change nothing

### Phase 4: Deploy & validate on Cloudflare

#### Automated

- [ ] 4.1 CI completes with both jobs green
- [ ] 4.2 The deployment is live and current

#### Manual

- [ ] 4.3 The `MatchRoom` namespace shows the SQLite storage backend, not KV
- [ ] 4.4 The two-tab test passes against the deployed URL
- [ ] 4.5 Existing production auth flows still work
- [ ] 4.6 A malformed room id is rejected in production
