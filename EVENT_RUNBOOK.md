# Event runbook: Sherlock's Last Case (v5)

Print this. Work top to bottom. Tick each box.

Roles: **Lead organizer** (Admin dashboard open all day) and **Floor helpers** (hand out credentials, help teams).
Admin URL: `<site>/admin`. Public boards for the projector: `<site>/leaderboard` (SQL track tab and Logic track tab, or
`/leaderboard?track=LOGIC`).

Every credential below is shown **once** by a script or by the admin screen. Do not put them in chat, email or a shared doc.

---

## BEFORE THE EVENT (day before, then again one hour before doors)

### 1. Database and environment
- [ ] Event Supabase project exists and is **not** the dev project. A backup / point-in-time marker was taken.
- [ ] Migrations applied: `npm run db:migrate` prints `skip` for 001..009 (or applies them). See `docs/DATABASE_MIGRATION.md`.
- [ ] `player_exec` role exists and `DATABASE_URL_PLAYER` is set in Vercel (`node scripts/setup-player-role.mjs --pooled` if not).
- [ ] Vercel environment variables set (README, "Deployment"): `DATABASE_URL` (pooled), `DATABASE_URL_PLAYER`,
      `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`JOIN_RATE_PER_MINUTE` and `JOIN_RATE_PER_HOUR` raised** (suggest 200 and 1500; the
      whole venue may share one public IP).
- [ ] `npm run check:env` (with the event values) prints `environment looks good`: both database URLs are the pooled port-6543 ones.
- [ ] `SESSION_SECRET` and `ADMIN_PASSWORD` differ from the dev values and are in the organizers' password manager.

### 2. Cases and credentials
- [ ] `SLC_ALLOW_REMOTE_DB=1 node scripts/seed-cases.mjs` against the event database: all 12 lines end with `review` (publish only after human review and blind playtest are recorded).
- [ ] `SLC_ALLOW_REMOTE_DB=1 node scripts/verify-case.mjs` prints `all 12 cases verified`.
- [ ] `SLC_ALLOW_REMOTE_DB=1 node scripts/gen-case-credentials.mjs --all --publish` (or one code at a time). Copy each
      `CODE  password` pair straight onto that case's card. Re-running regenerates and kills the old password.
- [ ] A **human who does not know the answers** has played at least one SQL case and one Logic case end to end (the machine checks
      prove solvability, not that the case is fun or fair). Note solve times; the target is about 15 to 20 minutes.

### 3. Registrations and assignments
- [ ] `/admin` > Registrations: add every team (one per line, `Team name, size`). Size is the number of players the team
      registered (1 to 3); the app refuses extra players beyond it.
- [ ] Assign a case to every registration (Choose a case > Assign). Only `published` cases appear. The assignment is audited
      and can be changed until the team presses Start.
- [ ] Cards prepared, one per team: **registration reference**, **case code** (e.g. `SQL03`), **case password**, site URL.
      The team code is created by the app and read out by the head.
- [ ] Spot check the table: every registration shows its case and track.

### 4. Deployed site checks (on the real URL)
- [ ] Landing page loads; `/admin` signs in with the event `ADMIN_PASSWORD`; `/leaderboard` shows no ids or codes.
- [ ] **Full dry run of one SQL and one Logic case** with two throwaway registrations, two devices each (head + investigator):
      join, lobby shows both online, start, open a thread, reveal a hint (the reward drops), answer, finish all threads, make both
      final-deduction picks (include one wrong pick to see the -2 and the retry), see the resolution, and see the team on the
      right track's leaderboard. This is the only test of the pooled-database path; do not skip it.
- [ ] Logic case: the Evidence Browser searches, filters, sorts and pages; a locked table is not listed until its thread opens.
- [ ] Realtime: the second device updates within about a second (top bar **Live**). **Synced** means the realtime variables are
      missing: the game still works but updates every 3 s.
- [ ] Admin: Pause all -> a player screen shows "INVESTIGATION PAUSED" -> Resume all.
- [ ] Delete the dry-run teams (Admin > Delete) so the boards start empty; the registrations stay.
- [ ] Phones: open the site on one phone; the threads, Evidence Browser and answer boxes must be usable.

### 5. Room
- [ ] Projector shows `/leaderboard` full screen (both tracks if you run both).
- [ ] Wi-Fi tested with ~35 devices; note the venue's single public IP (rate limits above).
- [ ] One spare laptop with the Admin dashboard open and signed in.

---

## DURING THE EVENT

### Start
1. Hand each team its card. The **team head** opens the site, *Create Investigation*, and enters the **registration
   reference**, **case code**, **case password** and a codename.
2. The head reads out the **team code** (big amber text in the lobby). Teammates choose *Join Investigation* with that code.
3. The head presses **Start investigation** (teams of 1 to 3 are fine; nobody has to wait). The clock starts then.

### Monitor (Admin dashboard, refreshes every 3 s)
- **Game status**, **Active / Finished teams**, **Recent errors**, **Average progress**.
- Team table: case code + track, phase, **threads done/total**, **hints used**, **wrong answers**, score, elapsed time,
  **connected players**, status (`playing`, `waiting`, `idle`, `paused`, `finished`).
- `idle` for 10+ minutes: send a helper. A rising **Wrong** or **Errors** count: **Inspect** shows each answer attempt (with hints
  and points), opened hints, final-deduction attempts and recent console queries.

### Common situations
| Situation | Action |
|---|---|
| A browser closed or a computer crashed | Reopen the site. Investigators: *Join Investigation* with the same team code and **same codename**. The head: *Create Investigation* again with the registration credentials (or team code + codename + case password). State is restored exactly. |
| Wrong case given to a team | If it is still in the lobby: Admin > Registrations > Reassign (team follows). If it has started: Admin > **Reset** the team first, then Reassign. Both are audited. |
| Team stuck beyond repair | Admin > **Reset** (wipes progress, hints, score and timer; keeps the team code, players and case) or **Delete** (removes the team; the registration can join again for a fresh team). Other teams are never affected. |
| Venue network or database problem | Admin > **Pause all**: timers freeze and nobody can query, answer or open hints. **Resume all** when fixed. Nothing is lost. |
| One team needs a break | Admin > that team's **Pause** / **Resume**. |
| "Invalid credentials" at the join screen | Check the Registrations table: is the team assigned, is the code *the assigned one*, is the case `published`? The error is deliberately identical for every cause. |
| "Too many attempts" at the join screen | The venue IP hit the join limit. Raise `JOIN_RATE_PER_MINUTE` / `JOIN_RATE_PER_HOUR` in Vercel and redeploy, or wait a minute. |
| "That query took too long" | Working as designed (3 s limit). Players should narrow the query. |
| Lost a case password | `gen-case-credentials.mjs <CODE>`: a new password (teams already inside keep playing; only new joins need it). |

### Finish
- A team finishes when **both** final-deduction parts are right. Wrong guesses cost 2 points and can be retried.
- Winner per track = highest score; ties go to the team that **finished the final deduction first** (server time).

---

## REHEARSAL (anytime, safe)

On a machine with the repo: `npm test` runs everything, including a solo start-to-finish rehearsal of **all 12 cases** and a
35-player load run, on an isolated local database. It touches no real data.

---

## AFTER THE EVENT

1. [ ] **Export results**: Admin > **Export CSV** (all), **SQL CSV**, **Logic CSV**. Save them (no credentials inside).
2. [ ] Screenshot or save the final leaderboards.
3. [ ] Save any per-team details you want (Admin > Inspect) **before** step 5.
4. [ ] Announce results.
5. [ ] Discard query logs: `node scripts/discard-query-logs.mjs` (dry run), then `--yes`. This deletes `query_logs` and `join_attempts`.
6. [ ] Clean test data: Admin > **Delete** any dry-run teams. `node scripts/seed-cases.mjs` resets all cases (and deletes teams
       that played them).
7. [ ] Rotate or revoke: change `ADMIN_PASSWORD`; regenerate case passwords or set cases to `disabled`; consider rotating
       `SESSION_SECRET` and the `player_exec` password (`node scripts/setup-player-role.mjs --rotate`).
8. [ ] Pause or delete the event Supabase project when it is no longer needed.
