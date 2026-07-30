/**
 * Narrows a caller-supplied `next` value to a safe in-app destination.
 *
 * This guards an open-redirect surface: `next` reaches us from a query parameter and is used
 * verbatim in a redirect after sign-in, so an attacker could otherwise send a victim to
 * `/auth/signin?next=https://evil.example` and have a genuine login hand them off to a
 * lookalike site.
 *
 * Accepts only a path: it must start with a single `/`. The `//` rejection is the one that is
 * easy to miss — browsers read `//evil.example` as protocol-relative and will happily leave
 * the origin. A backslash is rejected too, since some browsers normalise `\` to `/`.
 */
export function safeRedirect(next: string | null, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
