---
bootstrapped_at: 2026-07-23T18:24:03Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: prisoners-dilemma-tournament
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

## Hand-off

```yaml
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
```

## Why this stack

A solo developer shipping a Prisoner's Dilemma tournament app in 3 weeks after-hours needs auth and a realtime hidden-move-reveal mechanic without building cross-runtime plumbing. The user initially considered a split TypeScript-frontend/Java-backend stack, then Astro+Angular, but both split-repo options carried gotchas against this project's shape (solo dev, tight timeline, two deploy targets, custom CORS/auth handoff). Converging on "Astro with React" landed exactly on 10x-astro-starter — the registry's vetted default for `(web, js)` — which bundles Astro + React 19 islands + TypeScript + Supabase (Postgres + auth + storage) + Cloudflare in one repo and one deploy target. It clears all four agent-friendly gates and Supabase's realtime channels fit the hidden-until-both-commit reveal and live match state naturally. Auth and realtime flags are set; payments, AI, and background jobs are out of scope per the PRD. CI runs on GitHub Actions with auto-deploy-on-merge, deploying to Cloudflare Pages — the starter's own defaults. The self-check came back with one gap (judging agent-consistency with Astro/React conventions isn't yet confident), which is a normal ramp-up item, not a blocker.

## Pre-scaffold verification

| Signal      | Value                                              | Severity | Notes                                                    |
| ----------- | --------------------------------------------------- | -------- | --------------------------------------------------------- |
| npm package | not run                                             | n/a      | `cmd_template` starts with `git clone`; no npm CLI to check |
| GitHub repo | przeprogramowani/10x-astro-starter last pushed 2026-05-17 | fresh    | from card `docs_url`, fetched via GitHub REST API (`gh` CLI unavailable, used `curl` fallback) |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 19 top-level paths (`.env.example`, `.github`, `.gitignore`, `.husky`, `.nvmrc`, `.prettierrc.json`, `.vscode`, `README.md`, `astro.config.mjs`, `components.json`, `eslint.config.js`, `node_modules`, `package-lock.json`, `package.json`, `public`, `src`, `supabase`, `tsconfig.json`, `wrangler.jsonc`)
**Conflicts (.scaffold siblings)**: CLAUDE.md → CLAUDE.md.scaffold
**.gitignore handling**: moved silently (no pre-existing `.gitignore` in cwd)
**.bootstrap-scaffold cleanup**: deleted (cloned `.git/` removed before move-up)

## Post-scaffold audit

**Tool**: npm audit --json
**Summary**: 1 CRITICAL, 11 HIGH, 7 MODERATE, 2 LOW
**Direct vs transitive**: 0/1/2/0 direct of total 1/11/7/2

#### CRITICAL findings

- **tar** `<=7.5.18` — node-tar applies PAX size override to intermediary GNU long-name/long-link headers, causing tar parser interpretation differential (file smuggling); also: node-tar process crash via PAX numeric path type confusion. Transitive. Fix available.

#### HIGH findings

- **astro** `<=7.0.9` — Reflected XSS via unescaped slot name; Host header SSRF in prerendered error page fetch. Direct. Fix available.
- **brace-expansion** `<1.1.16 || >=3.0.0 <5.0.7` — DoS via exponential-time expansion of consecutive non-expanding `{}` groups. Transitive. Fix available.
- **devalue** `5.6.3 - 5.8.0` — Svelte devalue: DoS via sparse array deserialization. Transitive. Fix available.
- **fast-uri** `3.0.0 - 3.1.3` — host confusion via literal backslash authority delimiter; host confusion via failed IDN canonicalization. Transitive. Fix available.
- **js-yaml** `4.0.0 - 4.2.0` — quadratic-complexity DoS in merge key handling via repeated aliases. Transitive. Fix available.
- **miniflare** `<=0.0.0-fff677e35 || 3.20250204.0 - 4.20260721.0` — inherits sharp/undici advisories. Transitive. Fix available.
- **sharp** `<0.35.0` — inherited libvips vulnerabilities (CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591). Transitive. Fix available.
- **svgo** `4.0.0 - 4.0.1` — removeScripts plugin leaves some executable scripts intact. Transitive. Fix available.
- **undici** `7.0.0 - 7.27.2` — TLS certificate validation bypass via dropped requestTls in SOCKS5 ProxyAgent; HTTP header injection via Set-Cookie percent-decoding. Transitive. Fix available.
- **vite** `7.0.0 - 7.3.3` — launch-editor NTLMv2 hash disclosure via UNC path handling on Windows; `server.fs.deny` bypass on Windows alternate paths. Transitive. Fix available.
- **ws** `8.0.0 - 8.20.1` — uninitialized memory disclosure; memory exhaustion DoS from tiny fragments and data chunks. Transitive. Fix available.

#### MODERATE findings

- **@astrojs/language-server** `2.14.0 - 2.16.10` — via volar-service-yaml. Transitive. Fix available.
- **@cloudflare/vite-plugin** `<=0.0.0-fff677e35 || 0.0.7 - 1.41.0` — via miniflare/wrangler. Transitive. Fix available.
- **supabase** `1.1.6 - 2.98.2` — via tar. Direct. Fix available.
- **volar-service-yaml** `<=0.0.70` — via yaml-language-server. Transitive. Fix available.
- **wrangler** `<=0.0.0-kickoff-demo || 3.108.0 - 4.101.0` — via esbuild/miniflare. Direct. Fix available.
- **yaml** `2.0.0 - 2.8.2` — stack overflow via deeply nested YAML collections. Transitive. Fix available.
- **yaml-language-server** (nested pre-release range) — via yaml. Transitive. Fix available.

#### LOW / INFO findings

- **@babel/core** `<=7.29.0` — arbitrary file read via sourceMappingURL comment. Transitive. Fix available.
- **esbuild** `0.27.3 - 0.28.0` — allows arbitrary file read when running the dev server on Windows. Transitive. Fix available.

## Hints recorded but not acted on

| Hint                     | Value                |
| ------------------------ | --------------------- |
| bootstrapper_confidence  | first-class            |
| quality_override         | false                  |
| path_taken               | custom                 |
| self_check_answers       | typed: true, from_official_starter: true, conventions: true, docs_current: true, can_judge_agent: false |
| team_size                | solo                   |
| deployment_target        | cloudflare-pages       |
| ci_provider              | github-actions         |
| ci_default_flow          | auto-deploy-on-merge   |
| has_auth                 | true                   |
| has_payments             | false                  |
| has_realtime             | true                   |
| has_ai                   | false                  |
| has_background_jobs      | false                  |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
