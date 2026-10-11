# Database migration: v4 to v5

Migration file: `supabase/migrations/009_v5_engine.sql`. It is **additive**: nothing from migrations 001-008 is dropped, so a
populated v4 database upgrades in place. It has been applied (a) to an empty local database together with 001-008 and
(b) on top of a v4 schema holding v4-style data (`tests/v5_migration.test.mjs`). It has **not** been applied to any remote
database.

## What it does

| Area | Change |
|---|---|
| `cases` | + `game_track` (`SQL`/`LOGIC`), `target_duration_minutes`, `content_version`, `final_points_culprit`, `final_points_mechanism`. Status vocabulary becomes `draft / tested / published / disabled` (`live` and `active` become `published`). `case_code` format relaxed to `^[A-Z0-9][A-Z0-9-]{2,15}$` so `SQL01` and old random codes are both valid. |
| Registration | + `registrations`, `team_case_assignments` (partial unique indexes: one *active* assignment per registration and per team), `teams.registration_id` (one team per registration), `admin_audit`. |
| Threads | + `investigation_threads`, `thread_evidence_tables`, `team_thread_progress`, `thread_assignments`, `story_events`. |
| Questions | `tasks` + `thread_id`, `position`, `base_points`, `reward_schedule`; + `task_hints`, `team_hint_usage`, `task_attempts`, `team_task_completions`. |
| Final deduction | + `final_options`, `final_attempts`, `team_final_completions`. |
| Scores | `team_scores` + `points_by_component`, `updated_at`. |
| Evidence gate | + `case_table_keys` (one secret key per case and evidence table; server-only). |
| Security | Row-level security is enabled on every `public` table and `anon` / `authenticated` grants are revoked, again, for the new tables. |

The v4 gameplay tables (`task_submissions`, `culprit_submission`, `task_assignments`, `case_query_keys`) are left in place and
are no longer written by the application. They can be dropped in a later cleanup migration once nobody needs the history.

## What it does not do

* It does **not** convert v4 cases or v4 games. v4 cases have no threads, so they cannot be played by the v5 engine. The
  content comes from `node scripts/seed-cases.mjs`, which installs SQL01-SQL10 and LOG01-LOG10 (replacing any case that holds
  the same slug or catalogue code, **and deleting teams that played the replaced case**).
* It does not create registrations. The organizer creates them in the admin screen (Registrations) before the event.

## Order of operations for the real database (needs the organizers' approval)

1. Pick a window with no event running. Take a Supabase backup / point-in-time marker.
2. `npm run db:migrate` (applies 009; every file runs in its own transaction and is recorded in `schema_migrations`).
3. `node scripts/setup-player-role.mjs` (idempotent; keeps the low-privilege `player_exec` role and its grants current).
4. `SLC_ALLOW_REMOTE_DB=1 node scripts/seed-cases.mjs` (installs and validates the 20 cases; each becomes `tested` only if every
   machine check passes).
5. `SLC_ALLOW_REMOTE_DB=1 node scripts/gen-case-credentials.mjs --all --publish` (new passwords, printed once; cases become
   `published`).
6. Create registrations in `/admin`, assign cases, hand out registration references + case codes + passwords.
7. Run a rehearsal (EVENT_RUNBOOK.md, "Rehearsal") against the deployed site with two throwaway registrations, then delete
   those teams from the admin screen.
8. Deploy the application build that matches the schema. Do the migration **before** the deploy if both are needed: the old
   build ignores the new tables, and the new build needs them.

## Rollback

Migration 009 only adds objects and updates `cases.status`. To go back: restore the backup from step 1, or, if nothing new has
been written, redeploy the previous build (it ignores the new tables and columns) and set `cases.status` back to `live` for the
cases it should serve. `case_code` values that were rewritten by the seed script are not restored automatically.

## Re-running

Everything is idempotent: `migrate` skips applied files, `setup-player-role` re-applies settings, and `seed-cases` replaces cases
by id, slug and code.
