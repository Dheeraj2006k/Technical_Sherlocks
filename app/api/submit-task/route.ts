import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { submitTask } from "@/lib/engine";
import { api, json, readBody, str, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

// Record an answer attempt, score it and process any progression: one transaction (lib/engine.ts).
// The team, case, phase, thread and points come from the session and the database, never from the request body.
// `idempotency_key` makes a duplicated HTTP request harmless; an intentional retry uses a new key.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const taskId = uuid(body.task_id, "task_id");
    const value = str(body.value, "value");
    const key = body.idempotency_key === undefined ? randomUUID() : str(body.idempotency_key, "idempotency_key", 100);

    const out = await submitTask(s, taskId, value, key);
    if (!out.replayed && !out.already_completed) after(() => pingTeam(s.team_id));
    return json({ ok: true, ...out });
  });
}
