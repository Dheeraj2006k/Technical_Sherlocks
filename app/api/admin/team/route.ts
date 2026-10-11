import { requireAdmin } from "@/lib/admin";
import { normalizeCode } from "@/lib/codes";
import { query } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";

// Admin view of one team: players, every answer attempt, hints opened, final attempts and recent query activity/errors.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const code = normalizeCode(new URL(req.url).searchParams.get("code"), 6);
    if (!code) throw new HttpError(400, "Invalid team code");
    const t = await query("select id, team_name from teams where team_code = $1", [code]);
    if (!t.rows[0]) throw new HttpError(404, "Team not found");
    const id = t.rows[0].id;

    const [players, attempts, hints, finals, logs] = await Promise.all([
      query("select display_name, role from players where team_id = $1 order by (role = 'head') desc, display_name", [id]),
      query(
        `select it.title as thread, tk.title, tk.answer_type, a.submitted_value, a.is_correct, a.hints_used, a.points_awarded,
                a.submitted_at, p.display_name as player
           from task_attempts a
           join tasks tk on tk.id = a.task_id
           left join investigation_threads it on it.id = tk.thread_id
           join players p on p.id = a.player_id
          where a.team_id = $1 order by a.submitted_at desc limit 100`,
        [id],
      ),
      query(
        `select tk.title, h.position, h.opened_at, p.display_name as opened_by
           from team_hint_usage h join tasks tk on tk.id = h.task_id join players p on p.id = h.opened_by
          where h.team_id = $1 order by h.opened_at desc limit 100`,
        [id],
      ),
      query(
        "select component, is_correct, points_awarded, submitted_at from final_attempts where team_id = $1 order by submitted_at desc limit 50",
        [id],
      ),
      query(
        `select l.created_at, p.display_name as player, l.success, l.error_type, l.row_count, l.execution_time_ms,
                left(l.query_hash, 12) as query_hash
           from query_logs l left join players p on p.id = l.player_id
          where l.team_id = $1 order by l.created_at desc limit 30`,
        [id],
      ),
    ]);
    return json({
      team_name: t.rows[0].team_name,
      players: players.rows,
      attempts: attempts.rows,
      hints: hints.rows,
      final_attempts: finals.rows,
      queries: logs.rows,
    });
  });
}
