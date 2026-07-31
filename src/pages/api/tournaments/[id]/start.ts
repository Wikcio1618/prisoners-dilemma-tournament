import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { START_TOURNAMENT_ERRORS, isStartTournamentError } from "@/lib/tournament";

export const prerender = false;

/**
 * Starts a tournament: closes the join window and generates the round-robin schedule.
 *
 * Both happen inside `public.start_tournament()`, in one transaction, because starting is a
 * one-way door — once `started`, no policy permits leaving, reverting or deleting, so a
 * tournament that reached `started` without a schedule would be permanently bricked.
 *
 * Authorisation lives in the function, not in a policy: the UPDATE policy was dropped and
 * `update (status)` revoked, so this RPC is the only route to `started`. The route therefore
 * does no re-check of its own — the function owns it, and the earlier rows-affected
 * inspection this route used to do is gone with the policy it was inspecting.
 */
const MESSAGES: Record<string, string> = {
  [START_TOURNAMENT_ERRORS.NOT_AUTHENTICATED]: "Zaloguj się, aby rozpocząć turniej.",
  // Same message for absent and not-yours, matching the function's deliberate use of one
  // token for both — telling them apart would make this an existence oracle.
  [START_TOURNAMENT_ERRORS.NOT_FOUND]: "Nie znaleziono turnieju.",
  [START_TOURNAMENT_ERRORS.FINISHED]: "Ten turniej jest już zakończony.",
  [START_TOURNAMENT_ERRORS.NOT_ENOUGH_PLAYERS]: "Do rozpoczęcia turnieju potrzeba co najmniej dwóch graczy.",
};

export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  const id = context.params.id;
  if (!supabase || !id) {
    return context.redirect("/tournaments");
  }

  const { error } = await supabase.rpc("start_tournament", { p_tournament_id: id });

  if (error) {
    // Read the reason from `details`, never `message` — the latter is English prose from
    // Postgres and may be reworded or translated.
    const reason = isStartTournamentError(error.details) ? MESSAGES[error.details] : undefined;
    const message = reason ?? "Nie udało się rozpocząć turnieju.";
    return context.redirect(`/tournaments/${id}?error=${encodeURIComponent(message)}`);
  }

  // A repeated start returns the existing match count rather than erroring, so success here
  // covers both the first press and a retry after a lost response.
  return context.redirect(`/tournaments/${id}`);
};
