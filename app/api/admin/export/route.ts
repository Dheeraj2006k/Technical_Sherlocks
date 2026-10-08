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

// Leaderboard export (same ordering as /api/leaderboard) for the organizers.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const r = await query(`
      select t.team_name, c.title as case_title, sc.total_pts, sc.phase1_pts, sc.phase2_pts, sc.phase3_pts, sc.culprit_pts,
             t.started_at, t.finished_at, cs.submitted_at as culprit_submitted_at, cs.is_correct as culprit_correct,
             extract(epoch from (coalesce(t.finished_at, now()) - t.started_at - t.paused_total
                                 - coalesce(now() - t.paused_at, interval '0')))::int as elapsed_s
        from teams t
        join team_scores sc on sc.team_id = t.id
        join cases c on c.id = t.case_id
        left join culprit_submission cs on cs.team_id = t.id
       order by sc.total_pts desc, (case when cs.is_correct then cs.submitted_at end) asc nulls last,
                t.finished_at asc nulls last, t.started_at asc`);
    if (r.rows.length === 0) throw new HttpError(404, "No teams");
    const cols = Object.keys(r.rows[0]);
    const lines = [["rank", ...cols].join(",")];
    r.rows.forEach((row, i) => lines.push([i + 1, ...cols.map((c) => csv(row[c] instanceof Date ? row[c].toISOString() : row[c]))].join(",")));
    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="leaderboard.csv"', "Cache-Control": "no-store" },
    });
  });
}
