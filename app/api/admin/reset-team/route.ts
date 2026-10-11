import { audit, requireAdmin } from "@/lib/admin";
import { normalizeCode } from "@/lib/codes";
import { after } from "next/server";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";

// Reset ONE team without touching any other. Every reset is written to admin_audit.
//   mode "state"  (default): wipe progress, answers, hints, threads, final attempts and query logs; keep the team code,
//                 players and case assignment, so everyone can rejoin and start clean.
//   mode "delete": remove the team entirely (players, progress, everything). Its sessions stop working immediately, the
//                 code is freed and the registration's case assignment returns to "assigned" so the head can join again.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const code = normalizeCode(body.team_code, 6);
    if (!code) throw new HttpError(400, "Invalid team code");
    const mode = body.mode === "delete" ? "delete" : "state";

    let teamId: string | null = null;
    await withTx(async (tx) => {
      const t = await tx.query("select id, registration_id, case_id, team_name from teams where team_code = $1 for update", [code]);
      const row = t.rows[0];
      if (!row) throw new HttpError(404, "Team not found");
      const id: string = row.id;
      teamId = id;
      await tx.query("select 1 from team_progress where team_id = $1 for update", [id]);

      await audit(tx, mode === "delete" ? "team_deleted" : "team_reset", {
        registration_id: row.registration_id,
        team_id: mode === "delete" ? null : id,
        case_id: row.case_id,
        details: { team_name: row.team_name, mode },
      });

      if (mode === "delete") {
        await tx.query(
          "update team_case_assignments set status = 'assigned', team_id = null, updated_at = now() where team_id = $1 and status in ('assigned', 'started', 'completed')",
          [id],
        );
        await tx.query("delete from teams where id = $1", [id]);
        return;
      }
      for (const table of [
        "task_attempts",
        "team_task_completions",
        "team_hint_usage",
        "team_thread_progress",
        "thread_assignments",
        "final_attempts",
        "team_final_completions",
        "query_logs",
      ]) {
        await tx.query(`delete from ${table} where team_id = $1`, [id]);
      }
      await tx.query(
        `update team_progress set state = 'WAITING', current_phase = 1,
                phase1_cleared = false, phase2_cleared = false, phase3_cleared = false
          where team_id = $1`,
        [id],
      );
      await tx.query(
        `update team_scores set phase1_pts = 0, phase2_pts = 0, phase3_pts = 0, culprit_pts = 0, total_pts = 0,
                points_by_component = '{}'::jsonb, updated_at = now()
          where team_id = $1`,
        [id],
      );
      await tx.query(
        `update teams set started_at = now(), finished_at = null, paused_total = interval '0',
                paused_at = (select case when paused then now() end from game_control)
          where id = $1`,
        [id],
      );
      await tx.query("update team_case_assignments set status = 'assigned', updated_at = now() where team_id = $1 and status in ('started', 'completed')", [id]);
    });
    if (mode === "state" && teamId) after(() => pingTeam(teamId as string));
    return json({ ok: true, mode });
  });
}
