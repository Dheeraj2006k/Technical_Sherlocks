import { after } from "next/server";
import { withTx } from "@/lib/db";
import { currentPhaseOf } from "@/lib/game";
import { api, HttpError, json, readBody, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { requireSession } from "@/lib/session";

// Head: assign/reassign any open task of the current phase to any teammate.
// Investigator: self-assign an unassigned open task. team/role/phase come from the session only.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    const body = await readBody(req);
    const taskId = uuid(body.task_id, "task_id");
    const targetId = s.role === "head" && body.player_id !== undefined ? uuid(body.player_id, "player_id") : s.player_id;
    if (s.role !== "head" && body.player_id !== undefined && String(body.player_id).toLowerCase() !== s.player_id) {
      throw new HttpError(403, "Only the head can assign tasks to other players");
    }

    await withTx(async (tx) => {
      const pr = await tx.query("select state from team_progress where team_id = $1 for update", [s.team_id]);
      const phase = currentPhaseOf(pr.rows[0].state);

      const t = await tx.query("select id from tasks where id = $1 and case_id = $2 and phase_number = $3", [
        taskId,
        s.case_id,
        phase,
      ]);
      if (!t.rows[0]) throw new HttpError(404, "Task not found in the current phase");

      const solved = await tx.query(
        "select 1 from task_submissions where task_id = $1 and team_id = $2 and is_correct",
        [taskId, s.team_id],
      );
      if (solved.rows[0]) throw new HttpError(409, "Task is already solved");

      const target = await tx.query("select id from players where id = $1 and team_id = $2", [targetId, s.team_id]);
      if (!target.rows[0]) throw new HttpError(404, "Player not found in your team");

      if (s.role === "head") {
        await tx.query(
          `insert into task_assignments (task_id, team_id, player_id, assigned_by) values ($1, $2, $3, $4)
           on conflict (task_id, team_id) do update
             set player_id = excluded.player_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
          [taskId, s.team_id, targetId, s.player_id],
        );
      } else {
        const r = await tx.query(
          `insert into task_assignments (task_id, team_id, player_id, assigned_by) values ($1, $2, $3, $3)
           on conflict (task_id, team_id) do nothing`,
          [taskId, s.team_id, s.player_id],
        );
        if (r.rowCount === 0) {
          const cur = await tx.query("select player_id from task_assignments where task_id = $1 and team_id = $2", [
            taskId,
            s.team_id,
          ]);
          if (cur.rows[0]?.player_id !== s.player_id) {
            throw new HttpError(409, "Task is already assigned; ask the head to reassign it");
          }
        }
      }
    });
    after(() => pingTeam(s.team_id));
    return json({ ok: true });
  });
}
