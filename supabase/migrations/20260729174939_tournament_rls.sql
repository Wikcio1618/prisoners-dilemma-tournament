-- Migration: tournament access control
-- Purpose:  Enable row-level security on the tournament tables, add the helper schema
--           that breaks policy recursion, define per-operation policies, and add the
--           join_tournament() function that owns every membership insert.
-- Affected: private schema, public.tournaments, public.tournament_players, public.matches
--
-- Design notes:
--   * Joining by code cannot be expressed as a policy. A policy predicate is evaluated
--     per candidate row and cannot see the client's WHERE clause, so "you may read this
--     row if you supplied its code" has no policy form — USING (true) plus a client-side
--     filter would let anyone enumerate every tournament. Hence join_tournament().
--   * tournament_players has NO insert policy. With RLS enabled and no matching policy,
--     access is denied by default, so every membership insert must go through
--     join_tournament() — including the creator's own.
--   * Policies query private.my_tournament_ids() rather than the tables directly. A
--     policy that queries a table whose own policies query back raises
--     42P17 "infinite recursion detected in policy for relation ...". The SECURITY
--     DEFINER helper runs as its owner, so the target table's policies are not re-applied.
--   * auth.uid() is always wrapped as (select auth.uid()) so the planner hoists it into
--     an InitPlan evaluated once per statement rather than once per row
--     (Supabase advisor lint 0003_auth_rls_initplan).

-- ---------------------------------------------------------------------------
-- recursion-breaking helper
-- ---------------------------------------------------------------------------

create schema if not exists private;

comment on schema private is 'Helpers for row-level security policies. Deliberately NOT exposed through the API.';

-- Returns the tournament ids the caller belongs to. SECURITY DEFINER so that reading
-- tournament_players here does not re-enter that table's own policies.
create or replace function private.my_tournament_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select tp.tournament_id
  from public.tournament_players tp
  where tp.user_id = (select auth.uid());
$$;

comment on function private.my_tournament_ids() is 'Tournament ids the calling user is a member of. Used by policies to avoid recursive policy evaluation.';

-- Both grants are required: policy expressions execute with the privileges of the
-- querying user, so authenticated needs USAGE on the schema as well as EXECUTE on the
-- function. Omitting either produces a permission error at query time, not at push time.
grant usage on schema private to authenticated;
grant execute on function private.my_tournament_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- enable row-level security
-- ---------------------------------------------------------------------------

alter table public.tournaments enable row level security;
alter table public.tournament_players enable row level security;
alter table public.matches enable row level security;

-- No explicit deny policy is written for anon. With RLS enabled and no matching policy,
-- access is already denied, and Postgres has no DENY primitive to write one with.

-- ---------------------------------------------------------------------------
-- tournaments policies
-- ---------------------------------------------------------------------------

-- One policy with OR rather than two permissive policies: multiple permissive policies
-- for the same role and command are OR'd anyway, but each is evaluated per row
-- (advisor lint 0006). The creator clause keeps the tournament visible in the window
-- between creating it and joining it, which is a real state because the creator joins
-- explicitly.
create policy tournaments_select_member_or_creator
  on public.tournaments
  for select
  to authenticated
  using (
    id in (select private.my_tournament_ids())
    or creator_id = (select auth.uid())
  );

create policy tournaments_insert_own
  on public.tournaments
  for insert
  to authenticated
  with check (
    creator_id = (select auth.uid())
    and status = 'lobby'
  );

-- USING carries status = 'lobby', which is what makes starting idempotent: once started,
-- the row is invisible to the update path, so a second start affects zero rows.
--
-- WITH CHECK deliberately omits the status term. Postgres reuses USING as WITH CHECK when
-- the latter is absent, which would require the *post-update* row to still be in lobby --
-- rejecting the only update this policy exists to allow. Column-level GRANT below is what
-- confines the update to the status column.
create policy tournaments_update_creator_in_lobby
  on public.tournaments
  for update
  to authenticated
  using (
    creator_id = (select auth.uid())
    and status = 'lobby'
  )
  with check (creator_id = (select auth.uid()));

create policy tournaments_delete_creator_in_lobby
  on public.tournaments
  for delete
  to authenticated
  using (
    creator_id = (select auth.uid())
    and status = 'lobby'
  );

-- ---------------------------------------------------------------------------
-- tournament_players policies
-- ---------------------------------------------------------------------------

create policy tournament_players_select_co_members
  on public.tournament_players
  for select
  to authenticated
  using (tournament_id in (select private.my_tournament_ids()));

-- No INSERT policy by design -- see the header note. join_tournament() owns every insert.

-- A member may remove themselves while the tournament has not started. The subquery on
-- tournaments is safe from recursion: the tournaments select policy resolves membership
-- through the SECURITY DEFINER helper, which does not re-enter this table's policies.
create policy tournament_players_delete_self_in_lobby
  on public.tournament_players
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.tournaments t
      where t.id = tournament_id
        and t.status = 'lobby'
    )
  );

-- ---------------------------------------------------------------------------
-- matches policies
-- ---------------------------------------------------------------------------

-- Read-only for members. No INSERT/UPDATE/DELETE policies -- S-02 will decide how pairing
-- writes rows.
create policy matches_select_member
  on public.matches
  for select
  to authenticated
  using (tournament_id in (select private.my_tournament_ids()));

-- ---------------------------------------------------------------------------
-- column-level grant for starting a tournament
-- ---------------------------------------------------------------------------

-- A row-level policy cannot restrict *which columns* an update touches -- the update
-- policy above would otherwise also permit rewriting rounds_per_match or join_code.
-- The policy and the grant compose; both must pass.
revoke update on public.tournaments from authenticated;
grant update (status) on public.tournaments to authenticated;

-- ---------------------------------------------------------------------------
-- join function
-- ---------------------------------------------------------------------------

-- Owns the entire join operation: resolve the code, verify the tournament is still in
-- lobby and under the player cap, and insert the membership -- atomically. Row-level
-- security can express none of this, and cannot make the capacity check race-free.
--
-- The player cap literal below matches MAX_PLAYERS_PER_TOURNAMENT in src/lib/tournament.ts.
-- Both must be updated together.
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
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- FOR UPDATE is what serialises the capacity check against simultaneous joiners:
  -- concurrent callers queue on this row rather than each reading a stale count.
  select * into v_tournament
  from public.tournaments
  where join_code = p_join_code
  for update;

  if not found then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;

  if v_tournament.status <> 'lobby' then
    raise exception 'Tournament has already started' using errcode = 'P0001';
  end if;

  select count(*) into v_player_count
  from public.tournament_players
  where tournament_id = v_tournament.id;

  if v_player_count >= 50 then
    raise exception 'Tournament is full' using errcode = 'P0001';
  end if;

  -- ON CONFLICT DO NOTHING makes a repeat join idempotent rather than an error.
  insert into public.tournament_players (tournament_id, user_id)
  values (v_tournament.id, v_user_id)
  on conflict (tournament_id, user_id) do nothing;

  return v_tournament.id;
end;
$$;

comment on function public.join_tournament(text) is 'Resolves a join code and adds the caller to the tournament under a row lock. The only supported path for inserting into tournament_players.';

revoke execute on function public.join_tournament(text) from public, anon;
grant execute on function public.join_tournament(text) to authenticated;
