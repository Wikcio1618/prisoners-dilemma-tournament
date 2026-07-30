-- Migration: narrow join codes to six digits
-- Purpose:  Join codes are read aloud and typed in a noisy room, so they are shortened from
--           8+ alphanumeric characters to exactly 6 digits. All-numeric also removes the
--           O-versus-0 and I-versus-1 confusion that makes a correct code look wrong.
-- Affected: constraint tournaments_join_code_format on public.tournaments
--
-- TRADE-OFF, recorded deliberately: this narrows the keyspace from ~10^11 to 10^6. The join
-- code is the sole credential for entering a tournament -- public.join_tournament() resolves
-- it with row-level security bypassed -- and there is no rate limiting on that path yet.
-- Only tournaments in 'lobby' are joinable and a camp runs very few at once, so the practical
-- exposure is small, but enumeration is reachable by a script in a way 8 characters was not.
-- Rate limiting is tracked as S-03 scope.
--
-- The column stays `text`: a numeric type would drop the leading zero from codes like 004821.
-- The table is empty, so the constraint validates instantly.

alter table public.tournaments
  drop constraint tournaments_join_code_format;

alter table public.tournaments
  add constraint tournaments_join_code_format
  check (join_code ~ '^[0-9]{6}$');

comment on column public.tournaments.join_code is 'Shareable entry token: exactly six digits, stored as text so leading zeros survive. Acts as the sole authorization credential for joining, so the format is enforced here rather than in application code.';
