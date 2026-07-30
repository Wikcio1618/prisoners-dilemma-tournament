import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";

export const prerender = false;

/**
 * Removes the caller from a tournament.
 *
 * Authorisation is entirely the DELETE policy on `tournament_players`: self-only, and only
 * while the tournament is in lobby. No re-check here — a duplicate application-side check
 * would hide a policy that had stopped working.
 *
 * This is the only correction available for a mis-join, because F-01 has no creator-kick
 * path: a member removes themselves or nobody does.
 */
export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  const id = context.params.id;
  if (!supabase || !id) {
    return context.redirect("/tournaments");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return context.redirect("/auth/signin");
  }

  const { data, error } = await supabase
    .from("tournament_players")
    .delete()
    .eq("tournament_id", id)
    .eq("user_id", user.id)
    .select("user_id");

  // Zero rows means the policy refused — the tournament has already started, or the caller
  // was not a member. Reporting success would be a lie the UI then acts on.
  if (error || data.length === 0) {
    const message = "Nie można opuścić tego turnieju.";
    return context.redirect(`/tournaments/${id}?error=${encodeURIComponent(message)}`);
  }

  return context.redirect("/tournaments");
};
