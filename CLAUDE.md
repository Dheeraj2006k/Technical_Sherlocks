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
- Join requires display_name. If that name already exists in the team, treat as rejoin and re-issue the token (head included, via team_code + name).
- Tie-break: earliest correct culprit submission, server timestamp.
- Rate limiting: count recent query_logs rows per player (no in-memory counters; Vercel is serverless).
- Realtime: send "changed" pings only; clients refetch /api/state.
- Team size 1-3 allowed. Admin can reset abandoned teams. query_logs kept during event, discarded after.
- PENDING DECISION (before Stage 3): table gating via schema-per-case + role-per-case-per-phase vs RLS-only.