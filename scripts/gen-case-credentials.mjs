// Generates NEW case passwords (12 readable characters). Stores only the bcrypt hash; prints each code + password ONCE to
// the terminal. Nothing is written to a file or log, so copy them now: a password cannot be recovered (re-run to regenerate;
// the old one stops working immediately).
//
//   node scripts/gen-case-credentials.mjs SQL03            new password for one case
//   node scripts/gen-case-credentials.mjs --all            new passwords for the newest non-disabled version of every case
//   add --version N to target one content version of one case
//   add --publish to also publish (only a `tested` version of a pack-managed case; the database enforces the gates)
//
// DO NOT run this just to test: it invalidates the password the organizers already hold. New content versions inherit the
// previous version's password automatically (scripts/seed-cases.mjs); issue a new password only for a case that has none.
// Case CODES (SQL01..SQL05, LOG01..LOG05) are fixed catalogue codes and are never changed here.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { randomPassword } from './lib/codes.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const all = args.includes('--all');
const verIdx = args.indexOf('--version');
const version = verIdx > -1 ? Number(args[verIdx + 1]) : null;
const code = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--version')?.toUpperCase();
if (!all && !code) {
  console.error('usage: node scripts/gen-case-credentials.mjs <CASE_CODE | --all> [--publish]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to change passwords on a REMOTE database (${target.host}); set SLC_ALLOW_REMOTE_DB=1 for this one command to allow.`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const rows = [];
try {
  const found = await client.query(
    `select id, case_code, title, status, content_version, content_hash from cases c
      where ($1::text is null or case_code = $1) and ($2::int is null or content_version = $2)
        and ($2::int is not null or content_version = (select max(content_version) from cases d where d.case_code = c.case_code and d.status <> 'disabled'))
      order by case_code`,
    [all ? null : code, version],
  );
  if (found.rowCount === 0) {
    console.error('case not found');
    process.exit(1);
  }
  for (const c of found.rows) {
    if (publish && !['tested', 'published'].includes(c.status)) {
      console.error(`skipping ${c.case_code} v${c.content_version}: status is ${c.status}; only a tested version can be published (see scripts/case-lifecycle.mjs)`);
      continue;
    }
    const password = randomPassword();
    const hash = await bcrypt.hash(password, 10);
    await client.query('begin');
    try {
      await client.query('update cases set password_hash = $2 where id = $1', [c.id, hash]);
      if (publish && c.status !== 'published') await client.query("select transition_case_status($1, 'published', 'gen-case-credentials')", [c.id]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      console.error(`skipping ${c.case_code} v${c.content_version}: ${e.message}`);
      continue;
    }
    rows.push({ code: c.case_code, title: c.title, password, status: publish ? 'published' : c.status });
  }
} finally {
  await client.end();
}
for (const r of rows) console.log(`${r.code.padEnd(7)} ${r.password}  ${r.status.padEnd(9)} ${r.title}`);
if (rows.length) console.log('Shown once. Not stored anywhere in readable form.');
