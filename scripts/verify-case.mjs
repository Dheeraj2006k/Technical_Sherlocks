// Mechanical validation of every case definition (the machine-checkable part of the PRD section 9
// checklist): each task's reference SQL yields exactly the intended unique answer using only tables
// unlocked by that phase, the culprit is isolated by the last task, structure is 3 x (easy/medium/hard).
// Each case is installed under a scratch slug inside a transaction that is ALWAYS rolled back.
//   node scripts/verify-case.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';
import { DEFINITIONS } from './cases/index.mjs';
import { installCase, verifyDefinition } from './cases/engine.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
let failed = 0;
try {
  for (const [i, def] of DEFINITIONS.entries()) {
    await client.query('begin');
    try {
      const installed = await installCase(client, def, { slug: `vfy${i}`, password: 'x', bcryptCost: 4 });
      const results = await verifyDefinition(client, def, installed);
      const bad = results.filter((r) => !r.ok);
      console.log(`${bad.length ? 'FAIL' : 'ok  '} ${def.title} (${results.length} checks)`);
      for (const b of bad) console.log(`       - ${b.label}: ${b.detail}`);
      failed += bad.length;
    } finally {
      await client.query('rollback');
    }
  }
} finally {
  await client.end();
}
console.log(failed ? `${failed} check(s) failed` : `all ${DEFINITIONS.length} cases verified`);
process.exit(failed ? 1 : 0);
