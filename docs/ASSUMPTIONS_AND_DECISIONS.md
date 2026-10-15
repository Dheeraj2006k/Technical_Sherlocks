# Assumptions and decisions (PRD v5 implementation)

## SCOPE DECISION (2026-10-15): the active catalogue is the twelve supplied case packs

The PRD v5 PDF (`docs/PRD__Sherlocks_Last_Case-_v5.pdf`, unchanged) and the first addendum describe a 10-case roster (SQL01-05, LOG01-05; earlier drafts 20 generated cases, SQL01-10 and LOG01-10). The owner then instructed, later and explicitly, to use the exact cases supplied in `docs/*.zip`. That later instruction supersedes the earlier rosters. **The authoritative catalogue is SQL01-SQL06 and LOG01-LOG06 (12 cases), `content_version` 2, all in `review`.** Everywhere else in this file, "ten", "20" and SQL07-10 / LOG07-10 are historical: they describe the earlier generated implementation, which now exists only as test fixtures (`tests/fixtures/legacy/`) and is retired with `scripts/retire-legacy-cases.mjs` (disable only). The supplied storylines, characters, evidence, tasks, hints and answers are preserved; the fairness corrections are listed under "Decisions from the case-pack work" below.

Every item here is a judgment call made while implementing PRD v5 where the PRD was silent, ambiguous or truncated. Change
any of them by editing the code and this file. The PRD text available to the implementation was the PDF plus a master prompt
truncated at 50,000 characters; where the truncated part may have said something different, that is noted.

## Environment and safety

1. **Isolated local database.** All development and the whole automated suite run against an embedded local Postgres
   (`npm test`, `npm run dev:local`). The suites create and delete teams and cases, and the Supabase database that
   `.env.local` points at may be the one the live Vercel site uses, so `tests/run.mjs` **refuses to run against a remote
   database** unless `SLC_ALLOW_REMOTE_DB=1`. `scripts/seed-cases.mjs`, `scripts/verify-case.mjs` and
   `scripts/gen-case-credentials.mjs` refuse a remote database the same way. No migration, seed, reset or test has been run
   against the remote database during the v5 work.
2. **Production migration is a deliberate, separate step.** Migration `009_v5_engine.sql` is additive (see
   [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md)) and is tested from an empty database and from a v4 schema populated with
   v4-style data (`tests/v5_migration.test.mjs`), but it has NOT been applied remotely. It changes the join flow
   (registrations become mandatory) and replaces the case content, so run it before the event, never during one.
3. No commit, push, deploy, Vercel change or remote-database write was made as part of this work.

## Product decisions

4. **Case codes.** `cases.case_code` is the catalogue code `SQL01..SQL10` / `LOG01..LOG10` (constraint
   `^[A-Z0-9][A-Z0-9-]{2,15}$`). The ten existing generated SQL cases become SQL01-SQL10 (Opening Night = SQL01). The PRD marks
   titles as working titles, so titles were kept. Case codes are **not secrets**; the case password is. Case codes are no
   longer shown on the public leaderboard.
5. **Registration reference is the credential.** A registration has an 8-character random reference (Crockford alphabet,
   ~40 bits) that is both its unique id for organizers and the head's join credential. It is stored in plain text so the
   organizer can look it up and re-issue it from the admin screen; it is **not** a password hash. A head still needs the case
   code and the case password, so guessing the reference alone gets an attacker nothing, and join attempts are rate limited per
   IP (10 per minute, 30 per hour). If the truncated part of the PRD required hashed registration credentials, this is a gap.
6. **Score budget per case, auditable.** 8 questions x 10 points (80) + responsibility 12 + explanation 8 = **100**. The
   final-deduction values live on the case (`final_points_culprit`, `final_points_mechanism`), the per-question values live on
   the question (`base_points`, `reward_schedule`), and the validator enforces that every case sums to exactly 100. Every
   question has the same reward schedule 10/8/6/4/2 because the PRD's hint schedule is stated that way; it is stored per
   question so a case could deviate.
7. **Penalties.** A wrong answer, in a question or in the final deduction, takes 2 points from the team total at once and never
   below zero. What was actually removed is recorded on the attempt (a team at zero loses nothing) and in the `penalties`
   score component. SQL errors and Evidence Browser requests are free.
8. **Hints** are shared by the team, opened in order, and cost nothing by themselves: they reduce what the *question* is
   worth (10, 8, 6, 4, 2). Opening a hint is idempotent per position, so two teammates pressing "reveal hint 2" together pay
   once. A hint cannot be opened for a question that is already answered.
9. **Thread completion and progression.** A thread completes when all its questions are answered; a phase advances when all
   its *required* threads are complete. Optional threads never block progression and stay open (and can still add points)
   afterwards, including during the final deduction. A thread can have a prerequisite thread; a required thread must never
   depend on an optional one (the validator enforces it so a solo player cannot be trapped).
10. **Evidence unlocks.** Evidence is unlocked per table: tables listed on a phase open when the phase is reached; tables
    attached to a thread open when the thread becomes *available* (phase reached and prerequisite complete) or when it is
    *completed*. One enforcement path (database row-level security keyed per table) serves both the SQL console and the
    Evidence Browser, so they cannot disagree.
11. **Logic track SQL.** The optional SQL console is available from the start of a Logic case and uses the same per-table
    unlock keys, so it cannot reveal more than the Evidence Browser.
12. **Tie-break.** Within a track, order is: total points, then earliest completion of the final deduction (the time the second
    component was resolved, stored as `teams.finished_at`), then the latest of the resolved components for unfinished teams,
    then earliest start. Teams on different tracks never share a leaderboard.
13. **Admin actor.** The deployment has one shared organizer password, so every audited action carries the fixed actor label
    `organizer`. Per-person attribution would need per-person credentials; that was not built.
14. **Clock.** The team clock starts when the head presses Start (previously: when the team was created). Pausing stops it and
    nothing is lost.
15. **Case reassignment.** Allowed until the team starts investigating (a team still in the lobby follows its new case). After
    that the organizer must reset the team first. Both actions are audited. Several teams may share one case (the PRD does not
    forbid it); the assignment screen shows how many active assignments each case has.
16. **Withdrawn / eligible registrations.** `withdrawn` registrations cannot join or be assigned. `eligible` is accepted as
    equivalent to `registered`; the PRD's truncated text may define more states.
17. **Final-deduction options.** Four options per case (the PRD allows 3-4), written per case from the case's own facts; the
    position of the correct option varies between cases. The *responsibility* component is a pick from the case roster.
18. **Final-deduction guesses are rate limited per team** (10 per minute): a wrong guess costs points, but a team already at
    zero must not be able to brute force four options for free.
19. **Question ids are the only handle a client has.** Hints, answers and options are looked up server-side by the session's
    case, never by anything the client says about phase, team or case.

## Content decisions (honest limits)

20. **The 20 cases are generated, not individually authored.** SQL01-SQL10 come from one puzzle skeleton ("restricted area, custody
    log, messages") with ten themes and seeds; LOG01-LOG10 come from a second skeleton ("the alibi grid") with ten themes. Their
    data, times, codes and answers differ per case and every answer is machine-verified for uniqueness, but the *kind of
    puzzle* repeats inside a track. PRD 6.4 asks for a distinct central detective trick per case: **that is not achieved**, and
    needs human authoring. No blind human playtest was possible, so solve times (the 15-20 minute target) are **unmeasured**.
21. **Names.** The ten Logic casts use Indian names and settings. The ten SQL casts keep their original international casts
    (Opening Night, Midnight Gala, Aurora, ...); re-casting them with Indian names would change every answer string and was left
    as editorial work.
22. **Dossier size.** SQL cases have 4 tables: the door/access log has 48-57 rows and the other three have 14-17 rows each.
    Logic cases have 5 tables: the sightings log has 35-36 rows and the other four have 11-16 rows each. The PRD's "30-100+ rows
    per dossier" is therefore met only by each case's largest table; the people list, statements, handling log and message
    tables are small. This is the generator's size, not a database limit, and is the most visible content shortfall.
23. **Hints are derived from each question's own reference query** (which table, the technique, which columns, the shape of a
    working query). They are specific to the question but templated, not hand-written; Logic hints end with browsing
    instructions instead of SQL.
24. **Distractor explanations** in the final deduction are templated variations around the case's real people and item. They
    are plausible but formulaic.

## Known technical limits (documented, not hidden)

25. **Catalog visibility.** PostgreSQL cannot hide `pg_catalog` / `information_schema` rows per team, so the *names* of locked
    evidence tables and columns are visible to anyone who can run catalog queries. Row access is blocked in the database
    (per-table keys), and the app refuses the obvious catalog routes (`pg_*`, `information_schema`, `to_reg*`, ...), but this
    is a usability layer, not a hard boundary. Table names are therefore chosen not to spoil anything.
26. **Realtime tests need Supabase.** The realtime suite (`tests/v5_realtime.test.mjs`) is skipped on the local database and
    must be run with `npm run test:remote` against a configured environment (see EVENT_RUNBOOK.md). Polling is the proven
    fallback and is tested locally.
27. **v4 games in flight cannot continue after the migration.** v4 questions have no threads. Upgrade between events (see
    DATABASE_MIGRATION.md).


## Decisions from the case-pack work

- **Twelve cases, not ten.** The owner supplied twelve cases in `docs/*.zip` and asked for exactly those; this supersedes the earlier "exactly ten" rule and my authored cases. Catalogue = SQL01-06, LOG01-06, `content_version` 2.
- **Scores.** Every case totals 100 but follows its source: SQL01-06 and LOG03-06 use 6 x 10 + 25 + 15; LOG01/02 have nine questions (45) with final components 35 + 20 and a scaled five-step reward ladder. Wrong committed answers cost 2.
- **Answers.** Multiple-choice sources use CHOICE; typed sources use NUMBER/TIME/TEXT with `alt_answers` (e.g. SQL01 name lists in any order and separator).
- **Edits to supplied data** (recorded because they change supplied content):
  - SQL01 and SQL06 `staff_directory.known_context` stated conclusions in a table players can read; made neutral.
  - SQL01: rear-door camera event C9 moved from displayed 21:40 to 21:36 (real 21:32) so corrected controller and camera times align, as the author notes request.
  - SQL06: the RESTRICTED_AUTHOR private draft is not loaded into the player schema; PAY-712 and its ledger entry are credited to Asha Rao, matching the audit log, staff notes and answer key (the seed said Dev).
  - SQL03: one wrong explanation option was lengthened to pass the minimum-length check.
  - Timestamps are stored as IST wall-clock `timestamp` values.
- **Small datasets** (SQL02-06 have 25-45 evidence rows) are a content gap the source authors noted; not padded.
- **No human review or playtest is claimed.** All twelve are `review` with `publication_eligible: false`; the source packs list their own pending gates.
- **Story visibility.** Hook, briefings and people are in a persistent banner and a Case File dialog, opened first on entering a case; the tour follows. Per-tab sessionStorage plus the player's own tour flag; no game state is touched.
- **Table cap** raised from 16 to 18 evidence tables (SQL01 has 17).
- **Function lockdown** (migration 013): Postgres grants EXECUTE to PUBLIC by default.
