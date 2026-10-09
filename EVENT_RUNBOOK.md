# Event runbook: Sherlock's Last Case

Print this. Work top to bottom. Tick each box.

Roles: **Lead organizer** (Admin dashboard open all day) and **Floor helpers** (distribute credentials, help
teams). Admin URL: `<site>/admin`. Public board for the projector: `<site>/leaderboard`.

---

## BEFORE THE EVENT (day before, then again one hour before doors)

### 1. Database and environment
- [ ] Event Supabase project exists and is **not** the dev project.
- [ ] Migrations applied: `npm run db:migrate` prints `skip` for 001..008 (or applies them).
- [ ] `player_exec` role exists and `DATABASE_URL_PLAYER` is set in Vercel (`node scripts/setup-player-role.mjs` if not).
- [ ] Vercel environment variables set (see README, "Deployment"): `DATABASE_URL` (pooled), `DATABASE_URL_PLAYER`,
      `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`JOIN_RATE_PER_MINUTE` and `JOIN_RATE_PER_HOUR` raised** (suggest 200 and 1500;
      the whole venue may share one public IP).
- [ ] `npm run check:env` (with the event values) prints `environment looks good`: both database URLs are the pooled port-6543 ones.
- [ ] `SESSION_SECRET` and `ADMIN_PASSWORD` are different from the dev values and stored in the organizers' password manager.

### 2. Cases and credentials
- [ ] `node scripts/seed-cases.mjs` run against the event database (all 10 installed, status draft).
- [ ] `node scripts/verify-case.mjs` prints `all 10 cases verified`.
- [ ] For every case you will use: `node scripts/gen-case-credentials.mjs <case-id> --live`. The code and password
      are shown **once**; write them on that case's card immediately. They are not stored anywhere readable.
      Re-running regenerates both and kills the old pair.
- [ ] Cards prepared: one per team, with **case code**, **case password**, the site URL. (Team codes are created by
      the team lead in the app and shared by them.)

### 3. Deployed site checks (on the real URL)
- [ ] Landing page loads; the Admin page `/admin` signs in with the event `ADMIN_PASSWORD`.
- [ ] `/leaderboard` loads without signing in and shows no team codes.
- [ ] **Full dry run of one complete case** on two different devices (lead + investigator): join, lobby shows both
      players online, start, run a query, solve all 9 tasks, final deduction, correct accusation shows the
      resolution, the team appears on `/leaderboard`. This is the only test of the pooled-database path; do not skip it.
- [ ] Realtime: the second device updates within about a second (top bar shows **Live**). If it shows **Synced**,
      realtime variables are missing: the game still works but updates every 3 s.
- [ ] In Admin: Pause all -> a player screen shows "INVESTIGATION PAUSED" -> Resume all.
- [ ] Reset the dry-run team (Admin > Reset) or Delete it, so the board starts empty.
- [ ] Phones: open the site on one phone; the SQL console must be usable.

### 4. Room
- [ ] Projector shows `/leaderboard` full screen.
- [ ] Wi-Fi tested with ~35 devices; note the venue's single public IP situation (see rate limits above).
- [ ] One spare laptop with the Admin dashboard open and signed in.

---

## DURING THE EVENT

### Start
1. Hand each team its card. The **team lead** goes to *Create Investigation*, enters the case code, password and a codename.
2. The lead reads out the **team code** (big amber text in the lobby). Teammates choose *Join Investigation*.
3. The lead presses **Start investigation** (teams of 1 to 3 are fine; no need to wait for everyone).

### Monitor (Admin dashboard, refreshes every 3 s)
- **Game status** tile: Running / PAUSED. **Active teams / Finished teams / Recent errors / Average progress**.
- Team table: case, phase, score, elapsed time, status (`playing`, `waiting`, `idle`, `paused`, `finished`).
- `idle` for 10+ minutes: send a helper to the team.
- A team with a rising **Errors** count: click **Inspect** to see their recent queries (ok, sql, timeout, permission,
  unknown_table), row counts and timings, and every answer they submitted.

### Common situations
| Situation | Action |
|---|---|
| A browser closed or a computer crashed | Reopen the site, **Join Investigation**, same team code and **same codename**. The team lead must also type the **case password** (field under the codename). State is restored exactly. |
| Team abandoned or stuck beyond repair | Admin > **Reset** (wipes progress, score and timer; keeps the team code and players) or **Delete** (removes the team entirely). Other teams are never affected. |
| Venue network or database problem | Admin > **Pause all**: timers freeze and nobody can query or submit. **Resume all** when fixed. Nothing is lost. |
| One team needs a break | Admin > that team's **Pause** / **Resume**. |
| "Too many attempts" at the join screen | The venue IP hit the join limit. Raise `JOIN_RATE_PER_MINUTE` / `JOIN_RATE_PER_HOUR` in Vercel and redeploy, or wait a minute. |
| "That query took too long" | Working as designed (3 s limit). Players should narrow the query. |
| Someone lost the case code/password | Run `node scripts/gen-case-credentials.mjs <case-id> --live` (new pair; teams already inside keep playing, only new joins need the new pair). |

### Finish
- A team finishes the moment it submits its accusation. The projector board reorders live.
- Winner = highest score; ties go to the **earliest correct** accusation (server time).

---

## AFTER THE EVENT

1. [ ] **Export the leaderboard**: Admin > **Export CSV**. Save it somewhere safe (contains no credentials).
2. [ ] Screenshot or save the final `/leaderboard`.
3. [ ] Save any per-team details you want (Admin > Inspect) **before** step 5.
4. [ ] Announce results.
5. [ ] Discard query logs: `node scripts/discard-query-logs.mjs` (dry run, shows counts), then
       `node scripts/discard-query-logs.mjs --yes`. This deletes `query_logs` and `join_attempts`.
6. [ ] Clean test data: Admin > **Delete** any dry-run/test teams. Optionally re-run `node scripts/seed-cases.mjs`
       to reset all cases (this also deletes any teams that played them).
7. [ ] Rotate or revoke: change `ADMIN_PASSWORD`, regenerate case credentials (or set cases back to `draft` by
       re-seeding), and consider rotating `SESSION_SECRET` and the `player_exec` password
       (`node scripts/setup-player-role.mjs --rotate`).
8. [ ] Pause or delete the event Supabase project when it is no longer needed.
