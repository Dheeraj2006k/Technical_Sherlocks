import { after } from "next/server";
import { assignThread } from "@/lib/engine";
import { api, json, readBody, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { requireSession } from "@/lib/session";

// Head: assign or reassign any available thread to any teammate. Investigator: take an unassigned thread.
// Assignment is only a convenience: nothing in the game ever requires more than one player.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    const body = await readBody(req);
    const threadId = uuid(body.thread_id, "thread_id");
    const target = body.player_id === undefined ? null : uuid(body.player_id, "player_id");
    await assignThread(s, threadId, target);
    after(() => pingTeam(s.team_id));
    return json({ ok: true });
  });
}
