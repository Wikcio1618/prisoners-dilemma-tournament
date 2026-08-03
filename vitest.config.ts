import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config, deliberately NOT built from Astro's `getViteConfig`.
 *
 * `getViteConfig` runs the Astro config lifecycle, which executes the Cloudflare adapter's
 * `astro:config:setup` hook. That injects `@cloudflare/vite-plugin` (a workerd/Miniflare-backed
 * Vite environment), a `cloudflare:*` externalizer, and `optimizeDeps` forcing for the ssr and
 * prerender environments — and it depends on `astro sync` having generated the route list. None
 * of that helps a suite of pure functions, and all of it costs startup time on every run.
 *
 * The price of standing alone is that Astro's `astro:tsconfig-alias` plugin is not in scope, so
 * the `@/*` path alias from tsconfig.json must be re-declared here. Anything importing `@/lib/...`
 * fails to resolve without it.
 *
 * Modules reaching `astro:env/server` (src/lib/supabase.ts, src/lib/config-status.ts) or
 * `cloudflare:workers` (src/durable/match-room.ts) cannot be imported in this environment at all —
 * those are virtual module specifiers that only resolve inside their own bundlers. Tests for that
 * code belong to the later rollout phases that run against Postgres and workerd respectively.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Explicit imports from "vitest" rather than globals: adding `types: ["vitest/globals"]` to
    // tsconfig.json would turn off the implicit "all @types packages" behaviour that React and
    // Node globals currently depend on.
    globals: false,
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
