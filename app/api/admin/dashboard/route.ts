import { requireAdmin } from "@/lib/admin";
import { formatCode } from "@/lib/codes";
import { query } from "@/lib/db";
import { api, json } from "@/lib/http";

const IDLE_AFTER_S = 10 * 60;

// Live view of every team (PRD 13): case and track, phase, thread progress, hints, wrong answers, connected players,
// elapsed time (pause-aware), status and last activity.
const DASHBOARD_SQL = `
  select t.team_code, t.team_name, c.case_code, c.title as case_title, c.game_track as track, tp.state, tp.current_phase, sc.total_pts,
         (select count(*)::int from players p where p.team_id = t.id) as players,
         (select count(*)::int from players p where p.team_id = t.id and p.last_seen_at > now() - interval '45 seconds') as connected,
         (select count(*)::int from team_thread_progress p where p.team_id = t.id and p.status = 'completed') as threads_done,
         (select count(*)::int from investigation_threads it where it.case_id = t.case_id) as threads_total,
         (select count(*)::int from team_hint_usage h where h.team_id = t.id) as hints_used,
         (select count(*)::int from task_attempts a where a.team_id = t.id and not a.is_correct)
           + (select count(*)::int from final_attempts f where f.team_id = t.id and not f.is_correct) as wrong_answers,
         extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                             - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s,
         (t.paused_at is not null) as paused,
         (t.finished_at is not null) as finished,
         extract(epoch from (now() - greatest(
            t.started_at,
            coalesce((select max(submitted_at) from task_attempts s where s.team_id = t.id), t.started_at),
            coalesce((select max(submitted_at) from final_attempts s where s.team_id = t.id), t.started_at),
            coalesce((select max(created_at) from query_logs q where q.team_id = t.id), t.started_at)
         )))::int as idle_s,
         (select count(*)::int from query_logs q
           where q.team_id = t.id and not q.success and q.error_type <> 'pending'
             and q.created_at > now() - interval '5 minutes') as recent_errors
    from teams t
    join team_progress tp on tp.team_id = t.id
    join team_scores sc on sc.team_id = t.id
    join cases c on c.id = t.case_id
   order by c.game_track, t.started_at`;

export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const [teams, ctl] = await Promise.all([
      query(DASHBOARD_SQL),
      query<{ paused: boolean }>("select paused from game_control where id = 1"),
    ]);
    return json({
      game_paused: ctl.rows[0]?.paused ?? false,
      teams: teams.rows.map((t) => ({
        ...t,
        team_code: formatCode(t.team_code),
        status: t.finished ? "finished" : t.paused ? "paused" : t.state === "WAITING" ? "waiting" : t.idle_s > IDLE_AFTER_S ? "idle" : "playing",
      })),
    });
  });
}
