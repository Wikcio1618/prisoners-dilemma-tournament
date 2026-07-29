-- Migration: tournament tables and constraints
-- Purpose:  Create the minimal tournament domain for roadmap item F-01 — a tournament
--           with a fixed round count and a shareable join code, a membership junction,
--           and a structural matches table that S-02 will later populate.
-- Affected: public.tournament_status, public.match_status,
--           public.tournaments, public.tournament_players, public.matches
--
-- Notes:
--   * Row-level security is intentionally NOT enabled here. It lands in the following
--     migration (tournament_rls) together with the policies and the join function, so a
--     failed push points at one half of the change unambiguously.
--   * rounds_per_match carries no CHECK constraint by explicit decision — the 1..20
--     bounds are enforced in application code (see src/lib/tournament.ts).

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------

create type public.tournament_status as enum ('lobby', 'started', 'finished');

create type public.match_status as enum ('pending', 'in_progress', 'finished');

-- ---------------------------------------------------------------------------
-- tournaments
-- ---------------------------------------------------------------------------

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete cascade,
  rounds_per_match integer not null,
  join_code text not null,
  status public.tournament_status not null default 'lobby',
  created_at timestamptz not null default now(),
  constraint tournaments_join_code_key unique (join_code)
);

comment on table public.tournaments is 'One tournament session created by a player; join_code is the shareable entry token.';
comment on column public.tournaments.rounds_per_match is 'Fixed number of rounds every match in this tournament plays. Bounds enforced in application code, not in the database.';

-- Creator lookups ("tournaments I created") and the creator clause of the select policy.
create index tournaments_creator_id_idx on public.tournaments (creator_id);

-- ---------------------------------------------------------------------------
-- tournament_players
-- ---------------------------------------------------------------------------

create table public.tournament_players (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

comment on table public.tournament_players is 'Membership junction. Every insert goes through public.join_tournament(); there is deliberately no insert policy.';

-- Required by the membership helper in the next migration, which filters on user_id.
-- The composite primary key's leading column is tournament_id, so its prefix does not serve this lookup.
create index tournament_players_user_id_idx on public.tournament_players (user_id);

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  player_a_id uuid not null references auth.users (id) on delete cascade,
  player_b_id uuid not null references auth.users (id) on delete cascade,
  status public.match_status not null default 'pending',
  created_at timestamptz not null default now(),
  constraint matches_distinct_players check (player_a_id <> player_b_id)
);

comment on table public.matches is 'Structural pairing table. Nothing writes to it yet — S-02 owns round-robin generation.';

create index matches_tournament_id_idx on public.matches (tournament_id);

-- A plain unique (tournament_id, player_a_id, player_b_id) would still allow the reversed
-- duplicate (B,A). Normalising the pair before indexing is what actually forbids it.
create unique index matches_tournament_pair_uniq
  on public.matches (
    tournament_id,
    least(player_a_id, player_b_id),
    greatest(player_a_id, player_b_id)
  );
