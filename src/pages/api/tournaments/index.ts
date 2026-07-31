import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { createTournamentSchema } from "@/lib/schemas";
import { generateJoinCode } from "@/lib/tournament";

export const prerender = false;

/** How many times to retry a join-code collision before giving up. */
const CODE_ATTEMPTS = 5;

/** Postgres unique_violation — here, a join code that is already taken. */
const UNIQUE_VIOLATION = "23505";

/** Back to the create form with a Polish message, matching the auth routes' error convention. */
const failed = (message: string) => `/tournaments/new?error=${encodeURIComponent(message)}`;

export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(failed("Supabase nie jest skonfigurowany."));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return context.redirect("/auth/signin");
  }

  const form = await context.request.formData();
  const parsed = createTournamentSchema.safeParse({
    rounds_per_match: form.get("rounds_per_match"),
  });
  if (!parsed.success) {
    return context.redirect(failed("Liczba rund musi być liczbą całkowitą od 1 do 20."));
  }

  // Retry only on a taken code. Any other failure means something else is wrong, and a
  // blanket retry would spin on it.
  let tournamentId: string | null = null;
  let joinCode = "";
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    joinCode = generateJoinCode();
    const { data, error } = await supabase
      .from("tournaments")
      .insert({
        creator_id: user.id,
        rounds_per_match: parsed.data.rounds_per_match,
        join_code: joinCode,
      })
      .select("id")
      .single();

    if (!error) {
      tournamentId = data.id;
      break;
    }
    if (error.code !== UNIQUE_VIOLATION) {
      return context.redirect(failed("Nie udało się utworzyć turnieju."));
    }
  }

  if (!tournamentId) {
    return context.redirect(failed("Nie udało się wygenerować kodu. Spróbuj ponownie."));
  }

  // The creator is not a member yet. tournament_players has no insert policy, so even their
  // own membership must go through join_tournament — this is a second, non-atomic round trip.
  const { error: joinError } = await supabase.rpc("join_tournament", { p_join_code: joinCode });
  if (joinError) {
    // Leaving the row behind would create a tournament its creator can see and start but
    // nobody belongs to. The creator-delete policy (creator, lobby only) lets us undo it.
    //
    // The result is checked rather than assumed: the transient condition that just broke the
    // RPC is the likeliest thing to break this too, and an unverified rollback would leave the
    // orphan in place while telling the user creation failed — the opposite of the truth.
    const { data: removed, error: rollbackError } = await supabase
      .from("tournaments")
      .delete()
      .eq("id", tournamentId)
      .select("id");

    if (rollbackError || removed.length === 0) {
      return context.redirect(
        failed(`Turniej powstał, ale nie udało się do niego dołączyć. Znajdziesz go na liście turniejów.`),
      );
    }
    return context.redirect(failed("Nie udało się dołączyć do utworzonego turnieju."));
  }

  return context.redirect(`/tournaments/${tournamentId}`);
};
