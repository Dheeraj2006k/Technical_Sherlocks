// Retires cases that are no longer part of the twelve-case catalogue (SQL01-SQL06, LOG01-LOG06): the former generated
// SQL07-SQL10, LOG07-LOG10 and the SH3R10CK stub. They are set to `disabled`, so they cannot be assigned or newly joined, and NOTHING is
// deleted: teams, assignments, attempts and scores that exist stay exactly as they are and keep working.
//
//   node scripts/retire-legacy-cases.mjs            dry run (lists what would be disabled)
//   node scripts/retire-legacy-cases.mjs --only=CODE,CODE   limit either mode to these case codes
//   node scripts/retire-legacy-cases.mjs --apply    performs it, with an admin_audit row per case
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { CATALOGUE_CODES } from './cases/pack.mjs';
import { planRetirement } from './lib/retire.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const apply = process.argv.includes('--apply');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null; // limit the plan to these case codes
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing a REMOTE database (${target.host}) without SLC_ALLOW_REMOTE_DB=1.`);
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const rows = (
    await client.query(
      `select c.id, c.case_code, c.content_version, c.status,
              (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status in ('assigned', 'started')) as open_assignments,
              (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status = 'cancelled') as cancelled_assignments,
              (select count(*)::int from teams t left join team_progress tp on tp.team_id = t.id where t.case_id = c.id and coalesce(tp.state, 'WAITING') <> 'FINISHED') as live_teams,
              exists (select 1 from cases n where n.case_code = c.case_code and n.content_version >= 2 and n.status = 'published') as published_v2
         from cases c where c.status <> 'disabled' order by c.case_code, c.content_version`,
    )
  ).rows;
  const { retire, keep } = planRetirement(only ? rows.filter((r) => only.includes(r.case_code)) : rows, CATALOGUE_CODES);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${retire.length} version(s) can be retired, ${keep.length} must be kept as they are. Nothing is deleted; retiring only sets status = disabled.`);
  console.log('\nCAN BE RETIRED (no open assignment, no unfinished team, not the last assignable version of a catalogue code):');
  for (const r of retire) console.log(`  ${r.case_code} v${r.content_version}  ${r.status} -> disabled${r.note ? `  (${r.note})` : ''}`);
  console.log('\nPROTECTED (left exactly as they are):');
  for (const r of keep) console.log(`  ${r.case_code} v${r.content_version}  stays ${r.status}: ${r.reasons.join('; ')}`);
  if (apply && retire.length) {
    await client.query('begin');
    let changed = 0;
    for (const r of retire) {
      // re-check inside the transaction so a registration assigned a moment ago is never broken
      const again = await client.query("select c.status, (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status in ('assigned', 'started')) as open from cases c where c.id = $1 for update of c", [r.id]);
      if (again.rows[0].status === 'disabled' || again.rows[0].open > 0) continue;
      await client.query("update cases set status = 'disabled' where id = $1", [r.id]);
      await client.query("insert into admin_audit (action, actor, case_id, details) values ('case_retired', 'retire-legacy-cases', $1, $2)", [r.id, JSON.stringify({ case_code: r.case_code, content_version: r.content_version, was: r.status })]);
      changed++;
    }
    await client.query('commit');
    console.log(`\nretired ${changed} version(s)`);
  } else if (!apply) {
    console.log('\nDry run only: re-run with --apply to retire the first list.');
  }
} finally {
  await client.end();
}
