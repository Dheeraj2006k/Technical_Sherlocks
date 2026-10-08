import { requireAdmin } from "@/lib/admin";
import { normalizeCode } from "@/lib/codes";
import { after } from "next/server";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";

// Reset ONE team without touching any other.
//   mode "state"  (default): wipe progress, answers, assignments, culprit and query logs; keep the team
//                 code and players, so everyone can rejoin and start clean.
//   mode "delete": remove the team entirely (players, progress, everything). Its sessions stop working
//                 immediately and the code is freed.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const code = normalizeCode(body.team_code, 6);
    if (!code) throw new HttpError(400, "Invalid team code");
    const mode = body.mode === "delete" ? "delete" : "state";

    let teamId: string | null = null;
    await withTx(async (tx) => {
      const t = await tx.query("select id from teams where team_code = $1 for update", [code]);
      const id = t.rows[0]?.id;
      if (!id) throw new HttpError(404, "Team not found");
      teamId = id;
      // Same lock order as the gameplay routes (team_progress row first would also work; teams row
      // is taken here and progress right after, and no gameplay route takes them in the other order).
      await tx.query("select 1 from team_progress where team_id = $1 for update", [id]);

      if (mode === "delete") {
        await tx.query("delete from teams where id = $1", [id]);
        return;
      }
      await tx.query("delete from task_submissions where team_id = $1", [id]);
      await tx.query("delete from task_assignments where team_id = $1", [id]);
      await tx.query("delete from culprit_submission where team_id = $1", [id]);
      await tx.query("delete from query_logs where team_id = $1", [id]);
      await tx.query(
        `update team_progress set state = 'WAITING', current_phase = 1,
                phase1_cleared = false, phase2_cleared = false, phase3_cleared = false
          where team_id = $1`,
        [id],
      );
      await tx.query(
        "update team_scores set phase1_pts = 0, phase2_pts = 0, phase3_pts = 0, culprit_pts = 0, total_pts = 0 where team_id = $1",
        [id],
      );
      await tx.query(
        `update teams set started_at = now(), finished_at = null, paused_total = interval '0',
                paused_at = (select case when paused then now() end from game_control)
          where id = $1`,
        [id],
      );
    });
    if (mode === "state" && teamId) after(() => pingTeam(teamId as string));
    return json({ ok: true, mode });
  });
}
