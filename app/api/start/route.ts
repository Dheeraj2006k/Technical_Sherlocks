import { after } from "next/server";
import { withTx } from "@/lib/db";
import { api, HttpError, json } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

// Head only. WAITING -> PHASE_1. Already started is a no-op (idempotent).
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    if (s.role !== "head") throw new HttpError(403, "Only the head can start the investigation");

    const state = await withTx(async (tx) => {
      const r = await tx.query("select state from team_progress where team_id = $1 for update", [s.team_id]);
      if (!r.rows[0]) throw new HttpError(401, "Session no longer valid");
      if (r.rows[0].state !== "WAITING") return r.rows[0].state as string;
      await tx.query("update team_progress set state = 'PHASE_1', current_phase = 1 where team_id = $1", [s.team_id]);
      return "PHASE_1";
    });
    after(() => pingTeam(s.team_id));
    return json({ ok: true, state });
  });
}
