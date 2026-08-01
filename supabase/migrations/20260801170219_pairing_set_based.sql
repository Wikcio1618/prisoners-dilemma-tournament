-- Replace the row-at-a-time pairing loop with a single set-based INSERT ... SELECT.
--
-- Behaviour is unchanged: same circle method, same deterministic roster order, same eight-step
-- gate ordering, same failure tokens. Only the insert strategy differs.
--
-- Why: at the 50-player cap the loop issued 1225 single-row INSERTs, each re-checking two
-- composite FKs and the normalised-pair expression index, all while holding FOR UPDATE on the
-- tournaments row. Supabase's default statement_timeout for `authenticated` is 8s, and the
-- original plan had assumed one set-based statement all along. Raised as F8 in
-- context/changes/generate-round-robin-pairing/reviews/impl-review.md.
--
-- The circle-method arithmetic is transcribed unchanged from 20260731174617_pairing_schema.sql;
-- the CASE expressions are the loop's `if v_i = 0 then ... else ... end if` branches, and the
-- WHERE clause is its phantom-slot null guard. An odd roster still writes no bye row.

create or replace function public.start_tournament(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_tournament public.tournaments%rowtype;
  v_players uuid[];
  v_count integer;
  v_slots integer;
  v_rounds integer;
  v_created integer := 0;
begin
  if v_user_id is null then
    raise exception 'Not authenticated'
      using errcode = '28000', detail = 'not_authenticated';
  end if;

  -- FOR UPDATE serialises concurrent starts: two simultaneous presses queue on this row
  -- rather than both reading 'lobby' and both generating a schedule.
  select * into v_tournament
  from public.tournaments
  where id = p_tournament_id
  for update;

  -- Deliberately the same token for "does not exist" and "not yours". Distinguishing them
  -- would turn this function into an existence oracle for tournament ids.
  if not found or v_tournament.creator_id <> v_user_id then
    raise exception 'Tournament not found'
      using errcode = 'P0002', detail = 'tournament_not_found';
  end if;

  -- Idempotent short-circuit BEFORE the remaining gates: a client retrying after a lost
  -- response must get the existing result, not a second schedule or a spurious error.
  if v_tournament.status = 'started' then
    select count(*) into v_created
    from public.matches
    where tournament_id = p_tournament_id;
    return v_created;
  end if;

  if v_tournament.status <> 'lobby' then
    raise exception 'Tournament is already finished'
      using errcode = 'P0001', detail = 'tournament_finished';
  end if;

  -- Ordered so the schedule is deterministic for a given roster.
  select array_agg(user_id order by user_id) into v_players
  from public.tournament_players
  where tournament_id = p_tournament_id;

  v_count := coalesce(array_length(v_players, 1), 0);
  if v_count < 2 then
    raise exception 'Not enough players'
      using errcode = 'P0001', detail = 'not_enough_players';
  end if;

  -- Circle method, one statement. Position 1 is held fixed while positions 2..v_slots rotate;
  -- round r pairs the fixed position against one rotating position and mirrors the rest around
  -- the circle. Every unordered pair occurs exactly once across v_slots-1 rounds, so
  -- matches_distinct_players and matches_tournament_pair_uniq hold by construction.
  --
  -- An odd roster gets one phantom slot; the WHERE clause drops the pair containing it, so
  -- whoever draws it that round simply has no row for that ordinal. No bye row is ever written
  -- -- least()/greatest() ignore NULLs, so two byes for the same player would collide on the
  -- normalised-pair index.
  v_slots := v_count + (v_count % 2);
  v_rounds := v_slots - 1;

  insert into public.matches (tournament_id, player_a_id, player_b_id, round_number)
  select p_tournament_id, v_players[pos_a], v_players[pos_b], r
  from (
    select
      r,
      case
        when i = 0 then 1
        else 2 + ((r - 1 + i) % v_rounds)
      end as pos_a,
      case
        when i = 0 then 2 + ((r - 1) % v_rounds)
        else 2 + ((r - 1 - i + v_rounds) % v_rounds)
      end as pos_b
    from generate_series(1, v_rounds) as r,
         generate_series(0, v_slots / 2 - 1) as i
  ) positions
  where pos_a <= v_count
    and pos_b <= v_count;

  get diagnostics v_created = row_count;

  update public.tournaments
  set status = 'started'
  where id = p_tournament_id;

  return v_created;
end;
$$;

-- create or replace preserves the existing ACL, but re-stating it keeps this migration
-- self-contained rather than dependent on reading its predecessor.
revoke execute on function public.start_tournament(uuid) from public, anon;
grant execute on function public.start_tournament(uuid) to authenticated;
