-- 004_hardening.sql
-- Case-insensitive player names, short human-friendly case/team codes, join rate-limit table.
-- Crockford base32 alphabet (no I, L, O, U): 0123456789ABCDEFGHJKMNPQRSTVWXYZ

-- 1. Display names unique per team, case-insensitively.
alter table players drop constraint players_team_display_name_key;
create unique index players_team_lower_name_key on players (team_id, lower(display_name));

-- 2. cases.case_code (8 chars). Stub case gets the fixed documented code SH3R10CK.
alter table cases add column case_code text;
update cases set case_code = 'SH3R10CK' where id = '00000000-0000-4000-8000-000000000001';
update cases c
   set case_code = (select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), '')
                      from generate_series(1, 8) g(i)
                     where c.id is not null)   -- correlated so it is re-evaluated per row
 where case_code is null;
alter table cases alter column case_code set not null;
alter table cases add constraint cases_case_code_key unique (case_code);
alter table cases add constraint cases_case_code_format check (case_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$');

-- Only status = 'live' cases are joinable; the old stub value was 'active'.
update cases set status = 'live' where status = 'active';

-- 3. team_code is now 6 Crockford chars (stored without the display hyphen).
--    Teams with old-format codes are throwaway test data.
delete from teams where team_code !~ '^[0-9A-HJKMNP-TV-Z]{6}$';
alter table teams add constraint teams_team_code_format check (team_code ~ '^[0-9A-HJKMNP-TV-Z]{6}$');

-- 4. DB-backed rate limiting (no in-memory counters: Vercel is serverless).
create table join_attempts (
  id         bigserial primary key,
  ip_hash    text not null,                       -- HMAC(SESSION_SECRET, ip); raw IP is never stored
  created_at timestamptz not null default now()
);
create index join_attempts_ip_created_idx on join_attempts (ip_hash, created_at);
create index join_attempts_created_idx on join_attempts (created_at);

create index task_submissions_player_time_idx on task_submissions (player_id, submitted_at desc);
