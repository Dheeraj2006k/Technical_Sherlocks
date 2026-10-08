import { query } from "@/lib/db";
import { api, json } from "@/lib/http";

// Public live standings (nothing here is a credential: no team codes, ids or case codes).
// Order: total points DESC, then the earliest CORRECT culprit submission (server timestamp), then
// earliest finish, then earliest start.
const LEADERBOARD_SQL = `
  select substr(md5(t.id::text || t.realtime_token), 1, 12) as ref, t.team_name, c.title as case_title, tp.state, sc.total_pts,
         (tp.phase1_cleared::int + tp.phase2_cleared::int + tp.phase3_cleared::int) as phases_cleared,
         (t.finished_at is not null) as finished,
         extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                             - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s
    from teams t
    join team_progress tp on tp.team_id = t.id
    join team_scores sc on sc.team_id = t.id
    join cases c on c.id = t.case_id
    left join culprit_submission cs on cs.team_id = t.id
   order by sc.total_pts desc,
            (case when cs.is_correct then cs.submitted_at end) asc nulls last,
            t.finished_at asc nulls last,
            t.started_at asc
   limit 200`;

export async function GET() {
  return api(async () => {
    const r = await query(LEADERBOARD_SQL);
    return json({ teams: r.rows.map((row, i) => ({ rank: i + 1, ...row })) });
  });
}
