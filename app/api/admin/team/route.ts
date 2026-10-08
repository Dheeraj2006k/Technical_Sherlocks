import { requireAdmin } from "@/lib/admin";
import { normalizeCode } from "@/lib/codes";
import { query } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";

// Admin view of one team: players, every submitted answer, and recent query activity/errors.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const code = normalizeCode(new URL(req.url).searchParams.get("code"), 6);
    if (!code) throw new HttpError(400, "Invalid team code");
    const t = await query("select id, team_name from teams where team_code = $1", [code]);
    if (!t.rows[0]) throw new HttpError(404, "Team not found");
    const id = t.rows[0].id;

    const [players, subs, logs] = await Promise.all([
      query("select display_name, role from players where team_id = $1 order by (role = 'head') desc, display_name", [id]),
      query(
        `select tk.phase_number as phase, tk.difficulty, tk.answer_type, tk.prompt_text, s.submitted_value,
                s.is_correct, s.submitted_at, p.display_name as player
           from task_submissions s
           join tasks tk on tk.id = s.task_id
           join players p on p.id = s.player_id
          where s.team_id = $1 order by s.submitted_at desc limit 100`,
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
    return json({ team_name: t.rows[0].team_name, players: players.rows, submissions: subs.rows, queries: logs.rows });
  });
}
