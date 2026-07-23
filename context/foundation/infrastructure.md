---
project: "Prisoner's Dilemma Tournament"
researched_at: 2026-07-23
recommended_platform: Cloudflare Workers
runner_up: Fly.io
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 + React 19
  runtime: Cloudflare Workers (workerd)
---

## Recommendation

**Deploy on Cloudflare Workers.**

Cloudflare ties Render for the highest raw score on the five agent-friendly criteria (all five Pass), but wins decisively once the interview's stated priority — minimize cost — is applied: a realistic floor of ~$5/mo flat (Workers Paid; the free tier's 10ms CPU/invocation is too tight for real Astro SSR) versus Render's $7–25/mo for the always-on instance the realtime feature requires (Render's free tier sleeps after 15 min idle, which would kill the hidden-move WebSocket). Cloudflare is also the platform this project is already wired for — `@astrojs/cloudflare` and `wrangler.jsonc` are already in the scaffold — so it's the only option with zero migration cost against a 3-week solo after-hours timeline.

## Platform Comparison

Hard filter applied first: interview Q1 confirmed the app needs persistent connections (WebSockets for the simultaneous hidden-move reveal). This drops **Netlify** (no persistent-connection primitive — Netlify Functions are stateless/short-lived, Edge Functions cap at 50ms CPU and a 40s header timeout) and **Vercel** (native WebSockets only reached public beta June 2026, and cross-instance state coordination for two players' commits would require bolting on an external Redis store).

| Platform | CLI-first | Managed/serverless | Agent docs | Stable deploy API | MCP | Notes |
|---|---|---|---|---|---|---|
| Cloudflare Workers | Pass | Pass | Pass | Pass | Pass | `wrangler deploy`/`rollback`/`tail` all GA; `llms.txt` GA; production MCP suite GA. WebSocket support for the reveal mechanic needs a hand-written Durable Object, not covered by the default adapter. |
| Render | Pass | Pass | Pass | Pass | Pass | Most mature tooling of the four (CLI v2.19 GA covers deploy/rollback/scale/logs; MCP GA since Aug 2025). WebSockets GA and simplest to wire. Costs more for an always-on instance; requires adapter swap to `@astrojs/node`. |
| Fly.io | Pass | Pass | Pass | Partial | Partial | Rollback is a manual two-step (find prior image, redeploy with `-i`), not one command. MCP server is early-stage/low-commit-count. WebSockets are a natural fit on full VMs — no Durable Object equivalent needed. Cheapest raw compute (~$2–6/mo) but no permanent free tier. |
| Railway | Partial | Pass | Pass | Partial | Partial | Rollback is dashboard-only. MCP server explicitly documented as "a work in progress." A platform-wide incident (Jul 18 2026) killed long-lived WebSocket connections for ~1 day — a real reliability flag for exactly this feature. |

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

Ties for the top raw score and wins on cost (~$5/mo realistic floor) and on zero migration cost — the scaffold already targets it. The realtime mechanic requires a deliberate but well-documented addition (a custom Worker entrypoint wrapping the Astro handler, a Durable Object class, a binding + migration block in `wrangler.jsonc`) rather than something the adapter provides out of the box.

#### 2. Fly.io

Cheapest raw compute and the most natural WebSocket story (full VMs, no equivalent of Durable Objects needed) — but requires swapping to `@astrojs/node`, writing and maintaining a Dockerfile, and accepting a weaker rollback/MCP story than Cloudflare or Render. No permanent free tier carries a billing-surprise risk for a side project.

#### 3. Render

The most mature tooling across the board (CLI, deploy API, MCP all GA) and the simplest WebSocket story of any candidate — but the always-on paid instance this feature needs runs $7–25/mo, the highest floor of the shortlist, working against the stated cost priority. Also requires the adapter swap.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. The official `@astrojs/cloudflare` adapter has no built-in WebSocket support — the hidden-move-reveal mechanic requires hand-writing a custom Worker entrypoint that wraps the Astro handler, plus a Durable Object class and a binding + migration block in `wrangler.jsonc`. Real platform-specific work on a tight solo timeline, and the bootstrap verification log already flagged low self-check confidence judging Astro/React agent-consistency.
2. Every code deploy restarts *all* Durable Objects and force-disconnects every live WebSocket. A routine hotfix pushed mid-tournament silently drops every active pair unless client-side reconnect logic is built and tested.
3. Durable Object WebSocket hibernation only works for *inbound* connections where the DO is the server — outbound/client-side hibernation is an open, unresolved upstream issue (workerd#4864), a sign this primitive's edges are still evolving even though the core is GA.
4. The free tier's 10ms-CPU-per-invocation cap is too tight for real SSR renders, so the $5/mo Paid plan is a mandatory day-one floor, not an optional later upgrade — undermines any "start free" assumption.
5. Some CJS npm packages fail under `workerd` and need `nodejs_compat` configured — a class of dependency friction a Node-based host (Fly.io, Render) doesn't have.

### Pre-Mortem — How This Could Fail

Six months in, the app breaks mid-camp-session and nobody can figure out why. The team wired a custom Durable Object into the Astro Worker for the hidden-move reveal — it worked in local dev and the two-player test the week before launch. Nobody tested what happens when 20 pairs are mid-round and someone pushes a routine bugfix: the deploy restarts every Durable Object at once, silently dropping every open WebSocket. Half the players see a frozen "waiting for opponent" screen with no idea a reconnect is needed, because client-side reconnect handling was stubbed out under deadline pressure and never finished. The counselor running the debrief has no visibility into which pairs are still connected. What looked like a platform choice turned out to be an application-layer gap: the GA primitive assumed the team would build reconnect handling themselves, and the three weeks ran out before they got to it.

### Unknown Unknowns

- Deploys always drop live Durable Object WebSocket connections — there is no graceful-drain option; it's disruptive by design, not a bug to route around.
- The free tier does not represent real production behavior once SSR + Durable Object logic runs (10ms CPU cap) — budget for the $5/mo Paid plan from day one of development, not just at launch.
- Durable Object constructors re-run on every wake-from-hibernation; anything expensive placed there (e.g., a fresh Supabase client) becomes a recurring cost/latency tax invisible in quick local tests.
- A community patch (ZAstroWebsockets) exists specifically because the *official* Cloudflare adapter doesn't handle WebSockets — "officially supported adapter" and "WebSockets officially supported" are different claims; don't conflate them during setup.
- Cloudflare caps simultaneous open connections per Worker invocation at 6 — almost certainly irrelevant at the PRD's ~50-player camp scale, but worth knowing the ceiling exists.

## Operational Story

- **Preview deploys**: Cloudflare Workers builds via `wrangler deploy` per branch/environment; preview URLs are generated per Workers environment configured in `wrangler.jsonc`. No fork-PR restriction beyond standard GitHub Actions secret scoping.
- **Secrets**: `SUPABASE_URL` / `SUPABASE_KEY` are declared as server-only secrets via `astro:env` in `astro.config.mjs` and stored as Cloudflare Workers Secrets (`wrangler secret put`) for production, or in `.dev.vars` (gitignored) for local dev. CI reads them from GitHub repository secrets (already wired in `@.github/workflows/ci.yml`).
- **Rollback**: `wrangler rollback [deployment-id]` — defaults to the immediately prior deployment. One command, deterministic. Note: rolling back does not undo a Durable Object restart that already happened at the bad deploy — any players disconnected by that deploy still need to reconnect.
- **Approval**: routine deploys (`wrangler deploy`) can run unattended via CI on merge to `master` per the existing auto-deploy-on-merge flow. A human should approve: any change to the Durable Object binding/migration block in `wrangler.jsonc` (schema-shaped, higher blast radius) and any change to Workers Secrets.
- **Logs**: `wrangler tail` streams live logs/exceptions from the deployed Worker; read-only, no write access. Cloudflare's remote MCP suite (`mcp.cloudflare.com`) also exposes Workers/observability tools for structured, non-interactive log/metric queries.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Mid-tournament deploy disconnects every live WebSocket (Durable Object restart on every deploy) | Devil's advocate / Unknown unknowns | M | H | Build client-side auto-reconnect from day one (not a "nice to have"); avoid deploying during a live camp session; treat reconnect handling as a must-have FR, not a stretch item. |
| Realtime reveal mechanic needs hand-written Durable Object glue not covered by `@astrojs/cloudflare` | Devil's advocate / Research finding | H | M | Budget explicit implementation time for the custom Worker entrypoint + DO binding early in the 3-week timeline, not as an afterthought; use Cloudflare's official hibernation-server example as the reference pattern. |
| Free tier's 10ms CPU/invocation cap doesn't reflect real production SSR + DO cost | Unknown unknowns | H | L | Move to the $5/mo Workers Paid plan at the start of development, not at launch, so performance testing reflects production limits. |
| Some CJS dependencies fail under `workerd` | Devil's advocate / Research finding | L | M | Add `nodejs_compat` to `wrangler.jsonc` proactively; check any new dependency against Cloudflare's Node.js compatibility docs before adding it. |
| Durable Object outbound WebSocket hibernation is unsupported (open upstream issue) | Devil's advocate / Research finding | L | L | Not needed for this app's shape (the DO is the server, players are inbound clients) — no action required, just don't design around outbound hibernation. |

## Getting Started

1. Add Durable Object support: define a `GameRoom` class extending `DurableObject` and wrap the existing `@astrojs/cloudflare` handler in a custom Worker entrypoint, following Cloudflare's [WebSocket Hibernation Server example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server).
2. Add a Durable Object binding + migration block to `@wrangler.jsonc` for the new `GameRoom` class.
3. Add `nodejs_compat` to `@wrangler.jsonc` proactively if any dependency needs it.
4. Set `SUPABASE_URL` / `SUPABASE_KEY` as Workers Secrets for production: `wrangler secret put SUPABASE_URL` and `wrangler secret put SUPABASE_KEY`.
5. Confirm the existing CI workflow (`@.github/workflows/ci.yml`) deploys via `wrangler deploy` on merge to `master`, or add that step if it currently only runs lint + build.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup
- Production-scale architecture (multi-region, HA, DR)
