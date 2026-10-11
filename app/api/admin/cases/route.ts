import { requireAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { api, json } from "@/lib/http";

// The case catalogue for the assignment screen. Never includes answers or password hashes.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const r = await query(`
      select c.case_code, c.title, c.game_track as track, c.status, c.target_duration_minutes, c.content_version,
             (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status in ('assigned', 'started')) as active_assignments
        from cases c order by c.game_track, c.case_code`);
    return json({ cases: r.rows });
  });
}
