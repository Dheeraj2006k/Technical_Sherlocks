import { requireAdmin } from "@/lib/admin";
import { withTx } from "@/lib/db";
import { normalizeCaseCode } from "@/lib/codes";
import { api, HttpError, json, readBody } from "@/lib/http";

// Publication controls (PRD Addendum 7): an organizer can publish a TESTED version or disable any version. Everything else
// on the lifecycle (draft -> review -> tested) needs the human review record and goes through scripts/case-lifecycle.mjs.
// The gates themselves live in the database function transition_case_status, so this route cannot skip one.
// Disabling stops NEW assignments only; teams already pinned to the version keep playing it.
export async function POST(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const body = await readBody(req);
    const code = normalizeCaseCode(body.case_code);
    const version = Number(body.content_version);
    const to = body.status;
    if (!code) throw new HttpError(400, "Invalid case code");
    if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "Invalid content version");
    if (to !== "published" && to !== "disabled") throw new HttpError(400, "Only published or disabled can be set here");

    const out = await withTx(async (tx) => {
      const c = await tx.query("select id, status from cases where case_code = $1 and content_version = $2 for update", [code, version]);
      if (!c.rows[0]) throw new HttpError(404, "Case version not found");
      try {
        await tx.query("select transition_case_status($1, $2, 'organizer')", [c.rows[0].id, to]);
      } catch (e) {
        const msg = (e as { message?: string }).message ?? "";
        if ((e as { code?: string }).code === "P0001") throw new HttpError(409, msg.replace(/^error: /i, ""));
        throw e;
      }
      return { from: c.rows[0].status as string };
    });
    return json({ ok: true, case_code: code, content_version: version, from: out.from, to });
  });
}
