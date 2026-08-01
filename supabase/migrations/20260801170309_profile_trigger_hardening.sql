-- Three fixes from the generate-round-robin-pairing implementation review
-- (context/changes/generate-round-robin-pairing/reviews/impl-review.md): F3, F7, F9.

-- F3 -- a SECURITY DEFINER trigger on auth.users must never be able to fail a signup.
--
-- The previous body inserted raw_user_meta_data ->> 'display_name' verbatim into a column
-- constrained to 1-40 characters, so a longer value raised inside the auth.users insert and
-- failed the whole signup with an opaque "Database error saving new user". The zod schema in
-- src/lib/schemas.ts caps the length, but only on the one app route -- this trigger also fires
-- for the admin API, the Supabase dashboard, and any future OAuth or magic-link path, none of
-- which pass through it. Clamping here makes the constraint unreachable from the trigger.
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
    -- Never new.email -- see the privacy note in 20260731181103_player_profiles.sql.
    -- left(...) clamps to the profiles_display_name_length ceiling; nullif drops a value that
    -- was whitespace-only so the pseudonym fallback still applies.
    coalesce(
      nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 40), ''),
      'Gracz ' || upper(substring(replace(new.id::text, '-', '') from 1 for 4))
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- F9 -- every other SECURITY DEFINER function in this schema pairs its definition with a
-- revoke (join_tournament, start_tournament). This one is not reachable over the API, because
-- PostgREST does not expose functions returning `trigger`, so this is convention rather than
-- exposure -- but the convention is what makes an audit of definer functions quick.
revoke execute on function public.handle_new_user() from public, anon;

-- F7 -- 20260731181103_player_profiles.sql states "Both grants are required" but issues only
-- the EXECUTE grant. The effective state was already correct because
-- 20260729174939_tournament_rls.sql:50 granted schema usage, but that made the profiles
-- migration silently dependent on its predecessor. Both grants are idempotent; stating them
-- here makes the dependency explicit rather than inherited.
grant usage on schema private to authenticated;
grant execute on function private.my_co_member_ids() to authenticated;
