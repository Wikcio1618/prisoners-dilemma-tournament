-- Migration: make join_tournament idempotent for members who are already in
-- Purpose:  The capacity check ran before the ON CONFLICT insert, so an existing member
--           of a full tournament was rejected with 'tournament_full' -- a reconnect,
--           back-navigation, or retry told someone they could not enter a tournament they
--           were already in. Worst at the boundary: the 50th player's insert commits, the
--           response is lost to a network drop, and the retry reports the tournament full.
--           The same ordering rejected an existing member re-entering a *started*
--           tournament, which is the ordinary reconnect path once play begins.
-- Affected: public.join_tournament(text)
--
-- Membership is now resolved before any state gate: if the caller is already in, the call
-- returns the tournament id unchanged. The gates below it apply only to genuine newcomers.

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

  -- Already a member: succeed without re-examining lobby state or capacity. This is what
  -- makes a repeated join idempotent, and it must precede the gates below -- a member of a
  -- started or full tournament is reconnecting, not joining.
  if exists (
    select 1
    from public.tournament_players
    where tournament_id = v_tournament.id
      and user_id = v_user_id
  ) then
    return v_tournament.id;
  end if;

  if v_tournament.status <> 'lobby' then
    raise exception 'Tournament has already started'
      using errcode = 'P0001', detail = 'tournament_already_started';
  end if;

  select count(*) into v_player_count
  from public.tournament_players
  where tournament_id = v_tournament.id;

  -- This literal is mirrored by MAX_PLAYERS_PER_TOURNAMENT in src/lib/tournament.ts.
  -- Both must be updated together; nothing enforces the pairing automatically.
  if v_player_count >= 50 then
    raise exception 'Tournament is full'
      using errcode = 'P0001', detail = 'tournament_full';
  end if;

  insert into public.tournament_players (tournament_id, user_id)
  values (v_tournament.id, v_user_id)
  on conflict (tournament_id, user_id) do nothing;

  return v_tournament.id;
end;
$$;

comment on function public.join_tournament(text) is 'Resolves a join code and adds the caller to the tournament under a row lock. The only supported path for inserting into tournament_players. Idempotent: an existing member gets the tournament id back regardless of lobby state or capacity. Failure reasons are carried in the error DETAIL as stable tokens.';

revoke execute on function public.join_tournament(text) from public, anon;
grant execute on function public.join_tournament(text) to authenticated;
