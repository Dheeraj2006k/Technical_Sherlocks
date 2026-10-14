import { query } from "@/lib/db";
import { api, HttpError, json, readBody } from "@/lib/http";
import { requireSession } from "@/lib/session";

// Guided-tour state (PRD 17.2). It belongs to the PLAYER, not the team: two teammates can finish or skip their tours
// independently. It is deliberately separate from every game table: it touches only players.tour_state and never a score,
// hint, phase, task, assignment or unlock, and it works while the game is paused. A deliberate skip is stored as a
// dismissal so a refresh never relaunches the tour; the Help menu can always reopen it.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    const body = await readBody(req);
    const state = body.state;
    if (state !== "completed" && state !== "dismissed") throw new HttpError(400, "state must be completed or dismissed");
    await query("update players set tour_state = $2, tour_updated_at = now() where id = $1", [s.player_id, state]);
    return json({ ok: true, tour_state: state });
  });
}
