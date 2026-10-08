# Sherlock's Last Case

Browser-based SQL detective game for a one-day techfest. Next.js (App Router, TypeScript) on Vercel + Supabase Postgres. Full spec: docs/PRD.pdf (build roadmap is at the end of it).

## Hard rules (never break)
- NEVER use the Supabase service-role key or any RLS-bypassing role to run player SQL in /api/query.
- team_id, role, case_id are derived ONLY from the signed server session, never from client input.
- current_phase and all scoring are server-owned. Scoring, phase-clear and state transition happen in ONE transaction. Scoring endpoints must be idempotent.
- Secrets (DATABASE_URL, service key, SESSION_SECRET, ADMIN_PASSWORD) are server-side only. Never NEXT_PUBLIC_, never committed, never logged.
- No AI or fuzzy grading anywhere. Exact-match grading only.
- Use SET LOCAL (never plain SET) because we use the transaction-mode pooler.
- Only the dev Supabase project is used locally. Event-day credentials live only in Vercel env.

## Workflow
- Work ONE build stage at a time, on branch stage-N-name. Plan first, then build.
- A stage is done only when every test listed for it in the roadmap passes. Write those as automated tests where possible.
- Do not start the next stage. Report what passed, what failed, and anything in the PRD that seems wrong.
- If the PRD is ambiguous or contradictory, stop and ask. Do not guess.

## PRD amendments (override the PDF)
- Join requires display_name. If that name already exists in the team (case-insensitive: "Bob" = "bob"), treat as rejoin and re-issue the token (via team_code + name).
- Head rejoin ALSO requires the case password (team_code + name + case_password). Investigator rejoin never does.
- Code formats (Crockford base32, alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ, generated with crypto.randomInt): case_code = 8 chars shown XXXX-XXXX (UNIQUE, on cases); team_code = 6 chars shown XXX-XXX (UNIQUE, stored without the hyphen, retry on collision). Input is normalized (uppercase, strip spaces/hyphens, O->0, I/L->1) and validated for length+alphabet before any DB lookup. The head joins with case_code + case_password; only cases with status='live' are joinable.
- Join failures are generic: wrong/malformed code, wrong password and non-live case all return the same 401 body ("Invalid credentials") with a dummy bcrypt compare to keep timing similar. (A valid team_code on a full team still says the team is full: the PRD requires a clear message.)
- Credentials are never logged or returned: case_code, case_password and case UUIDs must not appear in any API response, error message, log line, or the session token. They are shown only once by scripts/gen-case-credentials.mjs (never written to a file).
- Rate limits are DB-backed (no in-memory counters): /api/submit-task 10 per player per 60s (counted from task_submissions, wrong ones included, 429 + Retry-After); /api/join 10/min and 30/hour per IP via join_attempts (IP = x-forwarded-for, stored only as an HMAC keyed with SESSION_SECRET, rows older than 1h pruned on insert).
- Tie-break: earliest correct culprit submission, server timestamp.
- Rate limiting: count recent query_logs rows per player (no in-memory counters; Vercel is serverless).
- Realtime: send "changed" pings only; clients refetch /api/state.
- Team size 1-3 allowed. Admin can reset abandoned teams. query_logs kept during event, discarded after.
- RESOLVED (Stage 3) table gating: schema-per-case (`case_<slug>`) + ONE dedicated low-privilege login role `player_exec` + RLS keyed on an unforgeable per-(case, phase) key. We did NOT use role-per-case-per-phase with `SET LOCAL ROLE` from the privileged connection, nor GUC-keyed RLS on case_id: both are defeated from inside a single SELECT (`set_config('role', ...)` / `set_config('app.case_id', ...)`, then a function like `query_to_xml` that runs SQL later in the same statement). Instead: each clue table has a `gate` policy `sha256(current_setting('app.key')) = any(<hashes of keys for phases >= the phase that unlocks the table>)`; the server runs `SET LOCAL`-style `set_config('app.key', <key for the team's phase>, true)` on the player connection; keys live in `case_query_keys` (server-only), policies hold only hashes, so a player can read their own key but cannot derive or forge a later phase's key or another case's key.
- Player SQL rules: only through the `DATABASE_URL_PLAYER` pool (`lib/playerdb.ts`, max 2). One read-only transaction per query; the statement runs through a pg-cursor (extended protocol: exactly one statement, no SQL wrapping to escape) reading at most 201 rows; `statement_timeout` 3s (role default + SET LOCAL) plus a 6s wall-clock deadline; the checked-out client always has an `error` listener (a player can kill their own backend, which otherwise crashes the process) and is destroyed after any failure. `player_exec` has no grants on `public`; core tables also have RLS enabled and anon/authenticated privileges revoked. Never grant `player_exec` membership in any other role.
- Rate limits: /api/query 30 per player per 60s (query_logs rows, advisory-lock serialized); refused requests are not logged.
- Culprit: `cases.culprit_character_id` (server-only). Any player of the team may submit; ONE shot per team; grading, +40, FINISHED and `finished_at` happen in one transaction. Leaderboard order: total points DESC, earliest CORRECT culprit submission (server time), earliest finish, earliest start. The leaderboard is public and never exposes team codes, ids or case codes; default team names are "<head>'s team", never the team code.
- Realtime: Supabase Realtime broadcast "changed" pings on channel `team:<teams.realtime_token>` (random token, not the team id/code). Pings carry no data; clients refetch /api/state; the server publishes with the service key ONLY for pings (best effort, via `after()`); the browser subscribes with the public anon key (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY); without them the UI polls every 3s. Presence broadcasts are not implemented.
- Admin: password-gated (ADMIN_PASSWORD), signed `slc_admin` cookie (audience-bound, SameSite=Strict, origin-checked POSTs), login rate-limited. Reset modes: "state" (wipe progress, keep players/code) and "delete" (remove team, kill its sessions). Emergency pause is per team or global; paused teams cannot query/submit/start/finish and their timer is frozen.
- Cases: 10 definitions in `scripts/cases/` (Opening Night hand-authored; 9 themed variants generated by `skeleton-a.mjs` from `themes.mjs`). `node scripts/verify-case.mjs` mechanically checks answers/uniqueness; it does NOT replace validation by a human who doesn't know the answers.