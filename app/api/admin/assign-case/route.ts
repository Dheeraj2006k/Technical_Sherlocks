import { after } from "next/server";
import { audit, ADMIN_ACTOR, requireAdmin } from "@/lib/admin";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody, uuid } from "@/lib/http";
import { normalizeCaseCode } from "@/lib/codes";
import { assignability } from "@/lib/caseEligibility";
import { pingTeam } from "@/lib/realtime";

// Manual assignment (PRD 4): the organizer chooses the case for a registration. Reassigning is allowed until the team has
// started investigating; after that the organizer must reset the team first (which is audited). The head's join
// credentials are then the registration reference, this case's code and its password.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const registrationId = uuid(body.registration_id, "registration_id");
    // Exact version: the UI sends case_id. A bare case_code is accepted only when exactly one version of it is published.
    const wantedId = body.case_id === undefined || body.case_id === null ? null : uuid(body.case_id, "case_id");
    const code = body.case_code === undefined || body.case_code === null ? null : normalizeCaseCode(body.case_code);
    if (!wantedId && !code) throw new HttpError(400, "Choose a case");

    let pinged: string | null = null;
    const out = await withTx(async (tx) => {
      const reg = await tx.query("select id, registration_status from registrations where id = $1 for update", [registrationId]);
      if (!reg.rows[0]) throw new HttpError(404, "Registration not found");
      if (reg.rows[0].registration_status === "withdrawn") throw new HttpError(409, "This registration was withdrawn");
      const cols = "id, case_code, status, game_track, content_version, (content_hash is not null) as hashed, (content_hash is not null and tested_hash = content_hash) as tested";
      let c;
      if (wantedId) {
        c = await tx.query(`select ${cols} from cases where id = $1`, [wantedId]);
        if (code && c.rows[0] && c.rows[0].case_code !== code) throw new HttpError(400, "case_id and case_code disagree");
      } else {
        c = await tx.query(`select ${cols} from cases where case_code = $1 and status = 'published' order by content_version desc`, [code]);
        if (c.rows.length > 1) throw new HttpError(409, "More than one version of that case is published; choose the exact version");
        if (!c.rows[0]) {
          const any = await tx.query("select count(*)::int n from cases where case_code = $1", [code]);
          throw new HttpError(any.rows[0].n ? 409 : 404, any.rows[0].n ? "No published version of that case: only published, eligible versions can be assigned" : "Case not found");
        }
      }
      if (!c.rows[0]) throw new HttpError(404, "Case not found");
      const elig = assignability(c.rows[0]);
      if (!elig.ok) throw new HttpError(409, `${c.rows[0].case_code} v${c.rows[0].content_version} cannot be assigned. ${elig.reason}`);
      const caseId: string = c.rows[0].id;

      const team = await tx.query(
        "select t.id, tp.state from teams t join team_progress tp on tp.team_id = t.id where t.registration_id = $1 for update of t",
        [registrationId],
      );
      const existing = team.rows[0];
      if (existing && existing.state !== "WAITING") throw new HttpError(409, "That team has already started. Reset the team before reassigning.");

      const prev = await tx.query(
        "update team_case_assignments set status = 'cancelled', updated_at = now() where registration_id = $1 and status in ('assigned', 'started') returning case_id",
        [registrationId],
      );
      await tx.query(
        "insert into team_case_assignments (registration_id, case_id, team_id, assigned_by) values ($1, $2, $3, $4)",
        [registrationId, caseId, existing?.id ?? null, ADMIN_ACTOR],
      );
      if (existing) {
        await tx.query("update teams set case_id = $2 where id = $1", [existing.id, caseId]);
        pinged = existing.id;
      }
      await audit(tx, prev.rows[0] ? "case_reassigned" : "case_assigned", {
        registration_id: registrationId,
        team_id: existing?.id ?? null,
        case_id: caseId,
        details: { case_code: c.rows[0].case_code, content_version: c.rows[0].content_version, previous_case_id: prev.rows[0]?.case_id ?? null },
      });
      return { track: c.rows[0].game_track as string, reassigned: Boolean(prev.rows[0]), case_code: c.rows[0].case_code as string, content_version: c.rows[0].content_version as number };
    });
    if (pinged) after(() => pingTeam(pinged as string));
    return json({ ok: true, ...out });
  });
}
