-- Migration: the creator cannot leave their own tournament
-- Purpose:  Close a path to a degenerate tournament. The self-leave policy was satisfied by
--           the creator's own membership row, so two requests -- leave, then start -- produced
--           a `started` tournament with a creator and ZERO players. Confirmed against the
--           deployed app. The UI hid the leave control from the creator, but hiding a button
--           is not enforcement; the policy is.
-- Affected: policy tournament_players_delete_self_in_lobby on public.tournament_players
--
-- This is the same shape of defect the tournament-data-model review found on the start
-- button: an invariant enforced only by the absence of a control in the UI.
--
-- A creator who wants rid of their tournament deletes the tournament itself, which the
-- creator-delete policy on public.tournaments already permits while in lobby.

drop policy tournament_players_delete_self_in_lobby on public.tournament_players;

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
        and t.creator_id <> (select auth.uid())
    )
  );
