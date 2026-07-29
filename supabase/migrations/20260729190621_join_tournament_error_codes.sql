-- Migration: machine-readable failure reasons for join_tournament
-- Purpose:  Make the "already started" and "full" rejections distinguishable without
--           matching on English message text. Both previously raised P0001, so the only
--           thing separating them was the message string -- brittle for the join UI to
--           branch on.
-- Affected: public.join_tournament(text)
--
-- Why DETAIL rather than distinct SQLSTATEs:
--   PostgREST derives the HTTP status from the SQLSTATE and maps codes it does not
--   recognise to 500. Custom codes would therefore turn a full tournament into a server
--   error. The SQLSTATE stays responsible for the status (P0002 -> 404, P0001 -> 400,
--   class 28 -> 403) and a stable token travels in DETAIL, which reaches the client as
--   `error.details` on the PostgrestError.
--
--   The tokens below are mirrored by JOIN_TOURNAMENT_ERRORS in src/lib/tournament.ts.
--   Both must be updated together.

create or replace function public.join_tournament(p_join_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_tournament public.tournaments%rowtype;
  v_player_count integer;
begin
  if v_user_id is null then
    raise exception 'Not authenticated'
      using errcode = '28000', detail = 'not_authenticated';
  end if;

  -- FOR UPDATE is what serialises the capacity check against simultaneous joiners:
  -- concurrent callers queue on this row rather than each reading a stale count.
  select * into v_tournament
  from public.tournaments
  where join_code = p_join_code
  for update;

  if not found then
    raise exception 'Tournament not found'
      using errcode = 'P0002', detail = 'tournament_not_found';
  end if;

  if v_tournament.status <> 'lobby' then
    raise exception 'Tournament has already started'
      using errcode = 'P0001', detail = 'tournament_already_started';
  end if;

  select count(*) into v_player_count
  from public.tournament_players
  where tournament_id = v_tournament.id;

  if v_player_count >= 50 then
    raise exception 'Tournament is full'
      using errcode = 'P0001', detail = 'tournament_full';
  end if;

  -- ON CONFLICT DO NOTHING makes a repeat join idempotent rather than an error.
  insert into public.tournament_players (tournament_id, user_id)
  values (v_tournament.id, v_user_id)
  on conflict (tournament_id, user_id) do nothing;

  return v_tournament.id;
end;
$$;

comment on function public.join_tournament(text) is 'Resolves a join code and adds the caller to the tournament under a row lock. The only supported path for inserting into tournament_players. Failure reasons are carried in the error DETAIL as stable tokens.';

-- CREATE OR REPLACE preserves ownership and privileges; these are re-issued so the
-- migration states the intended grants on its own.
revoke execute on function public.join_tournament(text) from public, anon;
grant execute on function public.join_tournament(text) to authenticated;
