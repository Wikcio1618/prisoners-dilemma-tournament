---
starter_id: 10x-astro-starter
package_manager: npm
project_name: prisoners-dilemma-tournament
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: true
    conventions: true
    docs_current: true
    can_judge_agent: false
  has_auth: true
  has_payments: false
  has_realtime: true
  has_ai: false
  has_background_jobs: false
---

## Why this stack

A solo developer shipping a Prisoner's Dilemma tournament app in 3 weeks after-hours needs auth and a realtime hidden-move-reveal mechanic without building cross-runtime plumbing. The user initially considered a split TypeScript-frontend/Java-backend stack, then Astro+Angular, but both split-repo options carried gotchas against this project's shape (solo dev, tight timeline, two deploy targets, custom CORS/auth handoff). Converging on "Astro with React" landed exactly on 10x-astro-starter — the registry's vetted default for `(web, js)` — which bundles Astro + React 19 islands + TypeScript + Supabase (Postgres + auth + storage) + Cloudflare in one repo and one deploy target. It clears all four agent-friendly gates and Supabase's realtime channels fit the hidden-until-both-commit reveal and live match state naturally. Auth and realtime flags are set; payments, AI, and background jobs are out of scope per the PRD. CI runs on GitHub Actions with auto-deploy-on-merge, deploying to Cloudflare Pages — the starter's own defaults. The self-check came back with one gap (judging agent-consistency with Astro/React conventions isn't yet confident), which is a normal ramp-up item, not a blocker.
