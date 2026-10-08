import { requireAdmin } from "@/lib/admin";
import { normalizeCode } from "@/lib/codes";
import { after } from "next/server";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody } from "@/lib/http";
import { pingAllTeams, pingTeam } from "@/lib/realtime";

// Emergency pause. A paused team cannot query, submit answers, start, or finish, and its timer stops
// (elapsed time = now - started_at - paused_total - current pause). Nothing is lost on resume.
//   { scope: "global", paused }            every unfinished team (and teams created while paused)
//   { scope: "team", team_code, paused }   one team
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    if (typeof body.paused !== "boolean") throw new HttpError(400, "paused must be true or false");
    const paused = body.paused;
    let pinged: string | null = null;

    await withTx(async (tx) => {
      if (body.scope === "global") {
        await tx.query(
          "update game_control set paused = $1, paused_at = case when $1 then coalesce(paused_at, now()) else null end where id = 1",
          [paused],
        );
        if (paused) {
          await tx.query("update teams set paused_at = now() where paused_at is null and finished_at is null");
        } else {
          await tx.query(
            "update teams set paused_total = paused_total + (now() - paused_at), paused_at = null where paused_at is not null",
          );
        }
        return;
      }
      if (body.scope !== "team") throw new HttpError(400, "scope must be global or team");
      const code = normalizeCode(body.team_code, 6);
      if (!code) throw new HttpError(400, "Invalid team code");
      const r = await tx.query(
        paused
          ? "update teams set paused_at = now() where team_code = $1 and paused_at is null and finished_at is null returning id"
          : "update teams set paused_total = paused_total + (now() - paused_at), paused_at = null where team_code = $1 and paused_at is not null returning id",
        [code],
      );
      if (r.rows[0]) pinged = r.rows[0].id as string;
      if (r.rowCount === 0) {
        const exists = await tx.query("select 1 from teams where team_code = $1", [code]);
        if (!exists.rows[0]) throw new HttpError(404, "Team not found");
      }
    });
    after(() => (body.scope === "global" ? pingAllTeams() : pinged ? pingTeam(pinged) : undefined));
    return json({ ok: true, paused });
  });
}
