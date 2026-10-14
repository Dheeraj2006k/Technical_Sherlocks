// Idempotent, version-aware seeding of the Case Packs under cases/ into the database named by the env file.
//
//   node scripts/seed-cases.mjs                  seed every pack
//   node scripts/seed-cases.mjs --only SQL03     one case code
//   node scripts/seed-cases.mjs --dry-run        print what would happen (codes, versions, counts); change nothing
//
// What it does for each pack (one transaction per pack):
//   * unknown (code, version)   -> installs it as `draft` (configuration AND evidence), runs the full automated gate,
//                                  and on success records the validated hash and moves it to `review`.
//   * same content hash         -> nothing changes (idempotent); only the RLS gate is re-applied without rotating keys.
//   * changed content, version has teams or is tested/published
//                               -> REFUSED. Live content is immutable: bump content_version in manifest.json.
//   * changed content, version unused and draft/review/disabled
//                               -> the version's content is replaced in place (its password hash is kept).
// It never touches teams, players, scores, attempts, hints used, registrations or assignments, never publishes, and never
// resets anything. Publishing is `scripts/case-lifecycle.mjs`; resetting a team is an audited admin action.
// A new version inherits the password hash of the previous version of the same code, so existing case credentials keep
// working; with no previous version it gets an unrecoverable random password (use gen-case-credentials to issue one).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { PACKS } from './cases/index.mjs';
import { structuralChecks, CATALOGUE_CODES } from './cases/pack.mjs';
import { applySeed, planSeed } from './lib/seeder.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx > -1 ? args[onlyIdx + 1]?.toUpperCase() : null;
const dryRun = args.includes('--dry-run');

if (only && !CATALOGUE_CODES.includes(only)) {
  console.error(`--only must be one of ${CATALOGUE_CODES.join(', ')}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to seed a REMOTE database (${target.host}). Set SLC_ALLOW_REMOTE_DB=1 for this one command once the migration plan is approved.`);
  process.exit(2);
}
console.log(`${dryRun ? 'DRY RUN, ' : ''}seeding into: ${target.local ? 'local database' : target.host}`);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let failed = false;
try {
  const have = (await client.query("select count(*)::int as v from information_schema.columns where table_name = 'cases' and column_name = 'content_hash'")).rows[0];
  if (have.v === 0) throw new Error('migration 010 has not been applied (cases.content_hash is missing): run npm run db:migrate first');

  for (const pack of PACKS) {
    const code = pack.manifest?.case_code ?? pack.folder;
    if (only && code !== only) continue;
    const version = pack.manifest?.content_version;
    const problems = structuralChecks(pack).filter((c) => !c.ok);
    if (problems.length || !pack.def) {
      failed = true;
      console.log(`INVALID  ${code} v${version}: ${problems.length} structural problem(s), nothing written`);
      for (const c of problems.slice(0, 8)) console.log(`         - ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
      continue;
    }
    const def = pack.def;
    const rows = def.tables.reduce((n, t) => n + t.rows.length, 0);
    const summary = `${def.tables.length} tables, ${rows} evidence rows, ${def.threads.length} threads, ${def.threads.reduce((n, t) => n + t.questions.length, 0)} questions`;
    const plan = await planSeed(client, pack);
    console.log(`${plan.action.toUpperCase().padEnd(9)}${code} v${version} (${def.slug}) ${summary}${plan.existing ? `, status ${plan.existing.status}, ${plan.teams} team(s) pinned` : ''}`);
    if (plan.action === 'blocked') {
      failed = true;
      console.log(`         content changed but this version is ${plan.teams > 0 ? 'pinned by live teams' : plan.existing.status}; bump content_version in cases/${pack.folder}/manifest.json`);
      continue;
    }
    if (dryRun) continue;
    await client.query('begin');
    try {
      const r = await applySeed(client, pack, plan);
      await client.query('commit');
      if (r.action !== 'unchanged') {
        console.log(`         ${r.checks} automated checks, ${r.failed.length ? 'FAILED: left in draft' : 'passed: now in review (awaiting human review and blind playtest)'}`);
        for (const b of r.failed) console.log(`         - ${b.label}: ${b.detail}`);
        if (r.failed.length) failed = true;
      }
    } catch (e) {
      await client.query('rollback').catch(() => {});
      failed = true;
      console.error(`FAILED   ${code} v${version}: ${e.message}`);
    }
  }
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
