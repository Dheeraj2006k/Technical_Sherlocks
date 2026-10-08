import { after } from "next/server";
import { withTx } from "@/lib/db";
import { api, HttpError, json, readBody, uuid } from "@/lib/http";
import { pingTeam } from "@/lib/realtime";
import { assertActive, requireSession } from "@/lib/session";

const CULPRIT_POINTS = 40;

// Final deduction: one shot per team. Grading, the 40 points, the FINISHED transition and finished_at all
// happen in ONE transaction under the team's progress-row lock; UNIQUE(team_id) makes a replay a hard no-op.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const chosen = uuid(body.character_id, "character_id");

    const out = await withTx(async (tx) => {
      const pr = await tx.query("select state from team_progress where team_id = $1 for update", [s.team_id]);
      if (!pr.rows[0]) throw new HttpError(401, "Session no longer valid");
      const state: string = pr.rows[0].state;
      if (state === "FINISHED") throw new HttpError(409, "Your team has already submitted its culprit.");
      if (state !== "FINAL_DEDUCTION") throw new HttpError(409, "The final deduction isn't unlocked yet.");

      const ch = await tx.query("select 1 from characters where id = $1 and case_id = $2", [chosen, s.case_id]);
      if (!ch.rows[0]) throw new HttpError(404, "Unknown character");

      const c = await tx.query("select culprit_character_id from cases where id = $1", [s.case_id]);
      const correct = c.rows[0]?.culprit_character_id === chosen;

      const ins = await tx.query(
        `insert into culprit_submission (team_id, chosen_character_id, is_correct) values ($1, $2, $3)
         on conflict (team_id) do nothing returning submitted_at`,
        [s.team_id, chosen, correct],
      );
      if (ins.rowCount === 0) throw new HttpError(409, "Your team has already submitted its culprit.");

      await tx.query("update team_progress set state = 'FINISHED' where team_id = $1", [s.team_id]);
      await tx.query("update teams set finished_at = now() where id = $1", [s.team_id]);
      if (correct) {
        await tx.query(
          "update team_scores set culprit_pts = $2, total_pts = total_pts - culprit_pts + $2 where team_id = $1",
          [s.team_id, CULPRIT_POINTS],
        );
      }
      const sc = await tx.query("select total_pts from team_scores where team_id = $1", [s.team_id]);
      let solution: unknown = null;
      if (correct) {
        const r = await tx.query(
          `select (select name from characters where id = c.culprit_character_id) as culprit,
                  c.solution_motive as motive, c.solution_method as method, coalesce(c.solution_chain, '[]'::jsonb) as chain
             from cases c where c.id = $1`,
          [s.case_id],
        );
        solution = r.rows[0] ?? null; // the resolution is revealed ONLY to a team that named the culprit
      }
      return { correct, state: "FINISHED", total_pts: sc.rows[0].total_pts as number, solution };
    });
    after(() => pingTeam(s.team_id));
    return json({ ok: true, ...out });
  });
}
