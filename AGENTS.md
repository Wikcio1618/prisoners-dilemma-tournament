# Repository Guidelines

Prisoner's Dilemma Tournament — an Astro 6 SSR app with React 19 islands, Tailwind 4, and Supabase auth, deployed to Cloudflare Workers.

## Hard rules

- API route files (`src/pages/api/**`) must export `const prerender = false`; the app renders server-side by default (`output: "server"` in `@astro.config.mjs`).
- Use the `cn()` helper from `@/lib/utils` (clsx + tailwind-merge) for conditional/merged class names — never concatenate class strings manually.
- Astro components for static content/layout; React components only when interactivity is needed. No Next.js directives (`"use client"`, etc.) — extract hooks to `src/components/hooks/`.
- API route handlers use uppercase `GET`/`POST` exports and validate input with zod.
- Supabase migrations live in `supabase/migrations/`, named `YYYYMMDDHHmmss_short_description.sql`; always enable RLS with granular per-operation, per-role policies on new tables.
- Route protection is centralized in `@src/middleware.ts` via the `PROTECTED_ROUTES` array — add new gated paths there, not per-page.

## Project Structure

`src/layouts/` (Astro layouts), `src/pages/` (routes, `src/pages/api/` for endpoints), `src/components/` (Astro + React; shadcn/ui primitives in `src/components/ui/`, "new-york" variant), `src/lib/` (services/helpers; `@src/lib/supabase.ts` is the Supabase SSR client), `src/types.ts` (shared entities/DTOs), `supabase/` (local Supabase config + migrations), `@wrangler.jsonc` (Cloudflare Workers config).

## Build, Test, and Development Commands

- `npm run dev` — dev server (Cloudflare workerd runtime)
- `npm run build` — production build; `npm run preview` — preview it
- `npm run lint` / `npm run lint:fix` — ESLint with type-checked rules
- `npm run format` — Prettier (astro + tailwind plugins)
- `npx supabase start` — local Supabase (requires Docker); `npx supabase stop` to end it

No test runner is configured in this project yet.

## Coding Style & Naming Conventions

TypeScript strict mode (`astro/tsconfigs/strict`); path alias `@/*` → `./src/*`. Husky + lint-staged run `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}` pre-commit — see `@eslint.config.js`.

## CI Gate

`@.github/workflows/ci.yml` runs on push/PR to `master`: `npx astro sync`, `npm run lint`, `npm run build`. The build step requires `SUPABASE_URL` and `SUPABASE_KEY` as GitHub repository secrets.

## Security & Configuration

`SUPABASE_URL`/`SUPABASE_KEY` are server-only secrets declared via `astro:env` in `@astro.config.mjs` — never exposed to the client. Copy `@.env.example` to `.env` for local Node and to `.dev.vars` for Cloudflare local dev (both gitignored).
