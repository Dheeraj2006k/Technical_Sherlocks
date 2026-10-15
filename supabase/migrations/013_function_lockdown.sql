-- 013: the case lifecycle function and the content-freeze trigger functions live in the exposed public schema. Postgres grants
-- EXECUTE to PUBLIC by default, which would let Supabase's anon/authenticated roles call them through the REST API.
-- Remove that: only the owner (the application's database role) may execute them. Triggers keep firing.
revoke all on function transition_case_status(uuid, text, text, jsonb) from public;
revoke all on function teams_pin_version() from public;
revoke all on function guard_case_content() from public;
revoke all on function guard_case_row() from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function transition_case_status(uuid, text, text, jsonb) from %I', r);
      execute format('revoke all on function teams_pin_version() from %I', r);
      execute format('revoke all on function guard_case_content() from %I', r);
      execute format('revoke all on function guard_case_row() from %I', r);
    end if;
  end loop;
end $$;
