// Generates NEW credentials for a case: a case_code (XXXX-XXXX) and a 12-char password.
// Stores the code and the bcrypt hash of the password; prints code + password ONCE to the
// terminal. Nothing is written to a file or log, so copy them now: the password cannot be
// recovered (re-run to regenerate both; the old ones stop working immediately).
//
//   node scripts/gen-case-credentials.mjs <case-uuid | current-case-code> [--live]
//   --live also sets status = 'live' so the case becomes joinable.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';
import { randomCaseCode, randomPassword, formatCode, normalizeCode } from './lib/codes.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

const arg = process.argv[2];
const goLive = process.argv.includes('--live');
if (!arg) {
  console.error('usage: node scripts/gen-case-credentials.mjs <case-uuid | current-case-code>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
const byCode = normalizeCode(arg, 8);
if (!isUuid && !byCode) {
  console.error('argument must be a case UUID or an 8-character case code');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
let result;
try {
  const found = await client.query(
    isUuid ? 'select id, title from cases where id = $1' : 'select id, title from cases where case_code = $1',
    [isUuid ? arg.toLowerCase() : byCode],
  );
  if (found.rowCount !== 1) {
    console.error('case not found');
    process.exit(1);
  }
  const { id, title } = found.rows[0];
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);

  for (let i = 0; i < 20 && !result; i++) {
    const code = randomCaseCode();
    const u = await client.query(
      `update cases set case_code = $2, password_hash = $3${goLive ? ", status = 'live'" : ''} where id = $1 and not exists (select 1 from cases where case_code = $2) returning id`,
      [id, code, hash],
    );
    if (u.rowCount === 1) result = { title, code, password };
  }
  if (!result) {
    console.error('could not allocate a unique case code');
    process.exitCode = 1;
  }
} finally {
  await client.end();
}

if (result) {
  console.log(`Case:      ${result.title}`);
  console.log(`Case code: ${formatCode(result.code)}`);
  console.log(`Password:  ${result.password}`);
  console.log('Shown once. Not stored anywhere in readable form.');
}
