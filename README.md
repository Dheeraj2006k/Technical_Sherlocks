# Sherlock's Last Case

> *Every crime leaves a query.*

A competitive, browser-based **detective game** for a one-day Techfest. Teams of one to three investigate one of **twenty
mysteries** on one of two tracks:

* **SQL track** (`SQL01`-`SQL06`): query a live evidence database with SQL.
* **Logic track** (`LOG01`-`LOG06`): browse, search, filter and sort the same kind of evidence in an **Evidence Browser**
  (no SQL needed; an optional SQL console is there from the start for those who want it).

Both tracks run on **one shared engine**: registrations, manual case assignment, investigation threads (required and optional),
shared progressive hints, a 100-point budget, a two-part final deduction, per-track leaderboards and an organizer console.

Built for ~35 computers at once on **Next.js 16 (App Router) + Supabase Postgres**, deployed on Vercel.

## How a game works

1. **Organizers register teams** in `/admin` (Registrations). Each team gets a registration reference.
2. **Organizers assign a case** to each registration (manual, audited, changeable until the team starts).
3. **The team head joins** with *registration reference + the assigned case code + the case password*, then shares the team
   code with up to two teammates (limited by the registered team size).
4. The head **starts** the investigation. Three phases of **investigation threads** open evidence tables as they become
   available. Required threads clear a phase; optional threads add points and detail. Solo players can finish everything.
5. Each **question** is worth 10 points; **hints** are shared by the team and cost nothing by themselves but lower what the
   question pays (10 -> 8 -> 6 -> 4 -> 2). A **wrong answer costs 2 points** (never below zero).
6. After the required threads, the **final deduction** has two parts: who is responsible (12 points) and how it was done
   (8 points, one of four explanations). Wrong guesses cost 2 points and can be retried; the case closes when both are right.
7. Maximum score **100** (8 x 10 + 12 + 8). Each track has its own leaderboard; ties go to whoever finished first.

## Tech stack

Next.js 16 (App Router, TypeScript, Node route handlers) · React 19 · Postgres (Supabase) via `pg` and `pg-cursor` · `jose`
(signed sessions) · `bcryptjs` · Supabase Realtime · plain CSS design system · `node:test` + `playwright-core` for tests ·
`embedded-postgres` for the isolated local test database.

## Local setup (isolated, no Supabase needed)

Requirements: Node 20+ (tested on 22), npm, Chrome or Edge for the browser tests.

```bash
npm install
npm test                  # builds, starts an embedded LOCAL Postgres + the app on :3101, runs every suite
npm run dev:local         # keeps the local Postgres running (env file: .env.localdb), then in another shell:
SLC_ENV_FILE=.env.localdb npm run dev      # http://localhost:3000   (admin password: see .env.localdb)
node scripts/local-db.mjs setup            # migrate + create player_exec + seed the 12 case packs into the local DB
node scripts/local-db.mjs reset            # wipe the local database
```

`.env.localdb` and `.local-pg/` are generated, git-ignored and contain only throwaway local values. Nothing in the local flow
can reach a remote database.

### Working against a real (development) Supabase project

```bash
cp .env.example .env.local        # fill in the values (see below). Never commit .env.local
npm run db:migrate                # applies supabase/migrations/*.sql in order
node scripts/setup-player-role.mjs        # creates the low-privilege player_exec login, writes DATABASE_URL_PLAYER
SLC_ALLOW_REMOTE_DB=1 node scripts/seed-cases.mjs     # installs + validates the 12 case packs (status: review; nothing is published until a human review and blind playtest are recorded)
SLC_ALLOW_REMOTE_DB=1 node scripts/gen-case-credentials.mjs --all --publish   # case passwords, shown once
npm run dev
```

The seed, verify and credential scripts and the test runner **refuse a remote database** unless `SLC_ALLOW_REMOTE_DB=1`,
because they delete and replace data and the "development" project may be the one the live site uses.

### Environment variables

Names only; values live in `.env.local` (git-ignored) locally and in Vercel's environment settings in production.

| Variable | Server/Public | Purpose |
|---|---|---|
| `DATABASE_URL` | server | Postgres connection (use the **transaction-mode pooler** URL in production) |
| `DATABASE_URL_PLAYER` | server | Same database, user `player_exec`; the only connection that runs player SQL and Evidence Browser queries |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Used **only** to publish realtime pings. Never runs player SQL |
| `SESSION_SECRET` | server | Signs player/admin session cookies and hashes IPs |
| `ADMIN_PASSWORD` | server | Organizer login |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public (by design) | Browser realtime subscription. Optional: without them the UI polls every 3 s |
| `JOIN_RATE_PER_MINUTE`, `JOIN_RATE_PER_HOUR` | server | Per-IP join attempt limits (defaults 10 and 30). **Raise for the event**: a venue often shares one public IP |
| `SLC_ENV_FILE` | tooling | Which env file scripts read (default `.env.local`; `.env.localdb` for the local database) |
| `SLC_ALLOW_REMOTE_DB` | tooling | Set to `1` to let seed / verify / credential / test tooling touch a remote database |

## Database

Migrations are plain SQL in [supabase/migrations](supabase/migrations), applied in filename order by `scripts/migrate.mjs`
(tracked in `schema_migrations`, one transaction per file):

| File | Adds |
|---|---|
| 001-008 | The v4 game: core schema, names and codes, state machine, hardening and RLS, per-phase query keys, culprit and pause, realtime token, presence and resolution text |
| 009 | **v5 engine**: case registry fields, registrations and assignments, audit log, investigation threads, hints, attempts and completions, two-part final deduction, story events, per-table evidence keys |

See [docs/DATABASE_MIGRATION.md](docs/DATABASE_MIGRATION.md) for the upgrade path and rollback.

Evidence tables for each case live in their own schema `case_<slug>`. Every table has its **own secret key** (`case_table_keys`);
its row-level-security policy holds only the SHA-256 of that key. For each request the server sets `app.keys` to the keys of the
tables that team has unlocked, inside a read-only transaction as the `player_exec` role. The SQL console and the Evidence
Browser both run through this single gate, so they can never disagree about what is unlocked. A player can see the keys of
tables they have unlocked (they are in their own session) but cannot derive or forge any other.

## Cases

Twenty definitions in [scripts/cases](scripts/cases):

* `cases/`: the twelve supplied case packs (SQL01-SQL06, LOG01-LOG06), one folder per case (see `docs/case-authoring-standard.md` and `docs/case-roster.md`). The former generated cases survive only as test fixtures in `tests/fixtures/legacy/`.

```bash
node scripts/seed-cases.mjs                      # install + validate the 12 case packs (they land in 'review')
node scripts/seed-cases.mjs --only LOG04
node scripts/verify-case.mjs                     # validate without keeping anything
node scripts/gen-case-credentials.mjs SQL03      # new password for one case, printed once   (--all, --publish)
```

The validator proves, per case: the score budget is exactly 100; every question has four hints; every phase has a required
thread; prerequisites are acyclic and a required thread never depends on an optional one (so a solo player cannot get stuck);
each question's reference query returns exactly its answer using only tables unlocked by then; the last question isolates the
culprit; the final deduction has exactly one correct explanation; every evidence table is unlocked by something and has its
own gate key. It does **not** replace having someone who does not know the answers play each case. See
[docs/ASSUMPTIONS_AND_DECISIONS.md](docs/ASSUMPTIONS_AND_DECISIONS.md) for the honest content limits.

## Running the tests

```bash
npm run lint
npx tsc --noEmit
npm test                       # isolated LOCAL database: build, start, run every suite (about 10 minutes)
node tests/run-local.mjs --no-build tests/v5_engine.test.mjs     # one suite, reusing the existing build
npm run test:remote            # DEVELOPMENT Supabase only, deliberately (also runs the realtime suite)
npm run check:leaks            # builds and scans the client bundle for secrets
npm run check:leaks:selftest
```

| Suite | Covers |
|---|---|
| `v5_join` | registration join, generic 401s, one team per registration, team-size caps, rejoin |
| `v5_engine` | scoring, hints, penalties, idempotency, concurrency, threads, final deduction, assignment, pause |
| `v5_evidence` | console and Evidence Browser gating, per-table keys, injection, limits, thread-level unlocks |
| `v5_security` | forged sessions, admin auth, leakage scans, mass assignment, RLS and grants, leaderboard exposure |
| `v5_admin` | registrations, assignment, audit, reset, pause, dashboard, per-track leaderboard and export |
| `v5_cases` | validator on all 12 cases, mutation tests of the validator, a solo start-to-finish rehearsal of every case |
| `v5_load` | 35 players on 12 teams (both tracks) at once |
| `v5_recovery`, `v5_migration`, `v5_grading` | crash recovery, v4 -> v5 upgrade, answer grading rules |
| `v5_realtime` | realtime pings (skipped locally; needs Supabase) |
| `v5_ui.e2e` | real-browser play-through of both tracks, a phone-sized run, mission control |

### E2E (browser) tests

`tests/v5_ui.e2e.test.mjs` drives system Chrome/Edge through `playwright-core` (no browser download). Screenshots go to the
OS temp directory (`slc-ui-shots-v5`), never into the repo. Set `CHROME_PATH` if Chrome is not in a default location.

## Admin access

`/admin`, password = `ADMIN_PASSWORD`. Login is rate limited and the session is a separate, audience-bound cookie. Organizers
create registrations, assign cases, watch every team (case, track, threads, hints, wrong answers, connected players), pause or
reset teams (audited), and export results per track. See [EVENT_RUNBOOK.md](EVENT_RUNBOOK.md).

## Event day

Follow [EVENT_RUNBOOK.md](EVENT_RUNBOOK.md) step by step.

## Deployment (Vercel)

Nothing in this repo deploys automatically. When you are ready:

1. Create the **event** Supabase project (separate from dev). Note its direct and pooled connection strings.
2. From your machine, with the event project's **direct** `DATABASE_URL` exported in the shell (not in `.env.local`):
   `npm run db:migrate`, `node scripts/setup-player-role.mjs --pooled`, then the seed and credential steps in
   [docs/DATABASE_MIGRATION.md](docs/DATABASE_MIGRATION.md).
3. Import the GitHub repo into Vercel (framework preset: Next.js; build command `npm run build`).
4. Set these environment variables in Vercel (Production): `DATABASE_URL` (pooled, port 6543), `DATABASE_URL_PLAYER`
   (pooled, user `player_exec.<project-ref>`), `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET` (new random 48+ chars),
   `ADMIN_PASSWORD` (new), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `JOIN_RATE_PER_MINUTE`,
   `JOIN_RATE_PER_HOUR`.
5. Deploy, then run the "before the event" checks in the runbook against the deployed URL.

Both `DATABASE_URL` and `DATABASE_URL_PLAYER` must be the **pooled** (port 6543) URLs on Vercel. Run `npm run check:env` first:
it verifies both URLs and replays the exact player query path (read-only tx, `SET LOCAL`, cursor, RLS gate) through the pooler
without printing any secret.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Console or Evidence Browser says the database "could not be reached" on Vercel but the rest works | `DATABASE_URL_PLAYER` is the **direct** host (IPv6-only; Vercel cannot reach it). Run `node scripts/setup-player-role.mjs --pooled`, copy the new value into Vercel, redeploy, confirm with `npm run check:env` |
| "Query console is unavailable" | `DATABASE_URL_PLAYER` missing in the environment |
| A head gets "Invalid credentials" | One of: wrong registration reference, the registration has no assigned case, the case code is not *the assigned one*, wrong password, or the case is not `published`. The message is deliberately identical for all of them; check the Registrations table in `/admin` |
| Everyone gets "Too many attempts" when joining | The venue shares one IP; raise `JOIN_RATE_PER_MINUTE` / `JOIN_RATE_PER_HOUR` |
| A case cannot be assigned | It is not `published`: `gen-case-credentials.mjs <CODE> --publish` (only validated cases) |
| A team is stuck | Admin > Inspect shows attempts, hints and query activity; Reset restores the lobby, Delete frees the registration |
| UI shows "Reconnecting…" | The browser cannot reach `/api/state`; it recovers by itself when the network returns |
| Realtime never goes "Live" | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` not set (polling still works) |
| `npm test` stops at "undefined" | A stray local Postgres is holding port 54329: `node scripts/local-db.mjs reset` or end the `postgres.exe` process |

## Post-event cleanup

Export the results first (Admin > Export CSV), then `node scripts/discard-query-logs.mjs` (dry run) and `--yes` to delete
`query_logs` and `join_attempts`.

## Project rules

[CLAUDE.md](CLAUDE.md) holds the hard security and workflow rules (never run player SQL with a privileged role, secrets stay
server-side, exact-match grading only, etc.). Read it before changing anything in `lib/`, `app/api/` or `supabase/`.

Further reading: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) ·
[docs/PRD_V5_GAP_ANALYSIS.md](docs/PRD_V5_GAP_ANALYSIS.md) · [docs/ASSUMPTIONS_AND_DECISIONS.md](docs/ASSUMPTIONS_AND_DECISIONS.md)
· [docs/DATABASE_MIGRATION.md](docs/DATABASE_MIGRATION.md).
