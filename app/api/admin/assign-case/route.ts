import { after } from "next/server";
import { audit, ADMIN_ACTOR, requireAdmin } from "@/lib/admin";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody, uuid } from "@/lib/http";
import { normalizeCaseCode } from "@/lib/codes";
import { pingTeam } from "@/lib/realtime";

// Manual assignment (PRD 4): the organizer chooses the case for a registration. Reassigning is allowed until the team has
// started investigating; after that the organizer must reset the team first (which is audited). The head's join
// credentials are then the registration reference, this case's code and its password.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const registrationId = uuid(body.registration_id, "registration_id");
    const code = normalizeCaseCode(body.case_code);
    if (!code) throw new HttpError(400, "Invalid case code");

    let pinged: string | null = null;
    const out = await withTx(async (tx) => {
      const reg = await tx.query("select id, registration_status from registrations where id = $1 for update", [registrationId]);
      if (!reg.rows[0]) throw new HttpError(404, "Registration not found");
      if (reg.rows[0].registration_status === "withdrawn") throw new HttpError(409, "This registration was withdrawn");
      // the newest version of the code, preferring the published one: draft / review / tested / disabled versions never qualify
      const c = await tx.query(
        "select id, status, game_track, content_version from cases where case_code = $1 order by (status = 'published') desc, content_version desc limit 1",
        [code],
      );
      if (!c.rows[0]) throw new HttpError(404, "Case not found");
      if (c.rows[0].status !== "published") throw new HttpError(409, `That case is ${c.rows[0].status}; only published cases can be assigned`);
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
        details: { case_code: code, content_version: c.rows[0].content_version, previous_case_id: prev.rows[0]?.case_id ?? null },
      });
      return { track: c.rows[0].game_track as string, reassigned: Boolean(prev.rows[0]) };
    });
    if (pinged) after(() => pingTeam(pinged as string));
    return json({ ok: true, case_code: code, ...out });
  });
}
