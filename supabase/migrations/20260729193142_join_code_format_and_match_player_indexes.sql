-- Migration: enforce a join-code format floor and index the match player columns
-- Purpose:  Two review findings.
--
--   1. join_code is the sole authorization token for entering a tournament -- it is
--      resolved inside join_tournament() with row-level security bypassed, and no other
--      check gates membership. The column previously accepted any text, including '' and
--      'game1', and the insert policy constrains only creator_id and status, so the
--      client chose the code. A guessed code grants permanent membership: the member
--      delete policy permits only self-removal in lobby and there is no creator-kick
--      path. The bound belongs in the database, where it is enforced unconditionally and
--      cannot drift from a TypeScript constant.
--
--   2. matches.player_a_id and matches.player_b_id were the only unindexed foreign keys
--      in the schema. Postgres does not index the referencing side automatically, so
--      deleting one auth.users row sequentially scans public.matches once per constraint
--      while holding locks inside the auth deletion transaction. The same indexes serve
--      the "matches I am playing" lookup that S-02 and S-03 will run constantly.
--
-- Affected: public.tournaments (new check constraint), public.matches (two new indexes)
--
-- Both are additive and safe on a live database; the tables are empty today, so the
-- constraint validates instantly.

-- The pattern is mirrored by JOIN_CODE_PATTERN in src/lib/tournament.ts. This is a floor
-- on entropy, not a full specification -- S-01 owns generating codes server-side rather
-- than trusting the client to pick one.
alter table public.tournaments
  add constraint tournaments_join_code_format
  check (join_code ~ '^[A-Z0-9]{8,}$');

comment on column public.tournaments.join_code is 'Shareable entry token. Acts as the sole authorization credential for joining, so the format floor is enforced here rather than in application code.';

create index matches_player_a_id_idx on public.matches (player_a_id);
create index matches_player_b_id_idx on public.matches (player_b_id);
