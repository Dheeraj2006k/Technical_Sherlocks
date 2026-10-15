// Moves a case VERSION along draft -> review -> tested -> published (or to disabled). Every move goes through the database
// function transition_case_status, which enforces the gates and writes an audit row.
//
//   node scripts/case-lifecycle.mjs SQL01 2 status            show the version's state (no change)
//   node scripts/case-lifecycle.mjs SQL01 2 tested            needs a human review + blind playtest recorded in review.json
//   node scripts/case-lifecycle.mjs SQL01 2 published         only the exact version that was validated AND tested
//   node scripts/case-lifecycle.mjs SQL01 2 disabled          no new assignments; teams already playing are unaffected
//   add --dry-run to print the decision without changing anything
//
// `tested` is only possible when cases/<CODE>-*/review.json records, for THIS content hash, a completed human review (with
// reviewer and date) and a completed blind playtest (with participant count). Nobody can be recorded automatically.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase, loadEnvLocal } from './lib/env.mjs';
import { PACKS } from './cases/index.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const [code, versionRaw, to, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
const version = Number(versionRaw);
if (!code || !Number.isInteger(version) || !to) {
  console.error('usage: node scripts/case-lifecycle.mjs <CODE> <content_version> <status|review|tested|published|disabled> [--dry-run]');
  process.exit(1);
}
const target = describeDatabase(process.env.DATABASE_URL);
if (!target.local && process.env.SLC_ALLOW_REMOTE_DB !== '1') {
  console.error(`Refusing to change a REMOTE database (${target.host}) without SLC_ALLOW_REMOTE_DB=1.`);
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let code2 = 0;
try {
  const row = (await client.query('select id, status, content_hash, validated_hash, tested_hash from cases where case_code = $1 and content_version = $2', [code.toUpperCase(), version])).rows[0];
  if (!row) throw new Error(`no ${code} version ${version} in this database (run the seed first)`);
  const pack = PACKS.find((p) => p.manifest?.case_code === code.toUpperCase() && p.manifest.content_version === version);
  console.log(`${code.toUpperCase()} v${version}: status ${row.status}; validated ${row.validated_hash === row.content_hash}; tested ${row.tested_hash === row.content_hash}; pack matches database ${pack?.hash === row.content_hash}`);
  if (to === 'status') process.exit(0);
  if (pack && pack.hash !== row.content_hash && to !== 'disabled') throw new Error('the pack on disk differs from the seeded version: re-seed (or bump content_version) before changing its status');
  let record = {};
  if (to === 'tested') {
    const r = pack?.review;
    const h = r?.human_review;
    const b = r?.blind_playtest;
    if (!h?.completed || !h.reviewer || !h.date || h.content_hash !== row.content_hash) throw new Error('review.json has no completed human review (reviewer, date) for this exact content hash');
    if (!b?.completed || !(b.participants >= 1) || b.content_hash !== row.content_hash) throw new Error('review.json has no completed blind playtest (participants) for this exact content hash');
    record = { reviewer: h.reviewer, reviewed_on: h.date, blind_playtest: 'completed', playtest_participants: b.participants, notes: String(r.notes ?? '').slice(0, 500) };
  }
  if (dryRun) {
    console.log(`would move ${row.status} -> ${to}`);
  } else {
    await client.query('begin');
    await client.query('select transition_case_status($1, $2, $3, $4::jsonb)', [row.id, to, 'case-lifecycle', JSON.stringify(record)]);
    await client.query('commit');
    console.log(`moved ${row.status} -> ${to}`);
  }
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error(`REFUSED: ${e.message}`);
  code2 = 1;
} finally {
  await client.end();
}
process.exit(code2);
