-- Migration: round-robin pairing schema and generation
-- Purpose:  Give matches the round ordinal the opponent view needs, constrain a match's
--           players to members of its tournament, and make starting a tournament generate
--           its complete schedule in the same transaction as the status flip.
-- Affected: public.matches (round_number, status vocabulary, two composite FKs),
--           public.start_tournament (new), policy tournaments_update_creator_in_lobby (dropped)
--
-- WHY ONE TRANSACTION: starting is a one-way door. Once a tournament is 'started', members
-- cannot leave, the creator cannot revert or delete it, and join_tournament refuses new
-- players -- every recovery policy requires 'lobby'. So if the status flip and the pairing
-- were separate calls and the second failed, the tournament would be permanently bricked with
-- no in-app recovery. That is strictly worse than the create-tournament case, which recovers
-- precisely because it is still in lobby.
--
-- WHY A FUNCTION RATHER THAN AN INSERT POLICY: public.matches has no column grants anywhere,
-- so `authenticated` holds Supabase's stock ALL PRIVILEGES -- an INSERT policy would let a
-- creator write status, id and created_at directly. And a WITH CHECK is evaluated per
-- candidate row, so it structurally cannot express "this is a complete, correct round-robin
-- over the roster". Inside this function the caller supplies a uuid and nothing else; every
-- pairing is derived server-side from tournament_players.

-- ---------------------------------------------------------------------------
-- schema
-- ---------------------------------------------------------------------------

-- Presentation ordinal, not a barrier. Players progress independently; the ordinal exists so
-- that both players of a given match reach it at the same position in their own schedule,
-- which is what lets the UI name one opponent and have that naming be mutual.
alter table public.matches
  add column round_number integer not null;

comment on column public.matches.round_number is 'Circle-method round ordinal. Ordering only -- it never gates play, since the PRD requires that no player be blocked by another player''s pace.';

-- 'abandoned' distinguishes a match nobody finished from one never started. Without it a
-- no-show is indistinguishable from a pending match and S-04's "tournament concluded" signal
-- can never fire. Nothing writes it yet -- the Durable Object knows about expiry but holds no
-- database credential. That bridge is S-03's.
alter table public.matches
  drop constraint matches_status_check;

alter table public.matches
  add constraint matches_status_check
  check (status in ('pending', 'in_progress', 'finished', 'abandoned'));

-- A match's players must be members of its tournament. Nothing enforced this before, and the
-- realistic way it breaks is a race rather than a bug: a player may leave while the tournament
-- is in lobby, so a non-atomic read-then-write could pair someone who is already gone.
--
-- ON DELETE RESTRICT, deliberately: match history becomes immutable once pairing exists, which
-- is what S-04's statistics need. The cost is that a future creator-kick path is blocked until
-- someone decides what kicking should do to a mid-tournament player's matches. Forcing that
-- decision is the point -- the alternative silently erases history and retroactively changes
-- other players' standings.
alter table public.matches
  add constraint matches_player_a_is_member
  foreign key (tournament_id, player_a_id)
  references public.tournament_players (tournament_id, user_id)
  on delete restrict;

alter table public.matches
  add constraint matches_player_b_is_member
  foreign key (tournament_id, player_b_id)
  references public.tournament_players (tournament_id, user_id)
  on delete restrict;

-- ---------------------------------------------------------------------------
-- pairing and start
-- ---------------------------------------------------------------------------

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
  v_round integer;
  v_i integer;
  v_pos_a integer;
  v_pos_b integer;
  v_player_a uuid;
  v_player_b uuid;
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

  -- Circle method. Position 1 is held fixed while positions 2..v_slots rotate; round r pairs
  -- the fixed position against one rotating position and mirrors the rest around the circle.
  -- Every unordered pair occurs exactly once across v_slots-1 rounds, so matches_distinct_players
  -- and matches_tournament_pair_uniq are satisfied by construction rather than by checking.
  --
  -- An odd roster gets one phantom slot; whoever draws it that round simply has no row for
  -- that ordinal. No bye row is ever written -- least()/greatest() ignore NULLs, so two byes
  -- for the same player would collide on the normalised-pair index.
  v_slots := v_count + (v_count % 2);
  v_rounds := v_slots - 1;

  for v_round in 1 .. v_rounds loop
    for v_i in 0 .. (v_slots / 2 - 1) loop
      if v_i = 0 then
        v_pos_a := 1;
        v_pos_b := 2 + ((v_round - 1) % v_rounds);
      else
        v_pos_a := 2 + ((v_round - 1 + v_i) % v_rounds);
        v_pos_b := 2 + ((v_round - 1 - v_i + v_rounds) % v_rounds);
      end if;

      -- A position beyond the real roster is the phantom: that player sits this round out.
      v_player_a := case when v_pos_a <= v_count then v_players[v_pos_a] end;
      v_player_b := case when v_pos_b <= v_count then v_players[v_pos_b] end;

      if v_player_a is not null and v_player_b is not null then
        insert into public.matches (tournament_id, player_a_id, player_b_id, round_number)
        values (p_tournament_id, v_player_a, v_player_b, v_round);
        v_created := v_created + 1;
      end if;
    end loop;
  end loop;

  update public.tournaments
  set status = 'started'
  where id = p_tournament_id;

  return v_created;
end;
$$;

comment on function public.start_tournament(uuid) is 'Generates the complete round-robin schedule and flips the tournament to started, atomically. The only supported path to status = started. Failure reasons are carried in the error DETAIL as stable tokens.';

revoke execute on function public.start_tournament(uuid) from public, anon;
grant execute on function public.start_tournament(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- close the bypass
-- ---------------------------------------------------------------------------

-- With the policy and column grant in place, a bare PATCH could still reach 'started' without
-- generating a schedule -- manufacturing exactly the bricked state this function exists to
-- prevent. Dropping both makes start_tournament() the sole route, mirroring the "no INSERT
-- policy, one owned function" shape tournament_players already has.
--
-- NOTE: this moves the creator-only check out of a policy verified against production during
-- S-01's review and into the PL/pgSQL above. It must be re-verified by hand.
drop policy tournaments_update_creator_in_lobby on public.tournaments;

revoke update (status) on public.tournaments from authenticated;
