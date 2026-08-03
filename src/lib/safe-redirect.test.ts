import { describe, expect, it } from "vitest";

import { safeRedirect } from "@/lib/safe-redirect";

/**
 * The project's first test. `safe-redirect.ts` is chosen deliberately: it imports nothing at all,
 * so a failure here means the runner is misconfigured rather than the module being wrong.
 *
 * It also imports through the `@/` alias on purpose — that alias is supplied by Astro's own Vite
 * plugin in the app build and has to be re-declared in vitest.config.ts. This import is what proves
 * the re-declaration works.
 *
 * The cases below are drawn from the bypass documented in the module's header comment: an earlier
 * version pattern-matched the raw string, and `/<TAB>/evil.example` slipped through because the
 * WHATWG URL parser strips tab, LF and CR before parsing.
 */
describe("safeRedirect", () => {
  it("returns the fallback for null or empty input", () => {
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect("")).toBe("/");
    expect(safeRedirect(null, "/dashboard")).toBe("/dashboard");
  });

  it("passes through an ordinary in-app path", () => {
    expect(safeRedirect("/dashboard")).toBe("/dashboard");
    expect(safeRedirect("/tournaments/123")).toBe("/tournaments/123");
  });

  it("preserves query string and hash", () => {
    expect(safeRedirect("/tournaments?sort=recent#top")).toBe("/tournaments?sort=recent#top");
  });

  it("rejects an absolute URL to another origin", () => {
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("http://evil.example/path")).toBe("/");
  });

  it("rejects protocol-relative and backslash-escaped forms", () => {
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
  });

  it("rejects control characters the URL parser would strip", () => {
    // The regression that motivated resolving against a placeholder origin instead of
    // pattern-matching: each of these resolves to https://evil.example/ in a browser.
    expect(safeRedirect("/\t/evil.example")).toBe("/");
    expect(safeRedirect("/\n/evil.example")).toBe("/");
    expect(safeRedirect("/\r/evil.example")).toBe("/");
  });

  it("honours a custom fallback when rejecting", () => {
    expect(safeRedirect("https://evil.example", "/auth/signin")).toBe("/auth/signin");
  });
});
