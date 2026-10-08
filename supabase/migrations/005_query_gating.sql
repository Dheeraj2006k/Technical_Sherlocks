-- 005_query_gating.sql
-- Stage 3 groundwork: lock down core tables, give each case a slug (its schema name), and keep
-- the per-(case, phase) query keys that gate player SQL.
--
-- Player SQL runs as the dedicated login role `player_exec` (created by
-- scripts/setup-player-role.mjs, never in a migration: it needs a generated password).
-- Case clue tables live in schema case_<slug>. Row-level security on each of them admits a row
-- only when sha256(current_setting('app.key')) matches the hash of a key for a phase that has
-- unlocked that table. The server does `SET LOCAL app.key = <key>` itself; players can read their
-- own key but can neither derive a later phase's key from the policy hashes nor forge one.

-- 1. Core tables must be unreachable through Supabase's public API (anon/authenticated).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all sequences in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    revoke all on all sequences in schema public from authenticated;
  end if;
end $$;

-- 2. cases.slug: stable internal identifier; the clue-table schema is case_<slug>.
alter table cases add column slug text;
update cases set slug = 'stub' where id = '00000000-0000-4000-8000-000000000001';
update cases set slug = 'c' || substr(md5(id::text), 1, 10) where slug is null;
alter table cases alter column slug set not null;
alter table cases add constraint cases_slug_key unique (slug);
alter table cases add constraint cases_slug_format check (slug ~ '^[a-z][a-z0-9_]{1,30}$');

-- 3. Per-(case, phase) keys. Server-only: RLS on, no policies, no grants to player_exec.
create table case_query_keys (
  case_id uuid not null references cases(id) on delete cascade,
  phase   int  not null check (phase between 1 and 3),
  key     text not null,
  primary key (case_id, phase)
);
alter table case_query_keys enable row level security;
