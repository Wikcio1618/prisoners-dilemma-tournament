-- Migration: constrain the tournament update policy to the lobby -> started transition
-- Purpose:  Close a bricking path. The previous WITH CHECK constrained only creator_id,
--           so a creator could set status directly to 'finished'. That row then satisfies
--           no USING clause on either the update or the delete policy, and the member
--           delete policy also requires lobby -- leaving the tournament permanently
--           unmodifiable, undeletable, unjoinable and unleavable, with no recovery path
--           short of a migration.
-- Affected: policy tournaments_update_creator_in_lobby on public.tournaments
--
-- USING still requires 'lobby', which preserves the idempotent start: once started, the
-- row is invisible to the update path, so a second start affects zero rows.
--
-- This deliberately leaves 'finished' unreachable through the policy layer. Concluding a
-- tournament needs server-side statistics computation anyway, so it belongs in a
-- SECURITY DEFINER function (following the join_tournament precedent) that a later slice
-- will add -- not in a policy that would also have to permit the creator to end a
-- tournament arbitrarily.

drop policy tournaments_update_creator_in_lobby on public.tournaments;

create policy tournaments_update_creator_in_lobby
  on public.tournaments
  for update
  to authenticated
  using (
    creator_id = (select auth.uid())
    and status = 'lobby'
  )
  with check (
    creator_id = (select auth.uid())
    and status = 'started'
  );
