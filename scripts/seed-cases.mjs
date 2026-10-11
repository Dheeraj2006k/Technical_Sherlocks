// Installs all 20 cases (SQL01-SQL10, LOG01-LOG10) into the database named by the env file (idempotent: re-running
// replaces each case, its evidence schema, its assignments and any teams that played it).
//
//   node scripts/seed-cases.mjs                  install all 20
//   node scripts/seed-cases.mjs --only SQL03     install one case by code (or slug)
//
// Each case is installed as 'draft' with an unrecoverable random password, validated in the same transaction, and
// promoted to 'tested' only if EVERY machine check passes (a failing case stays draft and the script exits non-zero).
// 'published' is a deliberate organizer step: node scripts/gen-case-credentials.mjs <CODE> --publish
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { DEFINITIONS, caseIdFor } from './cases/index.mjs';
import { installCase, removeCaseFully, verifyDefinition } from './cases/engine.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1].toUpperCase() : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to seed a REMOTE database (${target.host}). Seeding replaces cases and deletes teams that played them.`);
  console.error('If you really mean to, set SLC_ALLOW_REMOTE_DB=1 for this one command.');
  process.exit(2);
}
console.log(`Seeding into: ${target.local ? 'local database' : target.host}`);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let failed = false;
try {
  for (const [i, def] of DEFINITIONS.entries()) {
    if (only && def.code !== only && def.slug.toUpperCase() !== only) continue;
    await client.query('begin');
    try {
      // replace by id, and also anything holding this slug or code under another id (an older seed)
      await removeCaseFully(client, caseIdFor(i));
      for (const r of (await client.query('select id from cases where slug = $1 or case_code = $2', [def.slug, def.code])).rows) await removeCaseFully(client, r.id);
      const r = await installCase(client, def, { id: caseIdFor(i), status: 'draft' });
      const checks = await verifyDefinition(client, def, r);
      const bad = checks.filter((c) => !c.ok);
      if (bad.length === 0) await client.query("update cases set status = 'tested' where id = $1", [r.caseId]);
      await client.query('commit');
      console.log(`${def.code}  ${def.slug.padEnd(20)} ${String(r.tasks.length).padStart(2)} questions  ${checks.length} checks  ${bad.length ? 'DRAFT (failed)' : 'tested'}`);
      for (const b of bad) console.log(`        - ${b.label}: ${b.detail}`);
      if (bad.length) failed = true;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      console.error(`FAILED ${def.code} ${def.slug}: ${e.message}`);
      failed = true;
    }
  }
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
