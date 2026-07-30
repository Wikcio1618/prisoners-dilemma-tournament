/**
 * Narrows a caller-supplied `next` value to a safe in-app destination.
 *
 * This guards an open-redirect surface: `next` reaches us from a query parameter and is used
 * verbatim in a redirect after sign-in, so an attacker could otherwise send a victim to
 * `/auth/signin?next=https://evil.example` and have a genuine login hand them off to a
 * lookalike site.
 *
 * The implementation deliberately does NOT pattern-match the raw string. An earlier version
 * checked only for a leading `/` and rejected `//` and `/\`, and was bypassed: the WHATWG URL
 * parser strips ASCII tab, LF and CR *before* parsing, so `/<TAB>/evil.example` passed every
 * check and then resolved to `https://evil.example/` in the browser. `Headers.set` accepts a
 * tab as a legal field-value byte, so the redirect shipped. (The LF variant failed differently
 * — `Headers.set` throws on it, producing a 500 *after* a successful sign-in, leaving the user
 * authenticated server-side but with no cookie.)
 *
 * So: strip the characters the parser would strip anyway, to validate what the browser will
 * actually see, then resolve against a placeholder origin and require the origin to be
 * unchanged. That rejects the whole class rather than the glyphs we happened to think of.
 */
const PLACEHOLDER_ORIGIN = "https://placeholder.invalid";

export function safeRedirect(next: string | null, fallback = "/"): string {
  if (!next) return fallback;

  // Validate what the URL parser will see, not what was sent.
  const cleaned = next.replace(/[\t\n\r]/g, "");
  if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) {
    return fallback;
  }

  // Re-serialised rather than returned as given, so only a normalised path leaves this function
  // and no residual control characters can reach the Location header.
  return parsed.pathname + parsed.search + parsed.hash;
}
