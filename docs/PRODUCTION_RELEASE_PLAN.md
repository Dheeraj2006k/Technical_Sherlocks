# Production release plan (case packs, migrations 010-013)

Status: prepared from the owner-verified production facts; no production read or write has been performed by Claude (permission controls denied production access).

## Verified facts (owner, manual)
Migrations 001-009 applied; 21 published cases; 2 registrations; 3 assignments (1 assigned, 2 cancelled); 0 teams; 0 team_progress.

## Offline review of migrations 010-013
| Migration | Destructive / incompatible operations | Effect on current production data |
|---|---|---|
| 010 | drops `cases_case_code_key` (replaced by `unique(case_code, content_version)` plus a partial unique "one published per code"); replaces `cases_status_check` to add `review`; adds columns, triggers, `players.tour_state` | The 21 published rows have distinct codes and version 1, so the new constraints hold. No row is rewritten. |
| 011 | none (new nullable/defaulted columns, new table `task_options`) | none |
| 012 | none (two nullable columns) | none |
| 013 | revokes EXECUTE on four functions from PUBLIC/anon/authenticated | none for the app (it connects as the owner role) |

New pack slugs are `sqlNN_v2` / `logNN_v2`, so they cannot collide with existing slugs.

## Compatibility and order
- New code before migrations: breaks (the state query reads `tour_state`, `alt_answers`, `task_options`, `phase_name`, `public_profile`).
- Migrations before new code: the currently deployed app is expected to keep working (not tested against a copy of production: it only reads columns that still exist and joins require `published`). So the safe order is: **backup -> migrate -> seed -> deploy**.

## The assigned registration (important)
Publishing a new version of a code runs `transition_case_status`, which **disables the previously published version of that code**. A not-yet-started registration assigned to a disabled version can no longer start a team (existing teams can still rejoin; new teams need `published`). Therefore:
1. Find the case code of the single assigned registration (`select c.case_code, c.content_version, c.status from assignments a join cases c on c.id = a.case_id where a.status = 'assigned'`).
2. Do not publish a v2 of that code until that registration has started, or reassign it first from the admin screen (the owner's decision; this is an update to an assignment and is not done automatically).
3. The two cancelled assignments are untouched; nothing in 010-013 or the seed writes to assignments or registrations.

## Steps (run only after the owner confirms a usable backup / PITR for the verified project)
1. `SLC_ALLOW_REMOTE_DB=1 npm run db:migrate` (migration role), then `npm run check:env`.
2. `SLC_ALLOW_REMOTE_DB=1 node scripts/seed-cases.mjs --dry-run`: expect 12 INSTALL lines (v2), no REPLACE or BLOCKED; legacy v1 rows are not mentioned. Inspect, then run without `--dry-run`. All 12 land in `review`.
3. Verify: 12 rows with `content_version = 2`, status `review`; registrations and assignments row counts unchanged (2 and 3); the 21 legacy rows still `published`.
4. Do not run `retire-legacy-cases.mjs --apply` yet.
5. Deploy the feature branch (or merge to the Vercel production branch) after step 3; confirm the production domain serves the intended commit.
6. Smoke test with one disposable registration. Publishing any v2 for it needs the owner to name the case and accept the recorded exception (no human review or blind playtest has passed).
7. Clean up only the disposable records by exact identifiers.

## Rollback
Migrations are forward-fix only (see DATABASE_MIGRATION.md). Recovery = restore the pre-migration backup/PITR point; the seed only inserts new rows, which can be disabled (never deleted once a team references them).
