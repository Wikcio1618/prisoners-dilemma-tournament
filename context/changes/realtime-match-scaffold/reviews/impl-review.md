<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Realtime Match Scaffold

- **Plan**: context/changes/realtime-match-scaffold/plan.md
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-07-30
- **Verdict**: REJECTED
- **Findings**: 3 critical, 4 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | WARNING |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | FAIL |

## What is clean

Verified, so it does not reappear as findings:

- **The entrypoint architecture is sound and confirmed.** `handle` is a real export, the stock entrypoint is verbatim `{ fetch: handle }`, the `Set-Cookie`/immutable-headers rationale holds, and the gate at `src/worker.ts:36` is correctly conjunctive. Production auth verified working end to end.
- **UUID validation is correctly placed** — before `idFromName`, anchored, not percent-decoded, no trailing-newline bypass.
- **Seat assignment has no race.** `freeSeat()` → `acceptWebSocket` → `serializeAttachment` contains no `await`; the first is at `:69`, after the seat is claimed. Load-bearing and currently undocumented.
- **Hibernation discipline is correct.** Moves live only in `ctx.storage`, re-read on every commit. The reveal cannot fire with one real move via the normal path.
- **No XSS in the dev harness.** Every DOM sink is `textContent`; `define:vars` escapes `<`. Category clean.
- **`serializeAttachment` ordering and `ws.send()` before the 101 are both valid.**
- **All automated criteria pass**: `tsc --noEmit`, `lint`, `build`, plus the four structural greps.

## Findings

### F1 — Reconnect reseats a player, leaking a move to someone who never committed

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:131-134
- **Detail**: `freeSeat()` returns the first seat with no *live socket*, ignoring whether that seat already holds a committed move. The plan's contract said occupancy derives from "`ctx.getWebSockets()` **plus storage**"; storage was omitted. No attacker required — a dropped connection and a slow second player is enough. Trace: (1) A connects, seat `a`, commits `cooperate`. (2) A's tab closes; seat `a` frees. (3) B connects for the first time and is handed seat `a`, now sitting on A's move. (4) B commits — refused at `:98` because `existing.a` is set; B can never play. (5) A reconnects, gets seat `b`, commits. (6) `broadcast` at `:111` sends the reveal to **both** sockets, so B learns A's move having committed nothing. This is the product guarantee failing between two honest players.
- **Fix**: Make a seat free only when it has no live socket **and** no committed move — `freeSeat` must `await this.readMoves()` and exclude committed seats.
  - Strength: Closes the no-attacker path directly and restores the contract the plan actually specified.
  - Tradeoff: Introduces an `await` inside `freeSeat`, which creates the yield point that currently does not exist — the read must happen *before* the free-seat computation, keeping compute→`acceptWebSocket` await-free or the no-race property in "What is clean" is lost.
  - Confidence: HIGH — the trace is mechanical and the fix is the plan's own wording.
  - Blind spot: Does not address identity (F10); a stranger can still take a genuinely free seat.
- **Decision**: FIXED via identity binding (stronger than the proposed fix) — seats now resolve from the authenticated Supabase user id, not arrival order. A returning player reclaims their own seat; nobody can inherit a seat holding someone else's move. Verified locally: newcomer no longer inherits a committed seat.

### F2 — The round is not terminal; rooms are infinitely replayable

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:98,114
- **Detail**: `deleteAll()` at `:114` wipes storage but nothing marks the round done, no socket is closed, and `webSocketMessage` has no terminal check. Because the wipe erases the very keys the already-committed guard at `:98` reads, it *resets* the room rather than sealing it. **Confirmed empirically against the deployed Worker**: after a completed round, a fresh commit on the same socket produced `{"type":"state","committed":{"a":true,"b":false}}` — a new round on wiped storage — and the opponent's commit fired a second `{"type":"reveal",...}`. Unlimited rounds are possible on one connection, with both players already knowing the previous round's moves. For an iterated Prisoner's Dilemma that is a scoring exploit, and it violates the plan's explicit guardrail "Exactly one round, then terminal". Terminality exists **only in the client** (`match-room.astro:122` disables the buttons) — the same class of mistake the plan forbids at line 61 for concealment, applied to termination.
- **Fix**: Persist a terminal marker that `deleteAll()` does not clear (or write it after the wipe), and reject commits once set.
  - Strength: Makes the round genuinely one-shot, makes the currently-unreachable reveal-on-connect branch at `:71` reachable as the contract intended, and gives Progress item 3.8 something real to mean.
  - Tradeoff: A small record now outlives the round, so the "abandoned rooms accumulate nothing" story needs the TTL in F6 rather than the wipe.
  - Confidence: HIGH — reproduced on production.
  - Blind spot: Whether S-03 wants a finished room to remain readable (replay/history) or to hard-close both sockets is a product call not yet made.
- **Decision**: FIXED — `deleteAll()` removed. Persisted moves are what make the round terminal: the already-committed guard now fires after a reveal. Verified on the deployed build before the fix (second reveal fired) and locally after (post-reveal commits return only `state{a:true,b:true}`).

### F3 — Unguarded broadcast can skip the wipe, leaving moves a later connector receives in full

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:111-114,178-183
- **Detail**: `broadcast()` iterates `ctx.getWebSockets()` and calls `ws.send()` with no `try`/`catch`, and `webSocketMessage` has no error handling. A send on a socket in teardown throws; the rejection propagates out of the handler, so `:114` `deleteAll()` never runs. Both moves then persist indefinitely — there is no `alarm()`, no TTL, no other cleanup. Any later anonymous connection to that room id hits `:69-71`, `isComplete()` is true, and it immediately receives `{"type":"reveal","moves":{...}}` with both moves, having committed nothing. The same disclosure follows from any transient storage failure at `:114`. This is also what makes the `:71` branch — dead code on every normal path — reachable precisely in the failure case.
- **Fix**: Wrap each `ws.send()` in `broadcast()` in `try`/`catch`, wrap the `webSocketMessage` body, and move `deleteAll()` into a `finally`.
  - Strength: Removes an information-disclosure path with a few lines and no design change.
  - Tradeoff: None significant.
  - Confidence: HIGH — sending on a closed socket throws in the Workers runtime.
  - Blind spot: Not reproduced live; the reasoning is from the code path, not an observed failure.
- **Decision**: FIXED — every `ws.send` is wrapped, `webSocketMessage` delegates to a guarded `handleMessage`, and `close()` is called through `closeQuietly`. With `deleteAll()` gone, the skipped-wipe disclosure path no longer exists at all.

### F4 — Case-insensitive room-id regex against a case-sensitive idFromName

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/worker.ts:29,42
- **Detail**: `ROOM_ID_PATTERN` carries the `/i` flag, but `idFromName` is case-sensitive. **Confirmed on production**: a lowercase UUID and its uppercase form were both assigned seat `a`, which is only possible if two different Durable Objects were minted. Two clients that normalise case differently land in separate rooms and never see each other — a silent, baffling failure. It also multiplies the object-creation surface of an already-open endpoint by 2^32 per logical room.
- **Fix**: Lowercase the room id before `idFromName` (or drop `/i` and require canonical lowercase).
- **Decision**: FIXED — room id is lowercased before `idFromName`. Verified locally: a UUID and its uppercase form now reach the same room (seats a/b).

### F5 — `playerId` missing from the protocol, though plan, brief and change.md all state it is present

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/durable/match-room.ts:10-13
- **Detail**: `plan.md:38`, `plan-brief.md` and `change.md` each assert "the protocol carries a `playerId` field so S-03 adds *verification* rather than restructuring the handshake." `ClientMessage` is `{ type: "commit"; move: Move }` — there is no `playerId` anywhere. The sentence exists specifically to promise S-03 a cheap upgrade path, and that promise is now false: S-03 must restructure the handshake. It also removes the only mechanism that could distinguish "A reconnecting" from "a stranger arriving" in F1.
- **Fix A ⭐ Recommended**: Add the `playerId` field to `ClientMessage` and the harness now, unvalidated, exactly as the plan describes.
  - Strength: Restores the plan's stated seam at near-zero cost while the surface is still tiny; S-03 then adds verification rather than redesigning.
  - Tradeoff: Ships a field nothing reads, which can read as dead weight without the comment explaining why.
  - Confidence: HIGH — it is a two-line type change plus one harness field.
  - Blind spot: Whether S-03 wants identity in the message body or in the upgrade URL/headers; the latter would make this field redundant.
- **Fix B**: Amend the plan, brief and change.md to record that `playerId` was dropped and S-03 owns the handshake change.
  - Strength: Keeps the code minimal and makes the documents honest, which matters more than the field itself.
  - Tradeoff: S-03 inherits strictly more work, and the seam the plan reasoned about no longer exists.
  - Confidence: HIGH — documentation-only.
  - Blind spot: None significant.
- **Decision**: SUPERSEDED — `playerId` in the message body was the wrong seam. Identity now arrives from the session via the `X-Player-Id` header, set by the entrypoint after `getUser()` and overwriting anything a client sends. S-03 inherits working verification rather than an unverified field.

### F6 — Abandoned rooms are never wiped; the plan's containment rationale is inverted

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:112-114
- **Detail**: `plan.md:53` justifies the wipe as "storage is wiped once the round is terminal so abandoned rooms do not accumulate." The wipe fires only on *completed* rounds. A genuinely abandoned room — A commits, B never arrives — keeps `move:a` forever, with no alarm and no TTL. The rooms the cleanup was justified by are exactly the ones it never touches. On an unauthenticated endpoint this is the resource-consumption path: connect with a random UUID, commit once, disconnect, repeat — each iteration mints a persistent SQLite-backed object that nothing reclaims.
- **Fix**: Add an `alarm()`-based TTL that calls `deleteAll()` on any room whose round is incomplete after N minutes.
  - Strength: Makes the containment claim true, and is the same mechanism F2's terminal marker needs for its own cleanup.
  - Tradeoff: Alarms are new machinery in a change scoped to isolate one unknown; the plan explicitly avoided timers.
  - Confidence: MEDIUM — straightforward, but untried in this codebase.
  - Blind spot: No measurement of actual accumulation; the risk is currently theoretical.
- **Decision**: PENDING

### F7 — Debug harness live on production as a ready-made client for the open endpoint

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dev/match-room.astro:14
- **Detail**: `export const prerender = false` with `output: "server"` makes `/dev/match-room` a live, unauthenticated production route, deliberately absent from `PROTECTED_ROUTES`. Its existence is not itself the vulnerability, but it removes all effort from exploiting the open socket: paste any room UUID into `?id=` and take a seat. The plan called it "a throwaway page kept off site navigation" — unlinked is not the same as unreachable.
- **Fix**: Gate the route behind `import.meta.env.DEV` or return 404 in production.
- **Decision**: PENDING

### F8 — No frame-size or rate guard; storage read precedes the short-circuit

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:97,159
- **Detail**: Every inbound message that parses and has a seat performs `await this.readMoves()` *before* the already-committed short-circuit at `:98`, so a seated socket can drive one billed storage read per frame. Frames up to 1 MiB reach `JSON.parse` with no length guard. The plan explicitly declined rate limiting, so this is scope-consistent — noted because it compounds F6 on an open endpoint.
- **Fix**: Reject oversized frames before parsing and cache the seat's committed state as a fast-path reject, keeping storage authoritative for the completeness check.
- **Decision**: PENDING

### F9 — Zombie sockets hold seats; no opponent-left signal; `webSocketError` unguarded

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/durable/match-room.ts:120-128
- **Detail**: `webSocketClose` calling `ws.close()` is the documented pattern, but an abrupt network loss with no close frame leaves the socket enumerated until the runtime notices; during that window a reconnecting player gets 409. No message tells the surviving player their opponent left, and the harness has no retry by design, so they wait on a live socket indefinitely. `webSocketError` calls `close()` on an already-errored socket without a guard. Also, `freeSeat()` has no floor on socket count: if `seatOf()` ever returned `null` for a live socket, both seats would read free and a third socket could join on a duplicate seat — unreachable today, cheap to harden with `if (this.ctx.getWebSockets().length >= 2) return null;`.
- **Fix**: Pass an explicit code/reason to `close()`, wrap both handlers, broadcast an `opponent-left` message, and add the socket-count floor.
- **Decision**: PENDING

### F10 — Seat theft and room denial-of-service follow from the accepted no-auth decision

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: src/durable/match-room.ts:57
- **Detail**: Recorded as accepted risk, not as drift — "no socket authentication" and "deploy fully open" were both explicit decisions. Consequences, stated concretely so S-03 inherits them precisely: anyone who learns a room UUID can (a) take a free seat, commit, and read the real player's move in the reveal; (b) hold both sockets open — the ping/pong auto-response keeps them alive without waking the object — so both legitimate players get 409 indefinitely; (c) commit both moves before the real players arrive, fabricating a completed round. A room also acts as a liveness oracle: a fresh room answers `state{a:false,b:false}`, an active one 409 or `{a:true,…}`. None of this is exploitable without the UUID, and the keyspace defeats enumeration — but a leaked id (Referer, screen share) makes it targetable.
- **Fix**: Bind seats to an identity carried in the upgrade — the Supabase session cookie is already available in `src/worker.ts` before the stub is obtained — and reject sockets that are not one of the match's two players. This is S-03 scope by design; until it lands, treat any result from this endpoint as unauthenticated and never persist it.
- **Decision**: PARTIALLY RESOLVED — seat theft and both-seat DoS between logged-in users are closed by identity binding; anonymous upgrades are rejected outright. NOT closed: any logged-in user can still join any room UUID, because match-membership checking stays deferred (it needs `public.matches` rows that S-02 has yet to write).
