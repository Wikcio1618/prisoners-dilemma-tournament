import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { safeRedirect } from "@/lib/safe-redirect";

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const email = form.get("email") as string;
  const password = form.get("password") as string;
  // Validated, not trusted: `next` arrives from a query parameter via a hidden field.
  const next = safeRedirect(form.get("next") as string | null);

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Keep `next` across a failed attempt, or one typo costs the invitee their destination.
    const retry = new URLSearchParams({ error: error.message });
    if (next !== "/") retry.set("next", next);
    return context.redirect(`/auth/signin?${retry.toString()}`);
  }

  return context.redirect(next);
};
