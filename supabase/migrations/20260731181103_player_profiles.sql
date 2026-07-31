-- Migration: player display names
-- Purpose:  Give every account a display name, so a pairing can name a person rather than a
--           UUID prefix. Until now the only human-readable identity in the system was the
--           email in auth.users, which is unreachable from the client three ways over: the
--           auth schema is not exposed through the API, no grant on it exists, and no
--           service_role key is configured.
-- Affected: public.profiles (new), public.handle_new_user (new trigger function),
--           private.my_co_member_ids (new helper)
--
-- PRIVACY, deliberately: the display name NEVER defaults to the email. The persona is
-- youth-camp participants aged roughly 15-40, under a flat model with no admin role. Emails
-- are frequently firstname.lastname@, they are durable off-platform contact handles, and
-- surfacing them would hand players exactly the contact channel the PRD's non-goals decline to
-- build ("No in-app chat or messaging between players"). The fallback is a pseudonym derived
-- from the user id instead.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 40)
);

comment on table public.profiles is 'One display name per account. Populated by a trigger on auth.users so no code path can create an account without one.';

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- population
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because the trigger fires as the auth admin writing into a public table,
-- and search_path = '' with every relation schema-qualified for the same reason every other
-- definer function here does it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    -- Signup metadata when the form supplied it; otherwise a stable pseudonym from the id.
    -- Never new.email -- see the privacy note at the top of this migration.
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      'Gracz ' || upper(substring(replace(new.id::text, '-', '') from 1 for 4))
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A trigger only fires on future inserts, so every account that already exists would have no
-- profile and therefore no name anywhere in the UI. Backfill with the same pseudonym rule.
insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(trim(u.raw_user_meta_data ->> 'display_name'), ''),
    'Gracz ' || upper(substring(replace(u.id::text, '-', '') from 1 for 4))
  )
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- visibility
-- ---------------------------------------------------------------------------

-- Everyone sharing a tournament with the caller. This exists for the same reason
-- private.my_tournament_ids() does: a policy on profiles that queried tournament_players
-- directly would re-enter that table's own policies and raise 42P17. Running as owner cuts
-- the loop.
create or replace function private.my_co_member_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select distinct other.user_id
  from public.tournament_players mine
  join public.tournament_players other on other.tournament_id = mine.tournament_id
  where mine.user_id = (select auth.uid());
$$;

comment on function private.my_co_member_ids() is 'User ids sharing at least one tournament with the caller. Used by the profiles select policy to avoid recursive policy evaluation.';

-- Both grants are required: policy expressions run with the querying user's privileges, so
-- authenticated needs USAGE on the schema as well as EXECUTE on the function.
grant execute on function private.my_co_member_ids() to authenticated;

-- Scoped to co-members, NOT `using (true)`. A permissive policy here would turn the app into a
-- directory of every registered camper, enumerable by anyone with an account -- which is a
-- different and worse disclosure than the one this migration exists to avoid.
create policy profiles_select_self_or_co_member
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or id in (select private.my_co_member_ids())
  );

-- No insert, update or delete policy. The trigger owns population, exactly as
-- join_tournament owns membership inserts. A player cannot yet rename themselves; that is a
-- deliberate omission rather than an oversight, and needs its own policy when it is wanted.
