import { after } from "next/server";
import { withTx } from "@/lib/db";
import { CLEARED_COL, currentPhaseOf, grade, POINTS_PER_PHASE, PTS_COL } from "@/lib/game";
import { api, HttpError, json, readBody, str, uuid } from "@/lib/http";
import { SUBMITS_PER_MINUTE } from "@/lib/ratelimit";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

// Authoritative grading + phase-clear + scoring + state transition in ONE transaction.
// The team's team_progress row is locked first, so concurrent submissions serialize
// and a phase can only be cleared (and scored) once.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const taskId = uuid(body.task_id, "task_id");
    const value = str(body.value, "value");

    const out = await withTx(async (tx) => {
      const pr = await tx.query("select state from team_progress where team_id = $1 for update", [s.team_id]);
      if (!pr.rows[0]) throw new HttpError(401, "Session no longer valid");

      // Per-player limit counted from task_submissions rows (wrong ones included). Done under the
      // team lock so concurrent requests from one player can't slip past it.
      const recent = await tx.query(
        `select extract(epoch from (min(submitted_at) + interval '60 seconds' - now()))::int as wait, count(*)::int as n
           from (select submitted_at from task_submissions
                  where player_id = $1 and submitted_at > now() - interval '60 seconds'
                  order by submitted_at desc limit $2) r`,
        [s.player_id, SUBMITS_PER_MINUTE],
      );
      if (recent.rows[0].n >= SUBMITS_PER_MINUTE) {
        const wait = Math.max(1, recent.rows[0].wait ?? 60);
        throw new HttpError(429, "Too many submissions. Slow down.", { "Retry-After": String(wait) });
      }

      const state: string = pr.rows[0].state;
      const phase = currentPhaseOf(state);

      // Task must belong to the session's case AND the team's current phase.
      const t = await tx.query(
        "select answer_type, correct_answer from tasks where id = $1 and case_id = $2 and phase_number = $3",
        [taskId, s.case_id, phase],
      );
      const task = t.rows[0];
      if (!task) throw new HttpError(404, "Task not found in the current phase");

      const solved = await tx.query(
        "select 1 from task_submissions where task_id = $1 and team_id = $2 and is_correct",
        [taskId, s.team_id],
      );
      if (solved.rows[0]) return { correct: true, already_solved: true, phase_cleared: false, state };

      const correct = grade(task.answer_type, value, task.correct_answer);
      const ins = await tx.query(
        `insert into task_submissions (task_id, team_id, player_id, submitted_value, is_correct)
         values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
        [taskId, s.team_id, s.player_id, value, correct],
      );
      if (!correct) return { correct: false, already_solved: false, phase_cleared: false, state };
      if (ins.rowCount === 0) return { correct: true, already_solved: true, phase_cleared: false, state };

      const c = await tx.query(
        `select
           (select count(*)::int from tasks where case_id = $2 and phase_number = $3) as total,
           (select count(distinct ts.task_id)::int
              from task_submissions ts join tasks tk on tk.id = ts.task_id
             where ts.team_id = $1 and ts.is_correct and tk.case_id = $2 and tk.phase_number = $3) as solved`,
        [s.team_id, s.case_id, phase],
      );
      if (c.rows[0].solved < c.rows[0].total) {
        return { correct: true, already_solved: false, phase_cleared: false, state };
      }

      const nextState = phase === 3 ? "FINAL_DEDUCTION" : `PHASE_${phase + 1}`;
      const nextPhase = phase === 3 ? 3 : phase + 1;
      const cleared = CLEARED_COL[phase];
      const pts = PTS_COL[phase];
      const up = await tx.query(
        `update team_progress set ${cleared} = true, state = $2, current_phase = $3
          where team_id = $1 and ${cleared} = false`,
        [s.team_id, nextState, nextPhase],
      );
      if (up.rowCount === 1) {
        await tx.query(
          `update team_scores set ${pts} = $2, total_pts = total_pts - ${pts} + $2 where team_id = $1`,
          [s.team_id, POINTS_PER_PHASE],
        );
      }
      return { correct: true, already_solved: false, phase_cleared: up.rowCount === 1, state: nextState };
    });
    if (out.correct && !out.already_solved) after(() => pingTeam(s.team_id)); // task done / phase cleared
    return json({ ok: true, ...out });
  });
}
