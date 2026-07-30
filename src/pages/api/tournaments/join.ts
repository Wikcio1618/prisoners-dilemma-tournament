import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { joinTournamentSchema } from "@/lib/schemas";
import { JOIN_TOURNAMENT_ERRORS, isJoinTournamentError } from "@/lib/tournament";

export const prerender = false;

/**
 * Polish message per failure reason.
 *
 * Keyed on the token the database puts in `error.details`, never on `error.message` — that
 * is English prose from Postgres and may be reworded. `join_tournament` was built with these
 * tokens specifically so this mapping is possible.
 */
const MESSAGES: Record<string, string> = {
  [JOIN_TOURNAMENT_ERRORS.NOT_FOUND]: "Nie znaleziono turnieju o tym kodzie.",
  [JOIN_TOURNAMENT_ERRORS.ALREADY_STARTED]: "Ten turniej już się rozpoczął.",
  [JOIN_TOURNAMENT_ERRORS.FULL]: "Ten turniej jest pełny.",
  [JOIN_TOURNAMENT_ERRORS.NOT_AUTHENTICATED]: "Zaloguj się, aby dołączyć.",
};

const failed = (message: string, code: string) =>
  `/tournaments/join?error=${encodeURIComponent(message)}&code=${encodeURIComponent(code)}`;

export const POST: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(failed("Supabase nie jest skonfigurowany.", ""));
  }

  const form = await context.request.formData();
  // formData yields string | File; a File here would stringify to "[object Object]" and then
  // fail validation for a misleading reason.
  const field = form.get("join_code");
  const rawCode = typeof field === "string" ? field : "";
  const parsed = joinTournamentSchema.safeParse({ join_code: rawCode });
  if (!parsed.success) {
    return context.redirect(failed("Kod musi składać się z 6 cyfr.", rawCode));
  }

  const { data, error } = await supabase.rpc("join_tournament", {
    p_join_code: parsed.data.join_code,
  });

  if (error) {
    const reason = isJoinTournamentError(error.details) ? MESSAGES[error.details] : undefined;
    return context.redirect(failed(reason ?? "Nie udało się dołączyć do turnieju.", parsed.data.join_code));
  }

  // An already-joined caller succeeds idempotently and lands in the lobby — that is the
  // function's documented behaviour, not an error to surface.
  return context.redirect(`/tournaments/${data}`);
};
