import { query } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";

// Public live standings per track (PRD 12). Nothing here is a credential: no team codes, ids or case passwords.
// Order: total points DESC, then the earliest completion of the final deduction (both components resolved), then the
// earliest of the last component the team did resolve, then earliest start. Teams still working rank by points alone.
const LEADERBOARD_SQL = `
  select substr(md5(t.id::text || t.realtime_token), 1, 12) as ref, t.team_name, c.title as case_title, c.game_track as track,
         tp.state, sc.total_pts,
         (tp.phase1_cleared::int + tp.phase2_cleared::int + tp.phase3_cleared::int) as phases_cleared,
         (t.finished_at is not null) as finished,
         extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                             - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s
    from teams t
    join team_progress tp on tp.team_id = t.id
    join team_scores sc on sc.team_id = t.id
    join cases c on c.id = t.case_id
   where ($1::text is null or c.game_track = $1)
   order by sc.total_pts desc,
            t.finished_at asc nulls last,
            (select max(f.resolved_at) from team_final_completions f where f.team_id = t.id) asc nulls last,
            t.started_at asc
   limit 200`;

export async function GET(req: Request) {
  return api(async () => {
    const raw = new URL(req.url).searchParams.get("track");
    const track = raw === null ? null : raw.toUpperCase();
    if (track !== null && track !== "SQL" && track !== "LOGIC") throw new HttpError(400, "track must be SQL or LOGIC");
    const r = await query(LEADERBOARD_SQL, [track]);
    return json({ track, teams: r.rows.map((row, i) => ({ rank: i + 1, ...row })) });
  });
}
