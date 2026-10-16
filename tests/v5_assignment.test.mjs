// Version-aware assignment: the admin catalogue explains every version, the dropdown/API accept only published, eligible
// versions, the exact version chosen is the one pinned, review-only versions can never be assigned, existing assignments are
// preserved, and the legacy-retirement plan protects anything a registration or a live team still depends on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, makeGame, defByCode, CATALOGUE, AdminClient } from './helpers.mjs';
import { assignability } from '../lib/caseEligibility.ts';
import { planRetirement } from '../scripts/lib/retire.mjs';
import { CANONICAL_TITLES, CATALOGUE_CODES } from '../scripts/cases/pack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = db();
const admin = new AdminClient();
const cleanups = [];
const hashOf = (n) => n.toString(16).padStart(64, '0');
before(async () => {
  assert.equal((await admin.login()).status, 200);
});
after(async () => {
  for (const f of cleanups.reverse()) await f().catch(() => {});
  await pool.end();
});
const nodeScript = (args) => spawnSync('node', args, { cwd: root, encoding: 'utf8', env: { ...process.env, SLC_ENV_FILE: '.env.localdb', PGSSLMODE: 'disable' } });
const status = async (id) => (await pool.query('select status from cases where id = $1', [id])).rows[0].status;
const transition = (id, to, record = {}) => pool.query('select transition_case_status($1, $2, $3, $4::jsonb)', [id, to, 'test', JSON.stringify(record)]);
const code = () => `AS${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
const catalogue = async () => (await admin.get('/api/admin/cases')).data.cases;

test('the canonical catalogue carries exactly the twelve supplied titles', () => {
  assert.deepEqual(CATALOGUE.map((d) => d.code), CATALOGUE_CODES);
  for (const d of CATALOGUE) assert.equal(d.title, CANONICAL_TITLES[d.code], d.code);
  assert.equal(Object.keys(CANONICAL_TITLES).length, 12);
  assert.equal(CATALOGUE.find((d) => d.code === 'SQL06').title, 'The Empty Account');
});

test('eligibility rule: only a published version is assignable, and a hashed version also needs its recorded human test', () => {
  const e = (status, hashed, tested) => assignability({ status, hashed, tested });
  assert.equal(e('published', false, false).ok, true, 'a legacy published version (no hash) is assignable');
  assert.equal(e('published', true, true).ok, true);
  assert.equal(e('published', true, false).ok, false, 'published without a human test is refused');
  for (const s of ['draft', 'review', 'tested', 'disabled']) assert.equal(e(s, true, true).ok, false, s);
  assert.match(e('review', true, false).reason, /human review.*blind playtest/);
});

test('the catalogue API explains every version; a review version is not assignable and the API refuses it', async () => {
  const c = code();
  const v1 = await makeGame(pool, defByCode('SQL06'), { caseCode: c, version: 1, status: 'published' });
  const v2 = await makeGame(pool, defByCode('SQL01'), { caseCode: c, version: 2, status: 'review', contentHash: hashOf(2) });
  cleanups.push(() => v1.cleanup(), () => v2.cleanup());
  const rows = (await catalogue()).filter((r) => r.case_code === c);
  const r1 = rows.find((r) => r.content_version === 1);
  const r2 = rows.find((r) => r.content_version === 2);
  assert.equal(r1.assignable, true);
  assert.equal(r2.assignable, false);
  assert.match(r2.reason, /In review/);
  assert.ok(r1.id === v1.caseId && r2.id === v2.caseId);
  const reg = await v1.register({ assign: false });
  // the review-only version cannot be assigned by id or by code, whatever the UI shows
  const byId = await admin.post('/api/admin/assign-case', { registration_id: reg.id, case_id: v2.caseId });
  assert.equal(byId.status, 409);
  assert.match(byId.text, /cannot be assigned/);
  // by code alone the only published version (v1) is chosen; the review version is never substituted
  const byCode = await admin.post('/api/admin/assign-case', { registration_id: reg.id, case_code: c });
  assert.equal(byCode.status, 200);
  assert.equal(byCode.data.content_version, 1);
  const a = (await pool.query("select case_id from team_case_assignments where registration_id = $1 and status = 'assigned'", [reg.id])).rows;
  assert.deepEqual(a.map((x) => x.case_id), [v1.caseId]);
});

test('exact-version pinning: publishing v2 after a real review makes v2 assignable and retires v1 for new assignments; the old assignment keeps v1', async () => {
  const c = code();
  const v1 = await makeGame(pool, defByCode('SQL06'), { caseCode: c, version: 1, status: 'published' });
  const v2 = await makeGame(pool, defByCode('SQL01'), { caseCode: c, version: 2, status: 'review', contentHash: hashOf(2) });
  cleanups.push(() => v1.cleanup(), () => v2.cleanup());
  const existing = await v1.register({ assign: false });
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: existing.id, case_id: v1.caseId })).status, 200);
  const before = (await pool.query('select id, case_id, status from team_case_assignments where registration_id = $1', [existing.id])).rows;

  // the lifecycle is explicit: review -> tested needs a recorded reviewer and playtest, then published
  await pool.query('update cases set validated_hash = content_hash where id = $1', [v2.caseId]);
  await assert.rejects(transition(v2.caseId, 'tested', {}), /reviewer|playtest/i);
  await assert.rejects(transition(v2.caseId, 'published'), /illegal|tested/i);
  await transition(v2.caseId, 'tested', { reviewer: 'Test Reviewer', blind_playtest: 'completed' });
  await transition(v2.caseId, 'published');
  assert.equal(await status(v2.caseId), 'published');
  assert.equal(await status(v1.caseId), 'disabled');

  // the catalogue now offers v2, not the obsolete version
  const rows = (await catalogue()).filter((r) => r.case_code === c);
  assert.equal(rows.find((r) => r.content_version === 2).assignable, true);
  assert.equal(rows.find((r) => r.content_version === 1).assignable, false);
  const fresh = await v2.register({ assign: false });
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: fresh.id, case_id: v1.caseId })).status, 409, 'the disabled v1 can no longer be chosen');
  const pick = await admin.post('/api/admin/assign-case', { registration_id: fresh.id, case_id: v2.caseId });
  assert.equal(pick.status, 200);
  assert.equal(pick.data.content_version, 2);
  // the earlier registration is untouched: same row, still pointing at v1
  const after = (await pool.query('select id, case_id, status from team_case_assignments where registration_id = $1', [existing.id])).rows;
  assert.deepEqual(after, before);
});

test('a hashed version that is published without its human test is refused by the backend even if it was forced to published', async () => {
  const c = code();
  const g = await makeGame(pool, defByCode('SQL01'), { caseCode: c, version: 2, status: 'published', contentHash: hashOf(9) });
  cleanups.push(() => g.cleanup());
  const reg = await g.register({ assign: false });
  const r = await admin.post('/api/admin/assign-case', { registration_id: reg.id, case_id: g.caseId });
  assert.equal(r.status, 409);
  assert.match(r.text, /human test/);
});

test('retirement plan: protects open assignments, unfinished teams and the last assignable version; retires the rest; cancelled history is noted', () => {
  const base = { status: 'published', open_assignments: 0, live_teams: 0, cancelled_assignments: 0, published_v2: false };
  const rows = [
    { ...base, id: 1, case_code: 'SQL07', content_version: 1 },
    { ...base, id: 2, case_code: 'SQL08', content_version: 1, open_assignments: 1 },
    { ...base, id: 3, case_code: 'SQL09', content_version: 1, live_teams: 2 },
    { ...base, id: 4, case_code: 'SQL06', content_version: 1, open_assignments: 1, published_v2: true },
    { ...base, id: 5, case_code: 'SQL05', content_version: 1, published_v2: false },
    { ...base, id: 6, case_code: 'SQL04', content_version: 1, published_v2: true, cancelled_assignments: 2 },
    { ...base, id: 7, case_code: 'SQL01', content_version: 2, status: 'review' },
  ];
  const { retire, keep } = planRetirement(rows, CATALOGUE_CODES);
  assert.deepEqual(retire.map((r) => r.id), [1, 6]);
  assert.match(retire.find((r) => r.id === 6).note, /2 cancelled assignment/);
  assert.deepEqual(keep.map((r) => r.id).sort(), [2, 3, 4, 5]);
  assert.match(keep.find((r) => r.id === 4).reasons.join(), /open assignment/);
  assert.match(keep.find((r) => r.id === 5).reasons.join(), /nothing assignable/);
  assert.ok(!keep.concat(retire).some((r) => r.id === 7), 'the canonical v2 is never a candidate');
});

test('retirement dry run against a database: explains each decision and changes nothing', async () => {
  const c = code();
  const legacy = await makeGame(pool, defByCode('SQL07'), { caseCode: c, version: 1, status: 'published' });
  const looseCode = code();
  const loose = await makeGame(pool, defByCode('SQL08'), { caseCode: looseCode, version: 1, status: 'published' });
  const scope = `--only=${c},${looseCode}`;
  cleanups.push(() => legacy.cleanup(), () => loose.cleanup());
  const reg = await legacy.register({ assign: true }); // an open assignment protects `legacy`
  const out = nodeScript(['scripts/retire-legacy-cases.mjs', scope]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /DRY RUN/);
  assert.match(out.stdout, /PROTECTED/);
  assert.ok(out.stdout.includes(`${c} v1  stays published: 1 open assignment(s)`), 'the protected version is explained');
  assert.match(out.stdout, /Dry run only/);
  assert.equal(await status(legacy.caseId), 'published');
  assert.equal(await status(loose.caseId), 'published', 'a dry run changes nothing');
  // applying retires the unprotected one only and leaves the assignment alone
  const run = nodeScript(['scripts/retire-legacy-cases.mjs', scope, '--apply']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await status(legacy.caseId), 'published', 'protected while a registration is assigned to it');
  assert.equal(await status(loose.caseId), 'disabled');
  assert.equal((await pool.query("select count(*)::int n from team_case_assignments where registration_id = $1 and status = 'assigned'", [reg.id])).rows[0].n, 1);
  const again = nodeScript(['scripts/retire-legacy-cases.mjs', scope, '--apply']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await status(loose.caseId), 'disabled', 'idempotent');
});

test('a cancelled historical assignment does not protect a version, is never rewritten, and keeps its history', async () => {
  const gCode = code();
  const g = await makeGame(pool, defByCode('SQL09'), { caseCode: gCode, version: 1, status: 'published' });
  cleanups.push(() => g.cleanup());
  const reg = await g.register({ assign: true });
  await pool.query("update team_case_assignments set status = 'cancelled' where registration_id = $1", [reg.id]);
  const hist = (await pool.query('select id, case_id, status from team_case_assignments where registration_id = $1', [reg.id])).rows;
  const out = nodeScript(['scripts/retire-legacy-cases.mjs', `--only=${gCode}`, '--apply']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(await status(g.caseId), 'disabled');
  assert.deepEqual((await pool.query('select id, case_id, status from team_case_assignments where registration_id = $1', [reg.id])).rows, hist);
});
