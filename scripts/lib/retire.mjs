// Pure planner for retiring legacy case versions. A version is retired (status -> disabled, never deleted) only when it is
// provably safe; every other version is PROTECTED with the reason. Disabling never alters assignments, teams or history, but
// a not-yet-started registration assigned to a disabled version can no longer start, so those are protected.
//
// row: { id, case_code, content_version, status, open_assignments, live_teams, finished_teams, cancelled_assignments, published_v2 }
//   open_assignments: assignments in status assigned/started; live_teams: teams whose progress is not FINISHED (or has none)
//   published_v2: a canonical (content_version >= 2) version of the same code is published
export function planRetirement(rows, catalogueCodes) {
  const keep = [];
  const retire = [];
  for (const r of rows) {
    const reasons = [];
    const inCatalogue = catalogueCodes.includes(r.case_code);
    if (inCatalogue && r.content_version >= 2) continue; // the canonical catalogue itself is never a retirement candidate
    if (r.open_assignments > 0) reasons.push(`${r.open_assignments} open assignment(s) (assigned/started) still point at it`);
    if (r.live_teams > 0) reasons.push(`${r.live_teams} team(s) not yet finished are pinned to it`);
    if (inCatalogue && !r.published_v2) reasons.push(`its code is in the catalogue but no v2 is published yet, so retiring it would leave nothing assignable`);
    (reasons.length ? keep : retire).push({ ...r, reasons, note: r.cancelled_assignments > 0 ? `${r.cancelled_assignments} cancelled assignment(s) keep their history` : null });
  }
  return { retire, keep };
}
