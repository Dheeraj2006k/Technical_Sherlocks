import { after } from "next/server";
import { openHint } from "@/lib/engine";
import { api, HttpError, json, readBody, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

// Open the team's next hint for a question. Hints are shared: every teammate sees it and its cost applies to the
// team's reward for that question. Opening an already-open hint cannot cost anything twice.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const pos = body.position === undefined ? undefined : Number(body.position);
    if (pos !== undefined && (!Number.isInteger(pos) || pos < 1 || pos > 10)) throw new HttpError(400, "position must be a whole number from 1 to 10");
    const out = await openHint(s, uuid(body.task_id, "task_id"), pos);
    if (!out.already_open) after(() => pingTeam(s.team_id));
    return json({ ok: true, ...out });
  });
}
