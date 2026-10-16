import { requireAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { api, json } from "@/lib/http";
import { assignability, type EligibilityInput } from "@/lib/caseEligibility";

// The case catalogue for the assignment and publication screens: one row per (code, content version). Never includes
// answers, password hashes or review text.
export async function GET(req: Request) {
  return api(async () => {
    await requireAdmin(req);
    const r = await query(`
      select c.id, c.case_code, c.title, c.game_track as track, c.status, c.target_duration_minutes, c.content_version,
             (c.content_hash is not null and c.validated_hash = c.content_hash) as validated,
             (c.content_hash is not null and c.tested_hash = c.content_hash) as tested,
             (c.content_hash is not null) as hashed,
             coalesce(c.review_record->>'owner_exception', 'false') = 'true' as owner_exception,
             c.published_at,
             (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status in ('assigned', 'started')) as active_assignments,
             (select count(*)::int from teams t where t.case_id = c.id) as teams_pinned
        from cases c order by c.game_track, c.case_code, c.content_version desc`);
    // Eligibility is decided here, once, with the same rule the assignment API enforces (lib/caseEligibility.ts).
    const cases = r.rows.map((c) => {
      const e = assignability(c as unknown as EligibilityInput);
      const { hashed: _hashed, ...rest } = c; // internal flag; the response carries only the verdict
      void _hashed;
      return { ...rest, assignable: e.ok, reason: e.reason };
    });
    return json({ cases });
  });
}
