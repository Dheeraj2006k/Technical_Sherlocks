import { audit, requireAdmin } from "@/lib/admin";
import { formatCode, generateRegistrationRef, normalizeCode } from "@/lib/codes";
import { query, withTx } from "@/lib/db";
import { api, HttpError, json, readBody, str } from "@/lib/http";

const LIST_SQL = `
  select r.id, r.registration_ref, r.team_ref, r.team_size, r.registration_status, r.created_at,
         a.id as assignment_id, a.status as assignment_status, a.assigned_at, a.assigned_by,
         c.case_code, c.title as case_title, c.game_track as track,
         t.team_code, tp.state as team_state, sc.total_pts,
         (select count(*)::int from players p where p.team_id = t.id) as players_joined
    from registrations r
    left join team_case_assignments a on a.registration_id = r.id and a.status in ('assigned', 'started', 'completed')
    left join cases c on c.id = a.case_id
    left join teams t on t.registration_id = r.id
    left join team_progress tp on tp.team_id = t.id
    left join team_scores sc on sc.team_id = t.id
   order by r.created_at desc, r.team_ref
   limit 1000`;

export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const r = await query(LIST_SQL);
    return json({
      registrations: r.rows.map((x) => ({
        ...x,
        registration_ref: formatCode(x.registration_ref),
        team_code: x.team_code ? formatCode(x.team_code) : null,
      })),
    });
  });
}

// Create registrations: { registrations: [{ team_ref, team_size }] } (up to 200 per call). References are generated here
// and returned for the organizer to hand out; they are the heads' join credential.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const list = body.registrations;
    if (!Array.isArray(list) || list.length === 0 || list.length > 200) throw new HttpError(400, "registrations must be a list of 1-200 teams");
    // A row may carry its own reference (import of references that were already handed out); otherwise one is generated.
    const rows = list.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const size = Number(o.team_size ?? 3);
      if (!Number.isInteger(size) || size < 1 || size > 3) throw new HttpError(400, "team_size must be 1, 2 or 3");
      let given: string | null = null;
      if (o.registration_ref !== undefined && o.registration_ref !== null && o.registration_ref !== "") {
        given = normalizeCode(o.registration_ref, 8);
        if (!given) throw new HttpError(400, "registration_ref must be 8 characters from 0-9 and A-Z (no I, L, O, U)");
      }
      return { team_ref: str(o.team_ref, "team_ref", 60), team_size: size, given };
    });
    const created = await withTx(async (tx) => {
      const out: { id: string; registration_ref: string; team_ref: string; team_size: number }[] = [];
      for (const row of rows) {
        for (let i = 0; i < 20; i++) {
          const ins = await tx.query(
            `insert into registrations (registration_ref, team_ref, team_size) values ($1, $2, $3)
             on conflict (registration_ref) do nothing returning id, registration_ref, team_ref, team_size`,
            [row.given ?? generateRegistrationRef(), row.team_ref, row.team_size],
          );
          if (!ins.rows[0] && row.given) throw new HttpError(409, `Registration reference ${formatCode(row.given)} is already in use`);
          if (ins.rows[0]) {
            out.push({ ...ins.rows[0], registration_ref: formatCode(ins.rows[0].registration_ref) });
            break;
          }
          if (i === 19) throw new Error("could not allocate a registration reference");
        }
      }
      await audit(tx, "registrations_created", { details: { count: out.length } });
      return out;
    });
    return json({ ok: true, registrations: created });
  });
}
