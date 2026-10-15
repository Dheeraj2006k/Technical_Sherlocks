// Retires cases that are no longer part of the twelve-case catalogue (SQL01-SQL06, LOG01-LOG06): the former generated
// SQL07-SQL10, LOG07-LOG10 and the SH3R10CK stub. They are set to `disabled`, so they cannot be assigned or newly joined, and NOTHING is
// deleted: teams, assignments, attempts and scores that exist stay exactly as they are and keep working.
//
//   node scripts/retire-legacy-cases.mjs            dry run (lists what would be disabled)
//   node scripts/retire-legacy-cases.mjs --apply    performs it, with an admin_audit row per case
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { CATALOGUE_CODES } from './cases/pack.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const apply = process.argv.includes('--apply');
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
              (select count(*)::int from teams t where t.case_id = c.id) as teams,
              (select count(*)::int from team_case_assignments a where a.case_id = c.id and a.status in ('assigned', 'started')) as open_assignments
         from cases c where c.status <> 'disabled' and not (c.case_code = any($1)) order by c.case_code, c.content_version`,
      [CATALOGUE_CODES],
    )
  ).rows;
  console.log(`${apply ? 'Retiring' : 'Would retire'} ${rows.length} case(s) outside the catalogue (nothing is deleted):`);
  for (const r of rows) console.log(`  ${r.case_code} v${r.content_version}  was ${r.status}  ${r.teams} team(s) keep playing, ${r.open_assignments} open assignment(s)`);
  if (apply && rows.length) {
    await client.query('begin');
    for (const r of rows) {
      await client.query("update cases set status = 'disabled' where id = $1", [r.id]);
      await client.query("insert into admin_audit (action, actor, case_id, details) values ('case_retired', 'retire-legacy-cases', $1, $2)", [r.id, JSON.stringify({ case_code: r.case_code, content_version: r.content_version, was: r.status })]);
    }
    await client.query('commit');
    console.log('done');
  }
  const open = rows.filter((r) => r.open_assignments > 0);
  if (open.length) console.log(`NOTE: ${open.length} unstarted assignment(s) point at a retired case; the organizer must reassign those registrations.`);
} finally {
  await client.end();
}
