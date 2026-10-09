# Sherlock's Last Case

> *Every crime leaves a query.*

A competitive, browser-based **SQL detective game** for a one-day Techfest. Teams of up to three investigate
one of ten mysteries by querying a live evidence database with SQL, clear three phases of clues, and make
**one** final accusation. Highest score wins; ties go to the earliest correct accusation.

Built to run ~30 to 35 computers (about 10 teams) at once on **Next.js (App Router) + Supabase Postgres**,
deployed on Vercel.

## Features

- **Detective command-center UI**: landing, briefing-room lobby, three-column investigation screen, SQL
  console with syntax highlighting, evidence board, cinematic final deduction, case-resolution reveal, public
  leaderboard ("The Investigation Board") and an organizer "Mission Control". Responsive (desktop, tablet,
  phone), keyboard accessible, `prefers-reduced-motion` aware.
- **10 verified cases**, each with a victim, culprit, motive, method, red herrings, 3 phases x 3 tasks
  (easy, medium, hard), unique answers, and a machine-checked answer key.
- **Server-owned game state**: phases, scoring (20 per phase + 40 for the culprit), phase-clear and culprit
  grading are single transactions; every scoring endpoint is idempotent and race-safe.
- **Defense-in-depth SQL console**: player SQL runs only as a dedicated low-privilege role, in a read-only
  transaction, behind per-case/per-phase RLS gating, a 3 s timeout, a 200-row cap, and a per-player rate limit.
- **Realtime**: Supabase Realtime "changed" pings (no data in them); clients refetch authoritative state.
  Falls back to polling.
- **Organizer tools**: live dashboard, inspect a team's answers and query errors, per-team reset/delete, pause
  one team or the whole game, CSV export.

## Tech stack

Next.js 16 (App Router, TypeScript, Node route handlers) · React 19 · Postgres (Supabase) via `pg` and
`pg-cursor` · `jose` (signed sessions) · `bcryptjs` · Supabase Realtime · plain CSS design system ·
`node:test` + `playwright-core` for tests.

## Local setup

Requirements: Node 20+ (tested on 22), npm, a **development** Supabase project, Chrome or Edge for the E2E tests.

```bash
npm install
cp .env.example .env.local      # then fill in the values (see below). Never commit .env.local
npm run db:migrate               # applies supabase/migrations/*.sql in order
node scripts/setup-player-role.mjs   # creates the low-privilege player_exec login, writes DATABASE_URL_PLAYER
node scripts/seed-cases.mjs          # installs all 10 cases (status: draft)
npm run dev                      # http://localhost:3000
```

### Environment variables

Names only; values live in `.env.local` (git-ignored) locally and in Vercel's environment settings in production.

| Variable | Server/Public | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Postgres connection (use the **transaction-mode pooler** URL in production) |
| `DATABASE_URL_PLAYER` | server | Same database, user `player_exec`; the only connection that runs player SQL. Written by `setup-player-role.mjs` |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Used **only** to publish realtime pings. Never runs player SQL |
| `SESSION_SECRET` | server | Signs player/admin session cookies and hashes IPs |
| `ADMIN_PASSWORD` | server | Organizer login |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public (by design) | Browser realtime subscription. Optional: without them the UI polls every 3 s |
| `JOIN_RATE_PER_MINUTE`, `JOIN_RATE_PER_HOUR` | server | Per-IP join attempt limits (defaults 10 and 30). **Raise for the event**: a venue often shares one public IP |

## Database

Migrations are plain SQL in [supabase/migrations](supabase/migrations) and are applied in filename order by
`scripts/migrate.mjs` (tracked in `schema_migrations`, one transaction per file):

| File | Adds |
|---|---|
| 001 | Core schema (cases, teams, players, tasks, submissions, scores, logs) |
| 002 | Per-team unique names, task assignments, join idempotency |
| 003 | Explicit team state machine column |
| 004 | Case-insensitive names, case/team codes, join rate-limit table |
| 005 | RLS on core tables, case slugs, per-phase query keys |
| 006 | Culprit grading column, pause support |
| 007 | Realtime channel token |
| 008 | Presence, task titles/evidence metadata, case resolution text |

Clue tables for each case live in their own schema `case_<slug>` and are gated per phase by RLS keyed on a key
the server sets per query (only hashes live in the policies). See the "RESOLVED" entry in [CLAUDE.md](CLAUDE.md)
for why this design was chosen over role-switching.

## Cases

Ten definitions in [scripts/cases](scripts/cases): *Opening Night* (hand-authored) plus nine themed cases
generated from one parametric skeleton (`skeleton-a.mjs`, `themes.mjs`). Case ids are fixed
(`00000000-0000-4000-8000-0000000000a1` to `...aa`).

```bash
node scripts/seed-cases.mjs                                  # (re)install all cases as draft
node scripts/verify-case.mjs                                 # mechanical validation of all 10
node scripts/gen-case-credentials.mjs <case-id> --live       # new case code + password, shown ONCE; makes it joinable
```

`verify-case` proves every task is solvable with only the tables unlocked by then, that every answer is unique,
and that the last task isolates the culprit. It does **not** replace having someone who does not know the answers
play each case.

## Running the tests

```bash
npm run lint
npx tsc --noEmit
npm test                       # builds, starts the app on :3101, runs every suite against the DEV database
node tests/run.mjs --no-build tests/stage3.test.mjs     # one suite, reusing the existing build
npm run check:leaks            # builds and scans the client bundle for secrets
npm run check:leaks:selftest
```

Suites (all create and clean up their own throwaway cases/teams): join and sessions, state machine, SQL
console gating and adversarial SQL, culprit and leaderboard, realtime, admin and pause, resolution/evidence
data, a 36-client load test, an adversarial security suite, a 10-case concurrent event rehearsal, and real-browser
E2E.

### E2E (browser) tests

`tests/ui.e2e.test.mjs` drives system Chrome/Edge through `playwright-core` (no browser download): three
browsers play a whole case, a phone-sized run, and the admin dashboard. Screenshots are written to the OS temp
directory (`slc-ui-shots`), never into the repo. Set `CHROME_PATH` if Chrome is not in a default location.

## Admin access

`/admin`, password = `ADMIN_PASSWORD`. Login is rate limited and the session is a separate, audience-bound
cookie. See [EVENT_RUNBOOK.md](EVENT_RUNBOOK.md).

## Event day

Follow [EVENT_RUNBOOK.md](EVENT_RUNBOOK.md) step by step.

## Deployment (Vercel)

Nothing in this repo deploys automatically. When you are ready:

1. Create the **event** Supabase project (separate from dev). Note its direct and pooled connection strings.
2. From your machine, with the event project's **direct** `DATABASE_URL` exported in the shell (not in `.env.local`):
   `npm run db:migrate`, `node scripts/setup-player-role.mjs` (prints no secrets; copy the value it writes for
   `DATABASE_URL_PLAYER`, adjusting host/port to the **pooled** endpoint), `node scripts/seed-cases.mjs`.
3. Import the GitHub repo into Vercel (framework preset: Next.js; build command `npm run build`).
4. Set these environment variables in Vercel (Production): `DATABASE_URL` (pooled, port 6543),
   `DATABASE_URL_PLAYER` (pooled, user `player_exec.<project-ref>`), `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`
   (new random 48+ chars), `ADMIN_PASSWORD` (new), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `JOIN_RATE_PER_MINUTE`, `JOIN_RATE_PER_HOUR`.
5. Deploy, then run the "before the event" checks in the runbook against the deployed URL.

Both `DATABASE_URL` and `DATABASE_URL_PLAYER` must be the **pooled** (port 6543) URLs on Vercel. Run `npm run check:env`
first: it verifies both URLs and replays the exact player query path (read-only tx, `SET LOCAL`, cursor, RLS gate)
through the pooler without printing any secret. The full test suite has been run against the transaction pooler.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Console shows "The evidence database could not be reached" on Vercel but the rest works | `DATABASE_URL_PLAYER` is the **direct** host (IPv6-only; Vercel cannot reach it). Run `node scripts/setup-player-role.mjs --pooled`, copy the new `DATABASE_URL_PLAYER` into Vercel, redeploy, and confirm with `npm run check:env` |
| "Query console is unavailable" | `DATABASE_URL_PLAYER` missing in the environment; run `setup-player-role.mjs` or set it in Vercel |
| Everyone gets "Too many attempts" when joining | The venue shares one IP; raise `JOIN_RATE_PER_MINUTE` / `JOIN_RATE_PER_HOUR` |
| A team's console shows "That query took too long" | Statement timeout (3 s) working as designed; check Admin > Inspect for the pattern |
| UI shows "Reconnecting…" | The browser cannot reach `/api/state`; it recovers by itself when the network returns |
| Realtime never goes "Live" | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` not set (polling still works) |
| A case cannot be joined | It is still `draft`: run `gen-case-credentials.mjs <id> --live` |
| `npm test` fails right after a restart | Make sure nothing else uses port 3101; dev DB must be reachable |

## Post-event cleanup

Export the leaderboard first (Admin > Export CSV), then `node scripts/discard-query-logs.mjs` (dry run) and
`--yes` to delete `query_logs` and `join_attempts`.

## Project rules

[CLAUDE.md](CLAUDE.md) holds the hard security and workflow rules (never run player SQL with a privileged role,
secrets stay server-side, exact-match grading only, etc.). Read it before changing anything in `lib/`, `app/api/`
or `supabase/`.
