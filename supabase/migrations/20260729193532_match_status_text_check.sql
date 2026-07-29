-- Migration: replace the match_status enum with text + a check constraint
-- Purpose:  Keep the same three values while making the vocabulary cheap to revise.
--           S-02 owns what a match actually is; the original plan deferred match
--           semantics entirely, and matches.status was typed during implementation only
--           because the plan named the column without naming a type. A Postgres enum is
--           the most expensive artifact to walk back -- values can be added but not
--           removed or reordered without recreating the type and rewriting every
--           dependent column. A check constraint enforces exactly the same values and is
--           revised with a drop plus an add.
-- Affected: public.matches.status; drops public.match_status
--
-- Safe to run unconditionally here: public.matches is empty, so the column rewrite and
-- the constraint validation are both instant. public.tournament_status is NOT touched --
-- that vocabulary is settled and owned by this change.

alter table public.matches
  alter column status drop default;

alter table public.matches
  alter column status type text
  using status::text;

alter table public.matches
  alter column status set default 'pending';

alter table public.matches
  add constraint matches_status_check
  check (status in ('pending', 'in_progress', 'finished'));

drop type public.match_status;

comment on column public.matches.status is 'Match lifecycle. Provisional vocabulary -- S-02 owns pairing and match semantics, and may redefine these values by replacing matches_status_check while the table is empty.';
