# PRD v5 gap analysis

Baseline = repository at commit `658c1b7` (the "v4-era" game: one SQL track, 10 cases, 3 phases x 3 tasks, 20/20/20/40
scoring, one culprit pick, direct case-code join). Statuses below are the **initial** state (before this work); the final state, with evidence, is in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Almost every MISSING/PARTIAL row is now implemented and tested; the exceptions are content authorship, human playtests, and anything needing the real Supabase/Vercel environment.

Legend: COMPLETE (implemented and verified) · PARTIAL · MISSING · BLOCKED (external prerequisite) · UNVERIFIED.

| PRD § | Requirement | Baseline behaviour | Gap / approach | Status (initial) |
|---|---|---|---|---|
| 1 | Two tracks (SQL01-10, LOG01-10), one shared engine | One SQL track, 10 generated cases, no `game_track` | Add `game_track`, new Logic cases and an Evidence Browser on the same engine | PARTIAL |
| 1 | Team of 1-3 (head + investigators) | Implemented, tested | Keep | COMPLETE |
| 1 | Registration first, manual assignment, head uses registration credential + case code + password | Head joins directly with case code + password; no registrations | New `registrations`, `team_case_assignments`, admin assign UI/API, new join flow | MISSING |
| 2 | Cross-team / cross-case leakage prevention | RLS keyed on per-(case,phase) keys, tested | Generalise to per-table keys so thread-level unlocks are enforceable; keep `player_exec` | PARTIAL |
| 2 | Deterministic server-side grading | Exact-match grading in a transaction | Keep, extend to attempts/completions | COMPLETE |
| 3 | `cases`: case_code (SQL01..), game_track, title, hook, status (draft/tested/published/disabled), target_duration, content_version | Random Crockford `case_code`, status draft/live, no track/duration/version | Migration: new columns, codes SQL01-SQL10, status vocabulary | PARTIAL |
| 3 | 20 distinct cases, each with cast, threads, questions, hints, answer key, scoring config | 10 SQL cases (no threads/hints), 0 Logic cases | Author/generate threads + hints for 10 SQL, generate 10 Logic cases; automated validators | PARTIAL |
| 4.1 | `registrations` (ref/credential, team_ref, size, status, created_at) | None | New table + CSV import + admin UI | MISSING |
| 4.2 | Assignment rules (one active, fixed once started, audit, reset to reassign, track/case match, published only) | None (case chosen by the head) | New table, partial unique indexes, audit table, admin API | MISSING |
| 4.3 | Head join validates registration, assignment, case code, password, published, no conflicting session | Validates code + password + live only | Rewrite `/api/join` | MISSING |
| 4.4 | Idempotent head join, no duplicate team per registration | Idempotency key table exists | Keep + unique team per registration | PARTIAL |
| 5 | Team structure, 4th rejected, one head, unique team codes | Implemented, tested (races included) | Keep | COMPLETE |
| 5.3 | Server authoritative for identity, assignment, phase, unlocks, hints, score | Yes except hints/threads (do not exist) | Extend | PARTIAL |
| 5.4 | Recovery restores assignment, role, phase, threads, unlocks, hints, attempts, score, final progress | Phase/score/tasks restored; no threads/hints/attempt history | Extend `/api/state` | PARTIAL |
| 6.1 | State machine WAITING..FINISHED, server-side | Implemented | Keep; phase transition driven by required threads | PARTIAL |
| 6.2 | Phases with distinct purposes | Same question pattern each phase (easy/medium/hard) | Re-author templates per phase purpose | PARTIAL |
| 6.3 | `investigation_threads`, `thread_evidence_tables`, `team_thread_progress`, outcomes | None | New tables + engine + UI | MISSING |
| 6.3 | Solo players can complete everything; thread count independent of team size | True (no thread concept) | Preserve; test | PARTIAL |
| 6.4 | Question design rules (dossiers 30-100+ rows, Indian names, red herrings, distinct trick, no answer leakage) | 14-person cast with non-Indian names; small tables; one repeated trick | Rename casts, generate ordinary-record dossiers; distinct tricks are NOT achievable by templates (documented) | PARTIAL |
| 6.5 | Evidence config: start evidence, unlocks per thread/answer, required/optional threads, hidden evidence, story events, final prerequisites | Phase-level table unlocks only | Thread-level unlocks, story events | PARTIAL |
| 6.6 | Publication checklist incl. solo-solvability, both interfaces share unlock rules, score = 100 | Answer-key + uniqueness checks only | Extend `verify-case` | PARTIAL |
| 7.1 | Score budget exactly 100 | 20+20+20+40 | New scoring config + validator | PARTIAL |
| 7.2 | Shared hints, schedule 10/8/6/4/2, no regaining points | No hints | New hint tables/endpoint/UI | MISSING |
| 7.3 | Wrong answer -2, SQL errors free, floor 0, points once | No wrong-answer penalty | Implement in transaction | MISSING |
| 7.4 | `task_attempts` (idempotency) + `team_task_completions` unique per (team,task) | `task_submissions` (partial unique) | New tables; migrate engine | PARTIAL |
| 8 | Final deduction: responsibility + explanation (3-4 options), retries, -2 each wrong, finish when both done | Single culprit, one shot | New `final_attempts`, options table, endpoints, UI | MISSING |
| 9.1 | SQL console with limit/truncation/errors | Implemented | Keep | COMPLETE |
| 9.2 | Evidence Browser (search, filter, sort, paginate); optional SQL from the start | None | New `/api/evidence` + UI | MISSING |
| 9.3 | Both interfaces enforce same unlock rules, no metadata leakage | SQL only | Single enforcement path (RLS keys) used by both | PARTIAL |
| 10 | Scale/perf targets | Measured p95 ~4s query on 1 instance (remote DB) | Re-measure; improve queries | UNVERIFIED |
| 11.1 | SQL execution layers | Implemented and adversarially tested | Keep, retest after key change | COMPLETE |
| 11.2 | Evidence Browser security (parameterised, allow-listed) | None | Implement | MISSING |
| 11.3 | Pooled connections, server-side secrets | Pooled path verified (player_exec via pooler) | Keep | COMPLETE |
| 11.4 | Transactions + idempotency for all scoring operations | Done for v4 flows | Re-implement for v5 flows | PARTIAL |
| 11.5 | Realtime + authoritative fallback | Implemented, tested against Supabase Realtime | Keep; extend events | PARTIAL |
| 11.6 | `query_logs`, retention | Implemented | Keep | COMPLETE |
| 12 | Data model (all listed tables, constraints) | ~half of the tables | New migrations | PARTIAL |
| 13 | API surface (`/api/evidence`, `/api/submit-final`, track leaderboards, `/api/admin/assign-case`, ...) | v4 surface | Add/rename routes | PARTIAL |
| 14 | Admin: registrations, assignment, monitoring (threads, hints, connected players), reset, pause, export | Mission-control dashboard without registrations/assignments/threads/hints | Extend | PARTIAL |
| 14 | Separate SQL / Logic leaderboards; tie-break = final resolution time | One leaderboard; tie-break = culprit time | Per-track leaderboards | PARTIAL |
| 15 | Stage 0-9 acceptance criteria | v4 stages done | Re-verify against v5 criteria | PARTIAL |

## Things that cannot be completed by engineering alone

* **Blind human playtests** (PRD 6.6, Stage 9) and **measured solve times** need real first-time players.
* **Twenty distinctly authored mysteries with a unique central detective trick each** (PRD 6.4) is editorial work. The
  repository will contain 20 *generated, machine-verified* cases that satisfy the structural rules; their story quality and
  variety are limited by the templates and need human review.
* **Production migration and deployment** need the organizers' go-ahead (see ASSUMPTIONS_AND_DECISIONS.md).
