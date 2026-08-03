# Repository Guidelines

Prisoner's Dilemma Tournament — an Astro 6 SSR app with React 19 islands, Tailwind 4, and Supabase auth, deployed to Cloudflare Workers.

## Hard rules

- API route files (`src/pages/api/**`) must export `const prerender = false`; the app renders server-side by default (`output: "server"` in `@astro.config.mjs`).
- Use the `cn()` helper from `@/lib/utils` (clsx + tailwind-merge) for conditional/merged class names — never concatenate class strings manually.
- Astro components for static content/layout; React components only when interactivity is needed. No Next.js directives (`"use client"`, etc.) — extract hooks to `src/components/hooks/`.
- API route handlers use uppercase `GET`/`POST` exports and validate input with zod.
- Supabase migrations live in `supabase/migrations/`, named `YYYYMMDDHHmmss_short_description.sql`; always enable RLS with granular per-operation, per-role policies on new tables. Create them with `npx supabase migration new <name>` and apply with `npx supabase db push --linked` (no Docker required); **after every applied migration, regenerate types** with `npx supabase gen types typescript --linked --schema public > src/db/database.types.ts` and commit the result.
- RLS helper functions that policies call must be `SECURITY DEFINER ... SET search_path = ''` and live in the non-exposed `private` schema — never `public`, which is API-reachable. Schema-qualify every relation inside them, and grant both `USAGE ON SCHEMA private` and `EXECUTE ON FUNCTION` to `authenticated`, since policy expressions run with the querying user's privileges.
- An RLS `UPDATE` policy with no `WITH CHECK` reuses its `USING` expression as the check, which silently forbids the very transition the policy exists to allow. Write `WITH CHECK` explicitly whenever the update changes a column that `USING` constrains.
- Route protection is centralized in `@src/middleware.ts` via the `PROTECTED_ROUTES` array — add new gated paths there, not per-page.

## Project Structure

`src/layouts/` (Astro layouts), `src/pages/` (routes, `src/pages/api/` for endpoints), `src/components/` (Astro + React; shadcn/ui primitives in `src/components/ui/`, "new-york" variant), `src/lib/` (services/helpers; `@src/lib/supabase.ts` is the `Database`-typed Supabase SSR client, `@src/lib/tournament.ts` holds domain bounds), `src/db/database.types.ts` (generated schema types — never hand-edit; ignored by ESLint and Prettier), `supabase/` (local Supabase config + migrations), `@wrangler.jsonc` (Cloudflare Workers config).

## Build, Test, and Development Commands

- `npm run dev` — dev server (Cloudflare workerd runtime)
- `npm run build` — production build; `npm run preview` — preview it
- `npm run lint` / `npm run lint:fix` — ESLint with type-checked rules
- `npm run format` — Prettier (astro + tailwind plugins)
- `npm run test` — Vitest (unit + property-based, `src/**/*.test.ts`); `npm run test:watch` to iterate
- `npm run deploy` — `wrangler deploy` to Cloudflare Workers (worker name: `prisoners-dilemma-tournament`)
- `npx supabase start` — local Supabase (requires Docker); `npx supabase stop` to end it

Tests are Vitest + fast-check, colocated as `*.test.ts` siblings of the module they cover (`src/lib/tournament.test.ts` beside `src/lib/tournament.ts`). Config is a standalone `@vitest.config.ts` — deliberately not Astro's `getViteConfig`, which would pull the Cloudflare adapter's Vite plugin chain into every run — so the `@/*` alias is re-declared there. Modules importing `astro:env/server` or `cloudflare:workers` cannot be unit-tested; those virtual specifiers resolve only inside their own bundlers. Read `@context/foundation/test-plan.md` §6 before adding a test.

## Coding Style & Naming Conventions

TypeScript strict mode (`astro/tsconfigs/strict`); path alias `@/*` → `./src/*`. Husky + lint-staged run `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}` pre-commit — see `@eslint.config.js`.

## CI Gate

`@.github/workflows/ci.yml` runs on push/PR to `master`: `npx astro sync`, `npm run lint`, `npm run test`, `npm run build`. The build step requires `SUPABASE_URL` and `SUPABASE_KEY` as GitHub repository secrets. On `push` to `master` only, a second `deploy` job also runs `wrangler deploy` via `cloudflare/wrangler-action@v3`, using the `CLOUDFLARE_API_TOKEN` repository secret and syncing `SUPABASE_URL`/`SUPABASE_KEY` as Workers Secrets on every deploy.

## Security & Configuration

`SUPABASE_URL`/`SUPABASE_KEY` are server-only secrets declared via `astro:env` in `@astro.config.mjs` — never exposed to the client. Copy `@.env.example` to `.env` for local Node and to `.dev.vars` for Cloudflare local dev (both gitignored).

Auth URL configuration (Site URL, redirect allow-list, email confirmation) for the linked project lives in the **Supabase dashboard**, not in `@supabase/config.toml` — that file configures the local Docker stack. Do not run `supabase config push` casually: it overwrites the remote's entire `[auth]` block from local defaults, which have historically included a localhost `site_url` and `enable_confirmations = false`.
