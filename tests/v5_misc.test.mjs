import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { db, makeGame, defByCode, Client, makeTeam, startedTeam, rawCode } from './helpers.mjs';

const pool = db();
let G;
before(async () => {
  G = await makeGame(pool, defByCode('SQL08'));
});
after(async () => {
  await G.cleanup();
  await pool.end();
});

const state = async (c) => (await c.get('/api/state')).data;

test('presence: players are online right after joining and go offline when they stop polling', async () => {
  const { head, inv, teamCode } = await makeTeam(G, 1);
  const st = await state(head);
  assert.ok(st.players.every((p) => p.online === true), 'everyone who just joined is online');
  await pool.query("update players set last_seen_at = now() - interval '2 minutes' where team_id = (select id from teams where team_code = $1) and role = 'investigator'", [rawCode(teamCode)]);
  const after = await state(head);
  assert.equal(after.players.find((p) => p.role === 'investigator').online, false);
  assert.equal(after.players.find((p) => p.role === 'head').online, true);
  assert.equal((await state(inv[0])).players.find((p) => p.role === 'investigator').online, true, 'polling again brings them back online');
});

test('the roster carries public roles and never spoils the culprit; the victim is not a suspect', async () => {
  const { head } = await startedTeam(G);
  const st = await state(head);
  assert.equal(st.roster.length, 13);
  assert.ok(!st.roster.some((c) => c.name === G.def.victimName));
  assert.ok(st.roster.every((c) => c.role && !/culprit|killer|murderer|guilty/i.test(c.role)));
  assert.ok(!JSON.stringify(st).includes('role_in_story'));
});

test('leaderboard rows have an opaque, stable ref that is not a credential or id', async () => {
  const t = await startedTeam(G);
  const a = (await new Client().get('/api/leaderboard?track=SQL')).data.teams;
  const b = (await new Client().get('/api/leaderboard?track=SQL')).data.teams;
  const mine = a.find((x) => x.team_name === t.reg.teamRef);
  assert.ok(mine && /^[0-9a-f]{12}$/.test(mine.ref));
  assert.ok(b.some((x) => x.ref === mine.ref), 'stable across requests');
  const ids = (await pool.query('select id, realtime_token from teams where registration_id = $1', [t.reg.id])).rows[0];
  assert.ok(!ids.id.includes(mine.ref) && !ids.realtime_token.includes(mine.ref));
  assert.equal(mine.team_name, t.reg.teamRef, 'the public name is the registered team name, never the team code');
});

test('post-event cleanup script: dry run changes nothing and reports counts', () => {
  const before = spawnSync('node', ['scripts/discard-query-logs.mjs'], { encoding: 'utf8', cwd: process.cwd() });
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /query_logs: \d+ rows/);
  assert.match(before.stdout, /dry run: nothing deleted/);
});

test('every case, once finished, returns its own complete resolution (motive, method, chain) to that team only', async () => {
  const done = await startedTeam(G);
  const other = await startedTeam(G);
  for (const t of G.tasks) await done.head.post('/api/submit-task', { task_id: t.id, value: t.answer_type === 'SINGLE_CHARACTER' ? t.correct_answer : t.answer_text });
  await done.head.post('/api/submit-final', { component: 'culprit', value: G.culpritId });
  await done.head.post('/api/submit-final', { component: 'mechanism', value: G.options.find((o) => o.correct).id });
  const st = await state(done.head);
  assert.equal(st.state, 'FINISHED');
  assert.equal(st.solution.culprit, G.def.culpritName);
  assert.ok(st.solution.motive.length > 20 && st.solution.method.length > 20 && st.solution.chain.length >= 3);
  assert.equal((await state(other.head)).solution, null, 'a different team does not see it');
});

// ------------------------------------------------------------------------------------------------------------------
// Operator scripts: credential generation and the remote-database guards
// ------------------------------------------------------------------------------------------------------------------
const run = (script, args = [], env = {}) => spawnSync('node', [script, ...args], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, ...env } });

test('gen-case-credentials: new password per case, hash only in the database, publish only validated cases', async () => {
  const draft = await makeGame(pool, defByCode('SQL09'), { status: 'draft' });
  const tested = await makeGame(pool, defByCode('SQL10'), { status: 'tested' });
  try {
    // a draft case cannot be published
    const refused = run('scripts/gen-case-credentials.mjs', [draft.caseCode, '--publish']);
    assert.match(refused.stderr, /only validated/);
    assert.equal((await pool.query('select status from cases where id = $1', [draft.caseId])).rows[0].status, 'draft');

    const out = run('scripts/gen-case-credentials.mjs', [tested.caseCode, '--publish']);
    assert.equal(out.status, 0, out.stderr);
    const m = new RegExp(String.raw`${tested.caseCode}\s+([A-HJKMNP-Z2-9]{12})\s+published`).exec(out.stdout);
    assert.ok(m, out.stdout);
    const row = (await pool.query('select status, password_hash from cases where id = $1', [tested.caseId])).rows[0];
    assert.equal(row.status, 'published');
    assert.ok(!row.password_hash.includes(m[1]) && row.password_hash.startsWith('$2'));
    // the new password works, the old one no longer does
    const reg = await tested.register();
    assert.equal((await new Client().post('/api/join', { registration_ref: reg.ref, case_code: tested.caseCode, case_password: tested.password, display_name: 'Old', idempotency_key: crypto.randomUUID() })).status, 401);
    assert.equal((await new Client().post('/api/join', { registration_ref: reg.ref, case_code: tested.caseCode, case_password: m[1], display_name: 'New', idempotency_key: crypto.randomUUID() })).status, 200);
    assert.equal(run('scripts/gen-case-credentials.mjs', ['NOPE99']).status, 1);
  } finally {
    await draft.cleanup();
    await tested.cleanup();
  }
});

test('seed, verify and credential scripts refuse a remote database unless explicitly allowed', () => {
  const remote = { DATABASE_URL: 'postgres://user:pw@db.exampleprojectref.supabase.co:5432/postgres', SLC_ALLOW_REMOTE_DB: '' };
  for (const script of ['scripts/seed-cases.mjs', 'scripts/verify-case.mjs']) {
    const r = run(script, [], remote);
    assert.equal(r.status, 2, script);
    assert.match(r.stderr, /REMOTE database/);
  }
  const g = run('scripts/gen-case-credentials.mjs', ['--all'], remote);
  assert.equal(g.status, 2);
  assert.match(g.stderr, /REMOTE database/);
  // and the test runner itself
  const t = run('tests/run.mjs', ['--no-build'], { ...remote });
  assert.equal(t.status, 2);
  assert.match(t.stderr, /remote database/i);
  for (const r of [g, t]) assert.ok(!/pw@|user:pw/.test(r.stdout + r.stderr), 'no connection string is echoed');
});
