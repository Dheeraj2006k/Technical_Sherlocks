// Database-backed validation of every case pack without keeping anything: each case is installed under a scratch slug
// inside a transaction that is ALWAYS rolled back, then checked (scoring budget, structure, solo-solvability, evidence
// unlock rules, unique answers, hints, final deduction).
//   node scripts/verify-case.mjs [--only SQL03]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { DEFINITIONS } from './cases/index.mjs';
import { installCase, verifyDefinition } from './cases/engine.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1].toUpperCase() : null;
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to run against a REMOTE database (${target.host}); set SLC_ALLOW_REMOTE_DB=1 to allow. (Everything is rolled back, but it still writes inside a transaction.)`);
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let failed = 0;
let count = 0;
try {
  for (const [i, def] of DEFINITIONS.entries()) {
    if (only && def.code !== only) continue;
    count++;
    await client.query('begin');
    try {
      const installed = await installCase(client, def, { slug: `vfy${i}`, caseCode: `VFY${String(i).padStart(2, '0')}`, password: 'x', bcryptCost: 4, contentHash: def.contentHash });
      const results = await verifyDefinition(client, def, installed);
      const bad = results.filter((r) => !r.ok);
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${def.code} ${def.title} (${results.length} checks)`);
      for (const b of bad) console.log(`       - ${b.label}: ${b.detail}`);
      failed += bad.length;
    } finally {
      await client.query('rollback');
    }
  }
} finally {
  await client.end();
}
console.log(failed ? `${failed} check(s) failed` : `all ${count} cases verified`);
process.exit(failed ? 1 : 0);
