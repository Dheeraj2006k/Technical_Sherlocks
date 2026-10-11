import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { submitFinal } from "@/lib/engine";
import { api, HttpError, json, readBody, str, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

// Final deduction (PRD 8): component "culprit" (a character id of this case) or "mechanism" (an option id of this case).
// Wrong answers cost 2 points and can be retried; each component awards its points once; the team finishes when both
// are resolved. One transaction under the team's progress lock.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const component = body.component;
    if (component !== "culprit" && component !== "mechanism") throw new HttpError(400, "component must be culprit or mechanism");
    const value = uuid(body.value, "value");
    const key = body.idempotency_key === undefined ? randomUUID() : str(body.idempotency_key, "idempotency_key", 100);

    const out = await submitFinal(s, component, value, key);
    if (!out.replayed && !out.already_resolved) after(() => pingTeam(s.team_id));
    return json({ ok: true, ...out });
  });
}
