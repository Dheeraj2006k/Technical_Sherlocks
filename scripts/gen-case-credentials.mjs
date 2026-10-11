// Generates NEW case passwords (12 readable characters). Stores only the bcrypt hash; prints each code + password ONCE to
// the terminal. Nothing is written to a file or log, so copy them now: a password cannot be recovered (re-run to regenerate;
// the old one stops working immediately).
//
//   node scripts/gen-case-credentials.mjs SQL03            new password for one case
//   node scripts/gen-case-credentials.mjs --all            new passwords for all 20 cases
//   add --publish to also set status = 'published' (only cases that passed validation, status 'tested' or 'published')
//
// Case CODES (SQL01..SQL10, LOG01..LOG10) are fixed catalogue codes and are never changed here.
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
const code = args.find((a) => !a.startsWith('--'))?.toUpperCase();
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
  const found = await client.query(all ? 'select id, case_code, title, status from cases order by case_code' : 'select id, case_code, title, status from cases where case_code = $1', all ? [] : [code]);
  if (found.rowCount === 0) {
    console.error('case not found');
    process.exit(1);
  }
  for (const c of found.rows) {
    if (publish && !['tested', 'published'].includes(c.status)) {
      console.error(`skipping ${c.case_code}: status is ${c.status}; only validated (tested) cases can be published`);
      continue;
    }
    const password = randomPassword();
    const hash = await bcrypt.hash(password, 10);
    await client.query(`update cases set password_hash = $2${publish ? ", status = 'published'" : ''} where id = $1`, [c.id, hash]);
    rows.push({ code: c.case_code, title: c.title, password, status: publish ? 'published' : c.status });
  }
} finally {
  await client.end();
}
for (const r of rows) console.log(`${r.code.padEnd(7)} ${r.password}  ${r.status.padEnd(9)} ${r.title}`);
if (rows.length) console.log('Shown once. Not stored anywhere in readable form.');
