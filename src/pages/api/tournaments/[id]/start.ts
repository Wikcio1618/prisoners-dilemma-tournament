import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";

export const prerender = false;

/**
 * Closes the join window by moving the tournament from lobby to started.
 *
 * Authorisation is entirely the UPDATE policy plus its column-level grant: creator-only,
 * `lobby → started` only, and `status` is the only column `authenticated` may write. The UI
 * hides this control from non-creators, but hiding a button is not access control — the
 * policy is what actually enforces it, and that is what the manual test exercises.
 *
 * Because `USING` requires `lobby`, starting an already-started tournament matches zero rows
 * rather than erroring. That is treated as success: the join window is shut either way, which
 * is what the caller asked for.
 */
export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  const id = context.params.id;
  if (!supabase || !id) {
    return context.redirect("/tournaments");
  }

  // `.select()` is what makes rows-affected observable. Without it every outcome — refused by
  // the policy, already started, tournament absent, genuine success — collapses into the same
  // silent redirect, and a policy regression would be invisible. That is the failure mode this
  // whole slice exists to guard against, so the route looks rather than assumes.
  const { data: started, error } = await supabase
    .from("tournaments")
    .update({ status: "started" })
    .eq("id", id)
    .select("id");

  if (error) {
    const message = "Nie udało się rozpocząć turnieju.";
    return context.redirect(`/tournaments/${id}?error=${encodeURIComponent(message)}`);
  }

  if (started.length === 0) {
    // Either the tournament is already started — in which case the join window is shut and the
    // caller got what they wanted — or the policy refused them. Distinguished by re-reading:
    // a non-creator sees the row (the SELECT policy allows members) but did not change it.
    const { data: current } = await supabase.from("tournaments").select("status").eq("id", id).maybeSingle();

    if (current?.status !== "started") {
      const message = "Nie masz uprawnień, aby rozpocząć ten turniej.";
      return context.redirect(`/tournaments/${id}?error=${encodeURIComponent(message)}`);
    }
  }

  return context.redirect(`/tournaments/${id}`);
};
