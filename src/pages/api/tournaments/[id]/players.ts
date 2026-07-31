import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";

export const prerender = false;

/**
 * Roster for the lobby poll — the one read in this slice served as JSON rather than a page.
 *
 * Access control is the row-level security policy, deliberately not a hand-written filter.
 * `tournaments` SELECT returns the row only to members and the creator; `tournament_players`
 * SELECT returns rows only for tournaments the caller belongs to. Re-checking membership here
 * would mask a policy failure rather than catch one.
 *
 * A caller who is neither gets 404 rather than an empty roster, so membership in someone
 * else's tournament is not probeable through the difference.
 */
export const GET: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return new Response(JSON.stringify({ error: "unconfigured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const id = context.params.id;
  if (!id) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: tournament } = await supabase
    .from("tournaments")
    .select("id, status, join_code, rounds_per_match, creator_id")
    .eq("id", id)
    .maybeSingle();

  if (!tournament) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: players } = await supabase
    .from("tournament_players")
    .select("user_id, joined_at")
    .eq("tournament_id", id)
    .order("joined_at", { ascending: true });

  const roster = players ?? [];

  // Two queries rather than an embed: tournament_players.user_id references auth.users, not
  // profiles, so PostgREST has no relationship to traverse. The profiles read is scoped by its
  // own co-member policy, which covers exactly this roster.
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      roster.map((p) => p.user_id),
    );

  const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  return new Response(
    JSON.stringify({
      status: tournament.status,
      creator_id: tournament.creator_id,
      players: roster.map((p) => ({ ...p, display_name: names.get(p.user_id) ?? null })),
    }),
    {
      status: 200,
      // The roster changes as players join, so it must never be served from cache.
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
};
