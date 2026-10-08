// Installs all 10 cases into the dev database (idempotent: re-running replaces each case, its clue
// schema, and any teams that played it).
//
//   node scripts/seed-cases.mjs                 install all 10
//   node scripts/seed-cases.mjs --only opening_night
//
// Every case starts as 'draft' (not joinable) with an unrecoverable random password. To make a case
// playable and get its credentials (shown once, never written anywhere):
//   node scripts/gen-case-credentials.mjs <case-uuid> --live
// Case ids are fixed: 00000000-0000-4000-8000-0000000000a1 .. 00000000-0000-4000-8000-0000000000aa
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';
import { DEFINITIONS } from './cases/index.mjs';
import { installCase, removeCaseFully } from './cases/engine.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;
const idFor = (i) => `00000000-0000-4000-8000-0000000000a${(i + 1).toString(16)}`;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
let failed = false;
try {
  for (const [i, def] of DEFINITIONS.entries()) {
    if (only && def.slug !== only) continue;
    await client.query('begin');
    try {
      await removeCaseFully(client, idFor(i));
      const r = await installCase(client, def, { id: idFor(i), status: 'draft' });
      await client.query('commit');
      console.log(`${idFor(i)}  ${def.slug.padEnd(24)} ${r.tasks.length} tasks, ${r.characters.length} characters  (draft)`);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error(`FAILED ${def.slug}: ${e.message}`);
      failed = true;
    }
  }
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
