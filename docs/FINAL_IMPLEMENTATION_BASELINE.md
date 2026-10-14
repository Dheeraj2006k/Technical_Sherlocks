# Final implementation baseline

Baseline of the repository as audited before this work, and what this work changed. Production was not inspected (see "Production").

## Stack
Next.js (App Router) + PostgreSQL (Supabase-compatible) + Vercel. Pooled `DATABASE_URL` for the app, `DATABASE_URL_PLAYER` for the restricted `player_exec` role. Realtime ping channel, DB-backed rate limits.

## Baseline (before)
- Engine: threads, questions, hints, attempts, completions under a `team_progress` row lock; per-table RLS keys shared by the SQL console and the Evidence Browser; server-authoritative scoring (hints 10/8/6/4/2, -2 wrong committed answer, SQL errors free, retries, points once).
- Cases: ten generated cases, unversioned, one row per case code. Migrations 001-009.

## Changes
| Area | Change |
|---|---|
| Cases | Twelve GitHub-canonical Case Packs in `cases/` built from the supplied `docs/*.zip` (SQL01-06, LOG01-06). Loader/validator `scripts/cases/pack.mjs`, installer/verifier `scripts/cases/engine.mjs`. Old generators kept only as test fixtures (`tests/fixtures/legacy/`). |
| Versions | `cases` keyed by (case_code, content_version); teams pin the version they start on; content-freeze triggers; hashes (migration 010). |
| Lifecycle | `draft -> review -> tested -> published`; `disabled` blocks new assignments; `transition_case_status()`; `tested` needs a recorded reviewer and blind playtest for the exact content hash. |
| Seeding | `scripts/seed-cases.mjs` is idempotent (unchanged / install / replace / blocked), never resets team state, refuses a remote database without `SLC_ALLOW_REMOTE_DB=1`, has `--dry-run`. |
| Answers | CHOICE answer type, alternative accepted answers, per-question reward ladder (migration 011). |
| Onboarding | SQL Field Guide drawer (static), first-visit guided tour (per-player flag, replay from Help), Help menu. |
| Story | Always-visible story banner, full Case File dialog (hook, people, briefings, story so far), case phase names; opens first on entering a case (migration 012). |
| Security | Lifecycle and trigger functions not executable by PUBLIC/anon/authenticated (migration 013). Leak scan covers private pack text. |
| Admin | Case catalogue with Publish/Disable (`/api/admin/case-status`); assignment picks the newest published version. |

## Production
Not audited, migrated, seeded or deployed: the permission controls denied production access and were not bypassed. Exact steps: `DATABASE_MIGRATION.md`, `EVENT_RUNBOOK.md`.

## Verification (local, isolated embedded Postgres)
`npm run lint` (0 errors), `npx tsc --noEmit`, `npm run build`, `npm test` (unit, integration, Playwright E2E), `npm run check:leaks`, `npm run validate:cases` (12 packs, structural + database checks).
