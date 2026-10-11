import { requireAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { NextResponse } from "next/server";
import { api, HttpError } from "@/lib/http";

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralize spreadsheet formula injection from user-controlled text (team names).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

// Results export for the organizers: per-track ranking (same ordering as /api/leaderboard) with the score breakdown.
// ?track=SQL|LOGIC limits it to one track.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const raw = new URL(req.url).searchParams.get("track");
    const track = raw === null ? null : raw.toUpperCase();
    if (track !== null && track !== "SQL" && track !== "LOGIC") throw new HttpError(400, "track must be SQL or LOGIC");
    const r = await query(
      `select c.game_track as track, t.team_name, reg.registration_ref, c.case_code, c.title as case_title,
              sc.total_pts, coalesce((sc.points_by_component ->> 'tasks')::int, 0) as question_pts,
              coalesce((sc.points_by_component ->> 'culprit')::int, 0) as responsibility_pts,
              coalesce((sc.points_by_component ->> 'mechanism')::int, 0) as explanation_pts,
              coalesce((sc.points_by_component ->> 'penalties')::int, 0) as penalty_pts,
              (select count(*)::int from team_hint_usage h where h.team_id = t.id) as hints_used,
              t.started_at, t.finished_at,
              (select max(f.resolved_at) from team_final_completions f where f.team_id = t.id) as last_final_resolved_at,
              extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                                  - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s
         from teams t
         join team_scores sc on sc.team_id = t.id
         join cases c on c.id = t.case_id
         left join registrations reg on reg.id = t.registration_id
        where ($1::text is null or c.game_track = $1)
        order by c.game_track, sc.total_pts desc, t.finished_at asc nulls last, t.started_at asc`,
      [track],
    );
    if (r.rows.length === 0) throw new HttpError(404, "No teams");
    const cols = Object.keys(r.rows[0]);
    const lines = [["rank", ...cols].join(",")];
    const seen: Record<string, number> = {};
    for (const row of r.rows) {
      const rank = (seen[row.track] = (seen[row.track] ?? 0) + 1);
      lines.push([rank, ...cols.map((c) => csv(row[c] instanceof Date ? row[c].toISOString() : row[c]))].join(","));
    }
    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="results.csv"', "Cache-Control": "no-store" },
    });
  });
}
