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

  const { error } = await supabase.from("tournaments").update({ status: "started" }).eq("id", id);

  if (error) {
    const message = "Nie udało się rozpocząć turnieju.";
    return context.redirect(`/tournaments/${id}?error=${encodeURIComponent(message)}`);
  }

  return context.redirect(`/tournaments/${id}`);
};
