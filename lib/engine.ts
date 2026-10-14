import type { PoolClient } from "pg";
import { withTx } from "./db";
import { grade } from "./game";
import { HttpError } from "./http";
import { SUBMITS_PER_MINUTE } from "./ratelimit";
import type { Session } from "./session";

// The shared investigation engine (PRD v5): threads, evidence unlocks, attempts, hints, scoring and the two-component
// final deduction. Everything here is server-side and transactional; the browser only ever displays the result.

export const WRONG_ANSWER_PENALTY = 2;
export const REACHED: Record<string, number> = { WAITING: 0, PHASE_1: 1, PHASE_2: 2, PHASE_3: 3, FINAL_DEDUCTION: 3, FINISHED: 3 };
export const NEXT_STATE: Record<string, string> = { PHASE_1: "PHASE_2", PHASE_2: "PHASE_3", PHASE_3: "FINAL_DEDUCTION" };

type Q = Pick<PoolClient, "query">;

// ---------------------------------------------------------------------------------------------------------------
// Evidence unlocks (one query; used by the console, the Evidence Browser and the state endpoint)
// ---------------------------------------------------------------------------------------------------------------
const UNLOCK_SQL = `
with t as (
  select t.case_id, tp.state, c.slug, c.game_track,
         case tp.state when 'WAITING' then 0 when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end as reached
    from teams t join team_progress tp on tp.team_id = t.id join cases c on c.id = t.case_id
   where t.id = $1),
th as (
  select it.id,
         (it.phase_number <= t.reached and (it.prerequisite_thread_id is null or exists (
            select 1 from team_thread_progress p
             where p.team_id = $1 and p.thread_id = it.prerequisite_thread_id and p.status = 'completed'))) as available,
         exists (select 1 from team_thread_progress p where p.team_id = $1 and p.thread_id = it.id and p.status = 'completed') as done
    from investigation_threads it join t on it.case_id = t.case_id),
names as (
  select unnest(cp.tables_unlocked) as name
    from case_phases cp join t on cp.case_id = t.case_id and cp.phase_number <= t.reached
  union
  select te.table_name
    from thread_evidence_tables te join th on th.id = te.thread_id
   where (te.unlock_condition = 'available' and th.available) or (te.unlock_condition = 'complete' and th.done))
select t.case_id, t.slug, t.game_track, t.state, n.name, k.key
  from t left join names n on true
  left join case_table_keys k on k.case_id = t.case_id and k.table_name = n.name`;

export type Unlocks = { caseId: string; slug: string; track: "SQL" | "LOGIC"; state: string; tables: string[]; keys: string[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Runner = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export async function getUnlocks(run: Runner, teamId: string): Promise<Unlocks | null> {
  const r = await run(UNLOCK_SQL, [teamId]);
  if (!r.rows[0]) return null;
  const tables: string[] = [];
  const keys: string[] = [];
  for (const row of r.rows) {
    if (row.name && row.key) {
      tables.push(row.name);
      keys.push(row.key);
    }
  }
  const f = r.rows[0];
  return { caseId: f.case_id, slug: f.slug, track: f.game_track, state: f.state, tables, keys };
}

// ---------------------------------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------------------------------
async function applyScore(tx: Q, teamId: string, delta: number, component: "tasks" | "culprit" | "mechanism" | "penalties") {
  const r = await tx.query(
    `update team_scores
        set total_pts = greatest(0, total_pts + $2),
            points_by_component = jsonb_set(coalesce(points_by_component, '{}'::jsonb), array[$3::text],
                                            to_jsonb(coalesce((points_by_component ->> $3)::int, 0) + $2)),
            updated_at = now()
      where team_id = $1 returning total_pts`,
    [teamId, delta, component],
  );
  return r.rows[0].total_pts as number;
}

// A wrong answer costs 2, but the score never drops below zero: the recorded penalty is what was actually removed.
async function penalty(tx: Q, teamId: string): Promise<number> {
  const cur = await tx.query("select total_pts from team_scores where team_id = $1", [teamId]);
  const take = Math.min(WRONG_ANSWER_PENALTY, cur.rows[0]?.total_pts ?? 0);
  if (take > 0) await applyScore(tx, teamId, -take, "penalties");
  return take;
}

export function rewardFor(schedule: number[], hintsUsed: number): number {
  return schedule[Math.min(hintsUsed, schedule.length - 1)] ?? 0;
}

async function lockProgress(tx: Q, teamId: string): Promise<string> {
  const pr = await tx.query("select state from team_progress where team_id = $1 for update", [teamId]);
  if (!pr.rows[0]) throw new HttpError(401, "Session no longer valid");
  return pr.rows[0].state as string;
}

async function threadAvailable(tx: Q, teamId: string, threadId: string, reached: number): Promise<{ ok: boolean; phase: number; required: boolean }> {
  const r = await tx.query(
    `select it.phase_number, it.required,
            (it.phase_number <= $3 and (it.prerequisite_thread_id is null or exists (
               select 1 from team_thread_progress p
                where p.team_id = $1 and p.thread_id = it.prerequisite_thread_id and p.status = 'completed'))) as available
       from investigation_threads it where it.id = $2`,
    [teamId, threadId, reached],
  );
  const row = r.rows[0];
  return { ok: Boolean(row?.available), phase: row?.phase_number ?? 0, required: row?.required ?? false };
}

// ---------------------------------------------------------------------------------------------------------------
// Submit an answer (PRD 7.4, 11.4)
// ---------------------------------------------------------------------------------------------------------------
export type SubmitResult = {
  correct: boolean;
  already_completed: boolean;
  replayed: boolean;
  points_awarded: number;
  hints_used: number;
  thread_completed: boolean;
  phase_cleared: boolean;
  state: string;
  total_points: number;
};

export async function submitTask(s: Session, taskId: string, value: string, idempotencyKey: string): Promise<SubmitResult> {
  return withTx(async (tx) => {
    const state = await lockProgress(tx, s.team_id);
    if (state === "WAITING") throw new HttpError(409, "The investigation hasn't started yet.");
    if (state === "FINISHED") throw new HttpError(409, "This case is already closed.");
    const reached = REACHED[state];
    const totalNow = async () => (await tx.query("select total_pts from team_scores where team_id = $1", [s.team_id])).rows[0].total_pts as number;

    // A replayed request returns the stored outcome and changes nothing.
    const prev = await tx.query("select task_id, is_correct, points_awarded, hints_used from task_attempts where team_id = $1 and idempotency_key = $2", [s.team_id, idempotencyKey]);
    if (prev.rows[0]) {
      return {
        correct: prev.rows[0].is_correct,
        already_completed: false,
        replayed: true,
        points_awarded: prev.rows[0].points_awarded,
        hints_used: prev.rows[0].hints_used,
        thread_completed: false,
        phase_cleared: false,
        state,
        total_points: await totalNow(),
      };
    }

    // Per-player rate limit counted from the attempts themselves (wrong ones included).
    const recent = await tx.query(
      `select count(*)::int as n, extract(epoch from (min(submitted_at) + interval '60 seconds' - now()))::int as wait
         from (select submitted_at from task_attempts where player_id = $1 and submitted_at > now() - interval '60 seconds'
                order by submitted_at desc limit $2) r`,
      [s.player_id, SUBMITS_PER_MINUTE],
    );
    if (recent.rows[0].n >= SUBMITS_PER_MINUTE) {
      throw new HttpError(429, "Too many submissions. Slow down.", { "Retry-After": String(Math.max(1, recent.rows[0].wait ?? 60)) });
    }

    // The task must belong to this team's case and sit in a thread this team can currently work on.
    const t = await tx.query(
      "select answer_type, correct_answer, alt_answers, reward_schedule, thread_id from tasks where id = $1 and case_id = $2",
      [taskId, s.case_id],
    );
    const task = t.rows[0];
    if (!task || !task.thread_id) throw new HttpError(404, "Question not found.");
    const th = await threadAvailable(tx, s.team_id, task.thread_id, reached);
    if (!th.ok) throw new HttpError(404, "Question not found.");

    const done = await tx.query("select 1 from team_task_completions where team_id = $1 and task_id = $2", [s.team_id, taskId]);
    if (done.rows[0]) {
      return { correct: true, already_completed: true, replayed: false, points_awarded: 0, hints_used: 0, thread_completed: false, phase_cleared: false, state, total_points: await totalNow() };
    }

    const hints = await tx.query("select count(*)::int as n from team_hint_usage where team_id = $1 and task_id = $2", [s.team_id, taskId]);
    const hintsUsed: number = hints.rows[0].n;
    const correct = grade(task.answer_type, value, task.correct_answer, task.alt_answers ?? []);

    if (!correct) {
      const took = await penalty(tx, s.team_id);
      await tx.query(
        `insert into task_attempts (task_id, team_id, player_id, submitted_value, is_correct, hints_used, points_awarded, idempotency_key)
         values ($1, $2, $3, $4, false, $5, $6, $7)`,
        [taskId, s.team_id, s.player_id, value, hintsUsed, -took, idempotencyKey],
      );
      return { correct: false, already_completed: false, replayed: false, points_awarded: -took, hints_used: hintsUsed, thread_completed: false, phase_cleared: false, state, total_points: await totalNow() };
    }

    const points = rewardFor(task.reward_schedule, hintsUsed);
    await tx.query(
      `insert into task_attempts (task_id, team_id, player_id, submitted_value, is_correct, hints_used, points_awarded, idempotency_key)
       values ($1, $2, $3, $4, true, $5, $6, $7)`,
      [taskId, s.team_id, s.player_id, value, hintsUsed, points, idempotencyKey],
    );
    const comp = await tx.query(
      "insert into team_task_completions (team_id, task_id, completed_by, points_awarded) values ($1, $2, $3, $4) on conflict do nothing returning task_id",
      [s.team_id, taskId, s.player_id, points],
    );
    if (comp.rowCount === 0) {
      // lost a race with another completion (cannot happen under the row lock, but never award twice)
      return { correct: true, already_completed: true, replayed: false, points_awarded: 0, hints_used: hintsUsed, thread_completed: false, phase_cleared: false, state, total_points: await totalNow() };
    }
    const total = await applyScore(tx, s.team_id, points, "tasks");

    // Thread completion, then phase progression: all server-side, in this transaction.
    let threadCompleted = false;
    let phaseCleared = false;
    let newState = state;
    const left = await tx.query(
      `select count(*)::int as n from tasks tk
        where tk.thread_id = $1
          and not exists (select 1 from team_task_completions c where c.team_id = $2 and c.task_id = tk.id)`,
      [task.thread_id, s.team_id],
    );
    if (left.rows[0].n === 0) {
      const ins = await tx.query(
        `insert into team_thread_progress (team_id, thread_id, status, outcome_type, completed_at)
         select $1, it.id, 'completed', it.outcome_type, now() from investigation_threads it where it.id = $2
         on conflict (team_id, thread_id) do nothing returning thread_id`,
        [s.team_id, task.thread_id],
      );
      threadCompleted = (ins.rowCount ?? 0) > 0;
    }
    if (threadCompleted && NEXT_STATE[state]) {
      const phase = reached; // the team's current phase
      const pending = await tx.query(
        `select count(*)::int as n from investigation_threads it
          where it.case_id = $1 and it.phase_number = $2 and it.required
            and not exists (select 1 from team_thread_progress p where p.team_id = $3 and p.thread_id = it.id and p.status = 'completed')`,
        [s.case_id, phase, s.team_id],
      );
      if (pending.rows[0].n === 0) {
        newState = NEXT_STATE[state];
        const nextPhase = newState === "FINAL_DEDUCTION" ? 3 : phase + 1;
        await tx.query(
          `update team_progress set state = $2, current_phase = $3,
                  phase1_cleared = phase1_cleared or $4, phase2_cleared = phase2_cleared or $5, phase3_cleared = phase3_cleared or $6
            where team_id = $1`,
          [s.team_id, newState, nextPhase, phase >= 1, phase >= 2, phase >= 3],
        );
        phaseCleared = true;
      }
    }
    return { correct: true, already_completed: false, replayed: false, points_awarded: points, hints_used: hintsUsed, thread_completed: threadCompleted, phase_cleared: phaseCleared, state: newState, total_points: total };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Hints (shared by the team, opened in order)
// ---------------------------------------------------------------------------------------------------------------
// `position` makes the click idempotent: two teammates who both press "reveal hint 2" open it once and pay once. Asking
// for an already-open hint just returns it; asking to skip ahead is refused.
export async function openHint(s: Session, taskId: string, position?: number) {
  return withTx(async (tx) => {
    const state = await lockProgress(tx, s.team_id);
    if (state === "WAITING" || state === "FINISHED") throw new HttpError(409, "Hints aren't available right now.");
    const t = await tx.query("select reward_schedule, thread_id from tasks where id = $1 and case_id = $2", [taskId, s.case_id]);
    const task = t.rows[0];
    if (!task?.thread_id) throw new HttpError(404, "Question not found.");
    const th = await threadAvailable(tx, s.team_id, task.thread_id, REACHED[state]);
    if (!th.ok) throw new HttpError(404, "Question not found.");
    const done = await tx.query("select 1 from team_task_completions where team_id = $1 and task_id = $2", [s.team_id, taskId]);
    if (done.rows[0]) throw new HttpError(409, "You have already answered this question.");

    const used = (await tx.query("select count(*)::int as n from team_hint_usage where team_id = $1 and task_id = $2", [s.team_id, taskId])).rows[0].n as number;
    if (position !== undefined) {
      if (position > used + 1) throw new HttpError(409, "Open the earlier hints first.");
      if (position <= used) {
        const open = await tx.query("select hint_text from task_hints where task_id = $1 and position = $2", [taskId, position]);
        if (!open.rows[0]) throw new HttpError(404, "Hint not found.");
        return { position, text: open.rows[0].hint_text as string, hints_used: used, reward_now: rewardFor(task.reward_schedule, used), already_open: true };
      }
    }
    const next = await tx.query("select position, hint_text from task_hints where task_id = $1 and position = $2", [taskId, used + 1]);
    if (!next.rows[0]) throw new HttpError(409, "No more hints for this question.");
    await tx.query("insert into team_hint_usage (team_id, task_id, position, opened_by) values ($1, $2, $3, $4) on conflict do nothing", [s.team_id, taskId, used + 1, s.player_id]);
    return { position: used + 1, text: next.rows[0].hint_text as string, hints_used: used + 1, reward_now: rewardFor(task.reward_schedule, used + 1), already_open: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Final deduction: responsibility + explanation (PRD 8)
// ---------------------------------------------------------------------------------------------------------------
export type FinalResult = { component: string; correct: boolean; already_resolved: boolean; replayed: boolean; points_awarded: number; finished: boolean; state: string; total_points: number };

export async function submitFinal(s: Session, component: "culprit" | "mechanism", value: string, idempotencyKey: string): Promise<FinalResult> {
  return withTx(async (tx) => {
    const state = await lockProgress(tx, s.team_id);
    const totalNow = async () => (await tx.query("select total_pts from team_scores where team_id = $1", [s.team_id])).rows[0].total_pts as number;
    if (state === "FINISHED") throw new HttpError(409, "This case is already closed.");
    if (state !== "FINAL_DEDUCTION") throw new HttpError(409, "The final deduction isn't unlocked yet.");

    const prev = await tx.query("select component, is_correct, points_awarded from final_attempts where team_id = $1 and idempotency_key = $2", [s.team_id, idempotencyKey]);
    if (prev.rows[0]) {
      return { component: prev.rows[0].component, correct: prev.rows[0].is_correct, already_resolved: false, replayed: true, points_awarded: prev.rows[0].points_awarded, finished: false, state, total_points: await totalNow() };
    }
    // Team-level limit on final guesses (they have no per-player column): a wrong guess costs points, but a team that
    // is already at zero must not be able to brute-force the options for free.
    const recent = await tx.query(
      `select count(*)::int as n, extract(epoch from (min(submitted_at) + interval '60 seconds' - now()))::int as wait
         from (select submitted_at from final_attempts where team_id = $1 and submitted_at > now() - interval '60 seconds' order by submitted_at desc limit $2) r`,
      [s.team_id, SUBMITS_PER_MINUTE],
    );
    if (recent.rows[0].n >= SUBMITS_PER_MINUTE) {
      throw new HttpError(429, "Too many guesses. Slow down.", { "Retry-After": String(Math.max(1, recent.rows[0].wait ?? 60)) });
    }
    const resolved = await tx.query("select 1 from team_final_completions where team_id = $1 and component = $2", [s.team_id, component]);
    if (resolved.rows[0]) {
      return { component, correct: true, already_resolved: true, replayed: false, points_awarded: 0, finished: false, state, total_points: await totalNow() };
    }

    const c = await tx.query("select final_points_culprit, final_points_mechanism, culprit_character_id from cases where id = $1", [s.case_id]);
    const cs = c.rows[0];
    let correct = false;
    if (component === "culprit") {
      const ch = await tx.query("select 1 from characters where id = $1 and case_id = $2", [value, s.case_id]);
      if (!ch.rows[0]) throw new HttpError(404, "Unknown character.");
      correct = cs.culprit_character_id === value;
    } else {
      const op = await tx.query("select is_correct from final_options where id = $1 and case_id = $2 and component = 'mechanism'", [value, s.case_id]);
      if (!op.rows[0]) throw new HttpError(404, "Unknown option.");
      correct = op.rows[0].is_correct;
    }

    if (!correct) {
      const took = await penalty(tx, s.team_id);
      await tx.query(
        `insert into final_attempts (team_id, component, submitted_value, is_correct, points_awarded, idempotency_key) values ($1, $2, $3, false, $4, $5)`,
        [s.team_id, component, value, -took, idempotencyKey],
      );
      return { component, correct: false, already_resolved: false, replayed: false, points_awarded: -took, finished: false, state, total_points: await totalNow() };
    }

    const points: number = component === "culprit" ? cs.final_points_culprit : cs.final_points_mechanism;
    await tx.query(
      `insert into final_attempts (team_id, component, submitted_value, is_correct, points_awarded, idempotency_key) values ($1, $2, $3, true, $4, $5)`,
      [s.team_id, component, value, points, idempotencyKey],
    );
    await tx.query("insert into team_final_completions (team_id, component, points_awarded) values ($1, $2, $3)", [s.team_id, component, points]);
    const total = await applyScore(tx, s.team_id, points, component);

    // Finished only when BOTH components are correctly resolved. The finish time is the later resolution (the tie-break).
    const both = await tx.query("select count(*)::int as n from team_final_completions where team_id = $1", [s.team_id]);
    let finished = false;
    if (both.rows[0].n === 2) {
      await tx.query("update team_progress set state = 'FINISHED' where team_id = $1", [s.team_id]);
      await tx.query("update teams set finished_at = now() where id = $1", [s.team_id]);
      await tx.query("update team_case_assignments set status = 'completed', updated_at = now() where team_id = $1 and status in ('assigned','started')", [s.team_id]);
      finished = true;
    }
    return { component, correct: true, already_resolved: false, replayed: false, points_awarded: points, finished, state: finished ? "FINISHED" : state, total_points: total };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Thread assignment among teammates (never required; any one player can do every thread)
// ---------------------------------------------------------------------------------------------------------------
export async function assignThread(s: Session, threadId: string, targetPlayerId: string | null) {
  return withTx(async (tx) => {
    const state = await lockProgress(tx, s.team_id);
    if (state === "WAITING" || state === "FINISHED") throw new HttpError(409, "Threads can't be assigned right now.");
    const th = await threadAvailable(tx, s.team_id, threadId, REACHED[state]);
    const own = await tx.query("select 1 from investigation_threads where id = $1 and case_id = $2", [threadId, s.case_id]);
    if (!own.rows[0] || !th.ok) throw new HttpError(404, "Thread not found.");
    const done = await tx.query("select 1 from team_thread_progress where team_id = $1 and thread_id = $2 and status = 'completed'", [s.team_id, threadId]);
    if (done.rows[0]) throw new HttpError(409, "That thread is already complete.");

    const isHead = s.role === "head";
    const target = isHead && targetPlayerId ? targetPlayerId : s.player_id;
    if (!isHead && targetPlayerId && targetPlayerId !== s.player_id) throw new HttpError(403, "Only the team head can assign threads to other players.");
    const member = await tx.query("select 1 from players where id = $1 and team_id = $2", [target, s.team_id]);
    if (!member.rows[0]) throw new HttpError(404, "Player not found in your team.");

    if (isHead) {
      await tx.query(
        `insert into thread_assignments (thread_id, team_id, player_id, assigned_by) values ($1, $2, $3, $4)
         on conflict (thread_id, team_id) do update set player_id = excluded.player_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
        [threadId, s.team_id, target, s.player_id],
      );
    } else {
      const r = await tx.query(
        "insert into thread_assignments (thread_id, team_id, player_id, assigned_by) values ($1, $2, $3, $3) on conflict (thread_id, team_id) do nothing",
        [threadId, s.team_id, s.player_id],
      );
      if (r.rowCount === 0) {
        const cur = await tx.query("select player_id from thread_assignments where thread_id = $1 and team_id = $2", [threadId, s.team_id]);
        if (cur.rows[0]?.player_id !== s.player_id) throw new HttpError(409, "Already assigned; ask the team head to reassign it.");
      }
    }
    return { ok: true };
  });
}
