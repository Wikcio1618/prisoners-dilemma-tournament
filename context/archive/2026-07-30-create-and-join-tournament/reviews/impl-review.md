<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Create and Join Tournament

- **Plan**: context/changes/create-and-join-tournament/plan.md
- **Scope**: Phases 1–5 of 5 (full plan)
- **Date**: 2026-07-30
- **Verdict**: REJECTED
- **Findings**: 2 critical, 7 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## What is clean

Verified, so it does not reappear as findings:

- **No XSS anywhere.** Every query-parameter value reaches the DOM through Astro text expressions or React props, both of which escape. No `set:html`, no `dangerouslySetInnerHTML`.
- **CSRF is correctly handled.** Astro's `checkOrigin` is active because `output: "server"`; no route bypasses it.
- **The collision retry loop is correct** — it continues only on SQLSTATE `23505`, returns immediately on anything else, and handles exhaustion with a distinct message rather than falling through to success.
- **The roster 404 is genuinely non-probeable** — "doesn't exist" and "not yours" reach an identical branch with identical body and status. `join_code` is selected but never reaches the response.
- **No hand-written ownership filters in any read path.** The tournament list has no `WHERE` on ownership; RLS is the only thing scoping it, as the plan required.
- **Tournament ids are not enumerable** — 128-bit UUIDs, identical not-found for both cases.
- **No scope creep.** No `matches` access, no pairing, no started-tournament UI beyond the planned placeholder. All seven "What We're NOT Doing" guardrails hold.
- **All automated criteria pass**: `tsc --noEmit`, `lint`, `build`, migration state.

## Findings

### F1 — Open redirect: safeRedirect is bypassed by a tab character

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/safe-redirect.ts:15-17
- **Detail**: The guard rejects `//` and `/\` but nothing else. The WHATWG URL parser strips ASCII tab/LF/CR *before* parsing, so `/<TAB>/evil.example` becomes protocol-relative `//evil.example` in the browser. **Confirmed exploitable against the deployed app**: `POST /api/auth/signin` with `next=/<TAB>/evil.example` returns `location: /<TAB>/evil.example`, and `new URL("/\t/evil.example", base)` resolves to `https://evil.example/`. `Headers.set` accepts HTAB as a legal field-value byte, so the redirect ships. The victim authenticates for real, receives a valid session, and is then handed to the attacker's site by the genuine login flow — exactly what this file's docstring says it prevents. The CR/LF variant is a different failure: `Headers.set` *throws* on LF, so `next=/%0A/x` produces a 500 after a successful `signInWithPassword`, leaving the user authenticated server-side but seeing a crash with no cookie. Manual check 3.7 as written (`https://example.com`, `//example.com`) could never have caught this.
- **Fix**: Stop pattern-matching the raw string. Strip `[\t\n\r]` first — validating what the browser will actually see — then parse against a placeholder origin and reject anything whose origin changed, returning only `pathname + search + hash`.
  - Strength: Closes tab, CR, LF and any future parser-normalisation trick in one move, rather than blacklisting known glyphs.
  - Tradeoff: None significant; a few lines in one function with a single call site.
  - Confidence: HIGH — the exploit and the fix were both verified against the runtime.
  - Blind spot: None significant.
- **Decision**: FIXED — `safeRedirect` now strips the characters the URL parser strips, resolves against a placeholder origin, requires the origin to be unchanged, and returns a re-serialised path so no residual control character reaches the Location header. Verified against 14 cases including the confirmed bypass; nothing resolves off-origin.

### F2 — Join-code enumeration grants irrevocable membership

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/tournaments/join.ts:41-48
- **Detail**: `POST /api/tournaments/join` is an existence oracle over the whole 10⁶ keyspace with nothing in front of it — no rate limit, and `checkOrigin` does not impede a script that sets its own `Origin`. The four outcomes are trivially distinguishable by redirect target alone. The keyspace narrowing was accepted knowingly, but on the understanding that enumeration reveals *existence*. It does more than that: **a hit is a write, not a read.** `join_tournament` enrols the caller on success, `tournament_players` has no INSERT policy and no creator-kick path, so every discovered lobby is permanently polluted — and 50 hits on one code fills it to the cap and locks out the real players. That is a different severity class from the risk that was accepted, and it is deployed.
- **Fix A ⭐ Recommended**: Add a per-user throttle on the join path now — a small counter keyed on user id, failing hard after ~10 failed attempts in a window — and add a creator-kick path so a polluted lobby is recoverable.
  - Strength: Attacks the mechanism rather than the symptom, and the kick path is independently needed since a mis-join is currently unrecoverable by anyone but the joiner.
  - Tradeoff: Pulls rate limiting forward from S-03 and needs somewhere to hold counters; the kick path needs a new RLS policy or definer function.
  - Confidence: MED — the throttle is straightforward, but the storage choice (KV, Durable Object, Postgres) has not been designed.
  - Blind spot: Have not measured whether a naive Postgres counter adds meaningful latency to the join path.
- **Fix B**: Revert to a longer alphanumeric code, restoring the ~10¹¹ keyspace.
  - Strength: Removes enumeration as a practical attack outright, with one migration and two constants.
  - Tradeoff: Undoes a deliberate product decision about codes being read aloud in a noisy room, and does nothing about the missing kick path.
  - Confidence: HIGH — it is the state the schema was in yesterday.
  - Blind spot: None significant.
- **Decision**: ACCEPTED — risk accepted for a camp-scale app: no realistic attacker is scripting a youth-camp tournament, and the 6-digit code was chosen deliberately so it can be read aloud in a noisy room. Recorded rather than mitigated. Revisit before any wider audience: the mitigations remain a per-user throttle on the join path plus a creator-kick so a polluted lobby is recoverable.

### F3 — Unbounded creation permanently exhausts the global join-code space

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/tournaments/index.ts:17,42
- **Detail**: `join_code` is unique across the whole table forever, including finished and abandoned tournaments, and nothing caps creation per user or reclaims codes. With `CODE_ATTEMPTS = 5`, once N codes are taken every user's creation fails with probability `(N/10⁶)⁵` — roughly 3% at 500k rows and 59% at 900k. One authenticated account looping create can therefore degrade tournament creation for everyone, and there is no in-app path to reclaim the space. Recoverable by deleting rows in the dashboard, which is why this is a warning rather than critical.
- **Fix**: Cap concurrent `lobby` tournaments per creator and add a reaper for stale lobbies; longer term make codes reclaimable rather than globally unique forever.
  - Strength: Bounds the damage without touching the code format the product decision settled.
  - Tradeoff: A reaper is new machinery and needs a staleness definition nobody has chosen yet.
  - Confidence: MED — the cap is easy; the reclamation policy is a real design question.
  - Blind spot: No data on realistic tournament volume, so the cap threshold would be a guess.
- **Decision**: DEFERRED — recoverable by deleting rows in the dashboard, and requires sustained abuse (~10^6 authenticated requests). Same root as F2 (no rate limiting); revisit together.

### F4 — The creator can leave, then start a tournament with zero players

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/tournaments/[id]/leave.ts:30-35
- **Detail**: The DELETE policy is self-only-in-lobby, and the creator's own membership row satisfies it. `[id].astro:101` only *hides* the button. **Confirmed on production**: two POSTs — leave, then start — produced a `started` tournament with `creator_id` set and **0 players**. That is exactly the orphan state the create route's rollback at `index.ts:73` exists to prevent, reachable by a different route. S-02's pairing would inherit it.
- **Fix**: Exclude the creator in the DELETE policy, or make a creator leaving delete the tournament. Hiding the button is not enforcement — the same lesson F-01's review produced about the start button.
- **Decision**: FIXED — `20260731163754_creator_cannot_leave_own_tournament.sql` excludes the creator from the self-leave policy. A creator wanting rid of their tournament deletes the tournament itself, which the creator-delete policy already permits in lobby.

### F5 — The orphan rollback discards its result and can leave the user told the opposite of the truth

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/tournaments/index.ts:73
- **Detail**: `await supabase.from("tournaments").delete().eq("id", tournamentId)` inspects neither error nor rows affected. If the delete fails — most plausibly the same transient condition that just broke the RPC — the tournament survives with zero members, appears in the creator's list, renders a join code, and is startable, while the user is told creation failed. The plan's "handle that failure explicitly" is satisfied in the surfacing branch, but the compensating action is attempted rather than verified.
- **Fix**: Add `.select("id")` and branch on the result; on failure surface a message naming the tournament id so the state is recoverable. The real fix is a `create_tournament` definer function making insert-plus-enrol one transaction.
- **Decision**: FIXED — the rollback delete now uses `.select("id")` and checks both error and rows affected; a failed undo surfaces a distinct message telling the user the tournament exists and is on their list, rather than claiming creation failed.

### F6 — The lobby poll never stops on a persistent 404 or 500

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/tournament/LobbyRoster.tsx:48
- **Detail**: `if (!res.ok) return;` swallows the failure and the interval keeps firing. After a member leaves in another tab, or their session expires, the endpoint returns 404 on every poll and the tab keeps requesting every 4s indefinitely — ~900 requests/hour/tab with no backoff and no user-visible signal. Compounds F2's absence of rate limiting.
- **Fix**: Treat 401/404 as terminal immediately, count consecutive failures otherwise, and render a "connection lost / refresh" state after a few.
- **Decision**: FIXED — 401/403/404 are terminal immediately, other failures tolerated up to 3 consecutive before the poll stops; a Polish 'connection lost, refresh' line renders when it does.

### F7 — start reports success when the policy refused, and has no auth guard

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/tournaments/[id]/start.ts:25-32
- **Detail**: The update has no `.select()`, so rows-affected is never observed and `error === null` covers four distinct outcomes: already started, not the creator, tournament absent, genuine success. A non-creator's POST gets a clean 302 to the lobby with no error — the status correctly does not change, but the response is indistinguishable from success. Symmetrically, a future policy regression refusing a legitimate creator would report nothing. `leave.ts` does check rows affected; these two siblings were written in the same commit with opposite discipline, and `start.ts` also omits the `getUser()` guard its sibling has. Nothing enforces a minimum player count either, which is what makes F4's zero-player start reachable.
- **Fix A ⭐ Recommended**: Add `.select("id")` and branch on the row count, distinguishing already-started (idempotent success) from refused.
  - Strength: Matches `leave.ts`, makes a policy regression visible rather than silent, and costs one chained call.
  - Tradeoff: Must keep treating zero-rows-because-already-started as success, so the branch needs the current status to tell the two apart.
  - Confidence: HIGH — the pattern already exists in the sibling route.
  - Blind spot: None significant.
- **Fix B**: Leave as-is and rely on the policy, documenting that the route is intentionally blind.
  - Strength: No change; behaviour is already correct in every case that matters today.
  - Tradeoff: A policy regression would be invisible, which is the failure mode this whole slice was meant to guard against.
  - Confidence: HIGH — behaviour verified.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — `.select("id")` on the update, and a zero-row result re-reads the status to distinguish already-started (idempotent success) from a policy refusal, which now surfaces a permissions message.

### F8 — Attacker-controlled prose renders inside the app's own error banner

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/tournaments/join.astro:7,20 · new.astro:7,18 · tournaments/[id].astro:39,61
- **Detail**: `?error=` is read raw from the query string and rendered in a styled first-party alert. This is **not** XSS — both Astro and React escape correctly — but the text is fully attacker-chosen and appears inside the authentic, logged-in UI. `?error=Twoje+konto+zostało+zablokowane.+Zadzwoń+pod+500-100-200` renders as a genuine-looking security notice. Chained with F1 it completes a phishing flow on the real domain.
- **Fix A ⭐ Recommended**: Pass an opaque error key (`?error=invalid_code`) and map it to Polish server-side, rendering nothing for unknown keys.
  - Strength: Removes attacker-controlled prose from the UI entirely and shortens URLs; the join route already has a token vocabulary to model it on.
  - Tradeoff: Touches every route that redirects with a message and every page that renders one.
  - Confidence: HIGH — mirrors the `error.details` token pattern already used for `join_tournament`.
  - Blind spot: The existing auth routes pass Supabase's prose the same way and would remain inconsistent unless also changed.
- **Fix B**: Accept it; the surface predates this slice.
  - Strength: No work; the auth routes already behave this way.
  - Tradeoff: Leaves a phishing primitive that F1 makes materially more useful.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: DEFERRED — the error-key refactor touches every route and page that passes or renders a message, and the existing auth routes pass Supabase prose the same way. Worth doing as one consistent pass rather than piecemeal.

### F9 — Submit buttons never disable, so double-submit creates two tournaments

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/auth/SubmitButton.tsx:12
- **Detail**: Every form uses a *string* action, so React's `useFormStatus` pending never becomes true — `startHostTransition` only runs for function actions or prevented-default transitions. The button is never disabled and `pendingText` never renders. On the create form a double-click produces two POSTs, two tournaments and two burned join codes, with the user landing on only one and an orphan left in their list. Dead code in all four forms; most damaging on create.
- **Fix**: Disable on submit with local state in each form's `onSubmit`, since the framework cannot help with a string action.
- **Decision**: FIXED — SubmitButton now listens for a non-prevented submit on its own owning form (via HTMLButtonElement.form, so multiple forms cannot cross wires) and disables. useFormStatus never fired because every form uses a string action.

### F10 — Consolidated smaller issues

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence / Pattern Consistency
- **Location**: multiple
- **Detail**: (a) **Stale lobby chrome** — `LobbyRoster` stops polling on the start transition, but the join-code panel, start button and leave button are server-rendered from the initial status and never update, so a member whose creator started elsewhere keeps seeing a join code and a leave button that then fails. (b) **`leave.ts:34` contradicts its own comment** — the route filters `.eq("user_id", user.id)` while its docstring and the plan both say authorisation is left entirely to the policy; harmless but it is the masking pattern the plan forbade. (c) **The `NOT_AUTHENTICATED` mapping in `join.ts:19` is unreachable** — an anon caller is refused by `revoke execute` with 42501 before the function's own token can be raised, so an expired session shows the generic message. (d) **`players.ts:36` selects `join_code`** — the credential — and never uses it; one careless spread away from publishing it on a 4-second poll. (e) **No logging anywhere** — every error branch swallows its cause, leaving no forensic trace in production. (f) **The plan's "copyable link" was not built** — the URL renders as inert text. (g) **Four different auth strategies across five new routes** — `getUser()`, RLS-only, and RPC-error-only.
- **Fix**: Take (a), (c) and (d) as small targeted edits; fold (b) and (g) into a stated convention; treat (e) as a project-level decision; (f) is a one-line UI addition.
- **Decision**: DEFERRED — recorded for follow-up: stale lobby chrome after a poll-detected start, leave.ts contradicting its own comment, the unreachable NOT_AUTHENTICATED mapping, join_code in the roster select, absent logging, the uncopyable link, and the four auth strategies across five routes.
