# Implementation status: PRD v5

Verified on an isolated local Postgres (`npm test`). **Nothing was run against the real Supabase database, Vercel or GitHub.**
Legend: DONE (implemented and covered by an automated test) · PARTIAL · NOT DONE · UNVERIFIED.

## Verification results (last full run)

| Check | Result |
|---|---|
| `npx eslint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run build` | passes |
| `npm run check:leaks` (+ self-test) | passes, no secrets in the client bundle |
| `npm test` (local DB) | **150 tests: 145 pass, 0 fail, 5 skipped** (the 5 realtime tests need Supabase). After that run, 8 more tests were added (misc/operator scripts, registration import); those suites were run individually and pass |
| Load (`v5_load`) | 35 players on 12 teams, both tracks, all finish; p50 about 0.3 s, p95 about 1.7 s on the local database |
| Browser E2E (`v5_ui.e2e`) | 4/4, repeated twice for flakiness |

## Requirement status

| PRD area | Status | Evidence / note |
|---|---|---|
| Two tracks on one engine (SQL01-06, LOG01-06) | DONE | `game_track`; 12 case packs validated (scope decision 2026-10-15) |
| Registrations, manual assignment, audit | DONE | `v5_admin`, `v5_join`; import with or without your own references |
| Head join with registration + assigned case code + password; generic 401; one team per registration | DONE | `v5_join`, `v5_security` |
| Team size cap from the registration, rejoin, recovery | DONE | `v5_join`, `v5_recovery` |
| Threads (required/optional, prerequisites, outcomes, story events, thread-level unlocks, solo-completable) | DONE | `v5_engine`, `v5_evidence`, validator, solo rehearsal of all 12 cases |
| Questions: attempts vs completions, idempotency, 10/8/6/4/2 hints, -2 floor 0, exact 100 | DONE | `v5_engine`, `v5_cases` |
| Two-part final deduction (responsibility + 4 options), retries, finish on both | DONE | `v5_engine`, E2E |
| Evidence Browser (search/filter/sort/paginate, allow-listed, parameterised) | DONE | `v5_evidence`, E2E |
| One unlock gate for console and browser (per-table RLS keys); catalog denylist | DONE, with a documented limit | catalog names of locked tables remain visible to a determined player (ASSUMPTIONS 25) |
| Per-track leaderboards, tie-break by final completion | DONE | `v5_admin` |
| Admin: registrations, assign, monitor threads/hints/wrong/connected, reset (audited), pause, export per track | DONE | `v5_admin`, E2E |
| Realtime + recovery | PARTIAL | polling and recovery tested locally; Supabase Realtime tests are written but **not run** |
| 20 validated cases | PARTIAL | machine-valid; **not** individually authored, no distinct central trick per case, SQL casts are not Indian-named, small dossiers (ASSUMPTIONS 20-24) |
| Blind human playtest, measured solve times | NOT DONE | needs real players |
| Mobile | DONE for layout | 390 px run, no horizontal overflow; not tested on real devices |
| Production migration, deploy, `check:env` against the pooler, realtime against Supabase | NOT DONE / UNVERIFIED | needs organizer approval; see DATABASE_MIGRATION.md |

## v4 test coverage mapping
The v4 suites (`stage1`-`stage8_9`, `adversarial`, `hardening`, `experience`, `load`, `ui.e2e`) tested endpoints and rules that no
longer exist (single culprit shot, direct case-code join, 20/20/20/40 scoring). They were removed from the working tree (they remain
in git history) and their scenarios re-expressed: join/rate limits/timing -> `v5_join`, `v5_security`; state machine -> `v5_engine`;
console gating and adversarial SQL -> `v5_evidence`; culprit/leaderboard -> `v5_engine`, `v5_admin`; realtime -> `v5_realtime`;
admin/pause/reset/export/recovery -> `v5_admin`, `v5_recovery`; presence/cleanup -> `v5_misc`; 10-case rehearsal + load ->
`v5_cases`, `v5_load`; browser -> `v5_ui.e2e`.

## Needs a human before the event
1. Approve and run the production migration and seed (DATABASE_MIGRATION.md).
2. Have someone who does not know the answers play several cases; fix content.
3. Run the realtime suite and `check:env` against the event Supabase project.
4. Decide whether to hand-author distinct central tricks and larger dossiers.


## Update: case packs, versions, onboarding, story

Done and verified locally: twelve case packs validated (structural + database), version pinning and lifecycle, idempotent seeding, CHOICE answers, SQL Field Guide, guided tour, Help menu, prominent story (banner + Case File), admin case catalogue, function lockdown, leak scan of private pack text. Lint 0 errors, type check, build and the full test suite (unit, integration, E2E) pass; realtime tests are skipped locally.

Not done: production audit, migration, seeding and deployment (blocked by permission controls); human review and blind playtest of every case (required before `tested`/`published`); Vercel production branch verification.

PRD addendum (help and onboarding) requirements, case packs, lifecycle, seeding and story visibility: Done. Human review and playtest, production migration, deploy and smoke: Open.
