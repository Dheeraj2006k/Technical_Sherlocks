import { requireAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { api, json } from "@/lib/http";

export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const r = await query(`
      select a.id, a.created_at, a.action, a.actor, r.team_ref, c.case_code, a.details
        from admin_audit a
        left join registrations r on r.id = a.registration_id
        left join cases c on c.id = a.case_id
       order by a.id desc limit 200`);
    return json({ entries: r.rows });
  });
}
