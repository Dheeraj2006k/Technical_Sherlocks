import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { db, makeCase, submit, Client, AdminClient, rawCode, randomIp } from './helpers.mjs';

const pool = db();
let S;
let admin;
const usedIps = [];

before(async () => {
  S = await makeCase(pool);
  admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
});
after(async () => {
  // never leave the game paused for whatever runs next
  await admin.post('/api/admin/pause', { scope: 'global', paused: false });
  await S.cleanup();
  const h = usedIps.map((ip) => createHmac('sha256', process.env.SESSION_SECRET).update(`admin:${ip}`).digest('hex'));
  await pool.query('delete from join_attempts where ip_hash = any($1)', [h]);
  await pool.end();
});

async function team(n = 0, teamName) {
  const head = new Client();
  const r = await head.post('/api/join', {
    case_code: S.caseCode,
    case_password: S.password,
    display_name: 'Head',
    idempotency_key: randomUUID(),
    ...(teamName ? { team_name: teamName } : {}),
  });
  assert.equal(r.status, 200, r.text);
  const inv = [];
  for (let i = 0; i < n; i++) {
    const x = new Client();
    assert.equal((await x.joinTeam(r.data.team.team_code, `Inv${i + 1}`)).status, 200);
    inv.push(x);
  }
  return { head, inv, teamCode: r.data.team.team_code };
}
const solve = async (c, phase) => {
  for (const t of S.byPhase(phase)) assert.equal((await submit(c, t.id, t.correct_answer)).data.correct, true);
};
const dash = async () => (await admin.get('/api/admin/dashboard')).data;
const row = async (code) => (await dash()).teams.find((t) => t.team_code === code);
const strip = (st) => {
  const x = JSON.parse(JSON.stringify(st));
  delete x.team.elapsed_s;
  return x;
};

test('CRASH RECOVERY: rejoin with team_code (and password for the head) restores exact state', async () => {
  const { head, inv, teamCode } = await team(2);
  assert.equal((await head.post('/api/start')).status, 200);
  const players = (await head.get('/api/state')).data.players;
  const [i1, i2] = [players.find((p) => p.display_name === 'Inv1'), players.find((p) => p.display_name === 'Inv2')];
  const p1 = S.byPhase(1);

  // phase 1: assignments, then solved by different people
  assert.equal((await head.post('/api/assign-task', { task_id: p1[0].id, player_id: i1.id })).status, 200);
  assert.equal((await head.post('/api/assign-task', { task_id: p1[1].id, player_id: i2.id })).status, 200);
  assert.equal((await submit(inv[0], p1[0].id, p1[0].correct_answer)).data.correct, true);
  assert.equal((await submit(inv[1], p1[1].id, p1[1].correct_answer)).data.correct, true);
  assert.equal((await submit(head, p1[2].id, p1[2].correct_answer)).data.phase_cleared, true);
  // phase 2: one task assigned and solved, one assigned, one wrong answer
  const p2 = S.byPhase(2);
  assert.equal((await head.post('/api/assign-task', { task_id: p2[0].id, player_id: i1.id })).status, 200);
  assert.equal((await submit(inv[0], p2[0].id, p2[0].correct_answer)).data.correct, true);
  assert.equal((await inv[1].post('/api/assign-task', { task_id: p2[1].id })).status, 200);
  assert.equal((await submit(inv[1], p2[1].id, 'definitely wrong')).data.correct, false);

  const before = [head, ...inv].map(async (c) => strip((await c.get('/api/state')).data));
  const snapshots = await Promise.all(before);
  assert.equal(snapshots[0].state, 'PHASE_2');
  assert.equal(snapshots[0].scores.total_pts, 20);

  // every computer "crashes": new browsers, no cookies
  const reHead = new Client();
  assert.equal((await reHead.joinTeam(teamCode, 'Head')).status, 401); // head needs the password
  const rj = await reHead.post('/api/join', { team_code: teamCode, display_name: 'Head', case_password: S.password });
  assert.equal(rj.status, 200);
  const reInv = [new Client(), new Client()];
  assert.equal((await reInv[0].joinTeam(teamCode, 'inv1')).status, 200);
  assert.equal((await reInv[1].joinTeam(teamCode, 'INV2')).status, 200);

  const after = await Promise.all([reHead, ...reInv].map(async (c) => strip((await c.get('/api/state')).data)));
  assert.deepEqual(after, snapshots);
  // and play continues from exactly where they were
  assert.equal((await submit(reInv[1], p2[2].id, p2[2].correct_answer)).data.correct, true);
  assert.equal((await submit(reInv[1], p2[1].id, p2[1].correct_answer)).data.phase_cleared, true);
  assert.equal((await reHead.get('/api/state')).data.state, 'PHASE_3');
});

test('admin auth: sign-in required everywhere; wrong password refused; tokens are not interchangeable', async () => {
  const anon = new AdminClient();
  for (const [m, path, body] of [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/team?code=ABC-DEF'],
    ['GET', '/api/admin/export'],
    ['POST', '/api/admin/reset-team', { team_code: 'AAA-AAA' }],
    ['POST', '/api/admin/pause', { scope: 'global', paused: true }],
  ]) {
    const r = await anon.req(m, path, body);
    assert.equal(r.status, 401, `${m} ${path}`);
  }
  assert.equal((await anon.login('definitely-wrong')).status, 401);
  assert.equal(anon.cookie, null);

  // a player session is not an admin session
  const { head } = await team();
  const fake = new AdminClient();
  fake.cookie = head.cookie.replace('slc_session', 'slc_admin');
  assert.equal((await fake.get('/api/admin/dashboard')).status, 401);
  // and an admin token is not a player session
  const asPlayer = new Client();
  asPlayer.cookie = admin.cookie.replace('slc_admin', 'slc_session');
  assert.equal((await asPlayer.get('/api/state')).status, 401);
  // tampered / wrong-audience / expired / alg-none admin tokens
  const tampered = new AdminClient();
  tampered.cookie = admin.cookie.slice(0, -3) + 'AAA';
  assert.equal((await tampered.get('/api/admin/dashboard')).status, 401);
  const key = new TextEncoder().encode(process.env.SESSION_SECRET);
  const noAud = await new SignJWT({ adm: true }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(key);
  const expired = await new SignJWT({ adm: true }).setProtectedHeader({ alg: 'HS256' }).setAudience('slc-admin').setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(key);
  const notAdmin = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setAudience('slc-admin').setExpirationTime('1h').sign(key);
  const wrongKey = await new SignJWT({ adm: true }).setProtectedHeader({ alg: 'HS256' }).setAudience('slc-admin').setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(32)));
  const algNone = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"adm":true,"aud":"slc-admin"}').toString('base64url')}.`;
  for (const t of [noAud, expired, notAdmin, wrongKey, algNone]) {
    const c = new AdminClient();
    c.cookie = `slc_admin=${t}`;
    assert.equal((await c.get('/api/admin/dashboard')).status, 401);
  }
  // cross-origin state-changing request is refused even with a valid admin cookie
  const evil = await admin.post('/api/admin/pause', { scope: 'global', paused: false }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('admin login is rate limited per IP', async () => {
  const c = new AdminClient();
  usedIps.push(c.ip);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('nope-' + i)).status, 401);
  const r = await c.login('nope-6');
  assert.equal(r.status, 429);
  assert.equal((await c.login()).status, 429, 'even the right password is refused while limited');
  const other = new AdminClient();
  usedIps.push(other.ip);
  assert.equal((await other.login()).status, 200);
});

test('dashboard shows live case / phase / elapsed / status for every team', async () => {
  const w = await team(1, 'Dash-Waiting');
  const p = await team(0, 'Dash-Playing');
  await p.head.post('/api/start');
  const t1 = S.byPhase(1)[0];
  await submit(p.head, t1.id, t1.correct_answer);

  const d = await dash();
  assert.equal(d.game_paused, false);
  const rw = d.teams.find((t) => t.team_code === w.teamCode);
  const rp = d.teams.find((t) => t.team_code === p.teamCode);
  assert.equal(rw.status, 'waiting');
  assert.equal(rw.players, 2);
  assert.equal(rw.team_name, 'Dash-Waiting');
  assert.equal(rp.status, 'playing');
  assert.equal(rp.state, 'PHASE_1');
  assert.ok(rp.case_title.startsWith('TEST'));
  assert.ok(rp.elapsed_s >= 0 && rp.idle_s >= 0);
  // finishes show as finished
  await solve(p.head, 1);
  await solve(p.head, 2);
  await solve(p.head, 3);
  await p.head.post('/api/submit-culprit', { character_id: S.culpritId });
  assert.equal((await row(p.teamCode)).status, 'finished');
  assert.equal((await row(p.teamCode)).total_pts, 100);
  // dashboard reflects a change immediately (well inside the 3 s UI refresh)
  const a = await row(w.teamCode);
  await w.head.post('/api/start');
  assert.notEqual((await row(w.teamCode)).state, a.state);
});

test('admin can inspect a team: submitted answers and recent query errors', async () => {
  const { head, teamCode } = await team();
  await head.post('/api/start');
  const t1 = S.byPhase(1)[0];
  await submit(head, t1.id, 'wrong-answer-xyz');
  await submit(head, t1.id, t1.correct_answer);
  // seed query_logs rows directly (the stub case has no clue tables to query)
  const info = (await pool.query('select t.id as team_id, p.id as player_id from teams t join players p on p.team_id = t.id where t.team_code = $1', [rawCode(teamCode)])).rows[0];
  await pool.query(
    `insert into query_logs (team_id, player_id, query_hash, execution_time_ms, row_count, success, error_type)
     values ($1, $2, repeat('a', 64), 12, 0, false, 'syntax'), ($1, $2, repeat('b', 64), 40, 7, true, null)`,
    [info.team_id, info.player_id],
  );
  const r = await admin.get(`/api/admin/team?code=${teamCode}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.submissions.map((s) => [s.submitted_value, s.is_correct]).reverse(), [['wrong-answer-xyz', false], [t1.correct_answer, true]]);
  assert.ok(r.data.submissions.every((s) => s.player === 'Head' && s.phase === 1));
  assert.equal(r.data.queries.length, 2);
  assert.ok(r.data.queries.some((q) => q.error_type === 'syntax' && q.success === false));
  assert.ok(r.data.players.some((p) => p.role === 'head'));
  assert.equal((await admin.get('/api/admin/team?code=ZZZ-ZZZ')).status, 404);
  assert.equal((await admin.get('/api/admin/team?code=bad')).status, 400);
});

const snapshotTeam = async (code) => {
  const r = (
    await pool.query(
      `select tp.state, tp.current_phase, tp.phase1_cleared, tp.phase2_cleared, tp.phase3_cleared,
              sc.total_pts, sc.phase1_pts, sc.culprit_pts, t.started_at, t.finished_at,
              (select count(*)::int from task_submissions s where s.team_id = t.id) as subs,
              (select count(*)::int from task_assignments a where a.team_id = t.id) as assigns,
              (select count(*)::int from culprit_submission c where c.team_id = t.id) as culprits,
              (select count(*)::int from players p where p.team_id = t.id) as players
         from teams t join team_progress tp on tp.team_id = t.id join team_scores sc on sc.team_id = t.id
        where t.team_code = $1`,
      [rawCode(code)],
    )
  ).rows[0];
  return r;
};

test('ADMIN RESET (state): one team is wiped and rejoinable; every other team is untouched', async () => {
  const abandoned = await team(1);
  const other = await team(1);
  for (const t of [abandoned, other]) {
    await t.head.post('/api/start');
    await solve(t.head, 1);
    await t.head.post('/api/assign-task', { task_id: S.byPhase(2)[0].id, player_id: (await t.head.get('/api/state')).data.players.find((p) => p.role !== 'head').id });
    await submit(t.head, S.byPhase(2)[1].id, 'wrong');
  }
  const otherBefore = await snapshotTeam(other.teamCode);
  const otherStateBefore = strip((await other.head.get('/api/state')).data);
  const otherLogsBefore = (await pool.query('select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1', [rawCode(other.teamCode)])).rows[0].n;
  const mid = await snapshotTeam(abandoned.teamCode);
  assert.equal(mid.state, 'PHASE_2');
  assert.equal(mid.total_pts, 20);

  assert.equal((await admin.post('/api/admin/reset-team', { team_code: abandoned.teamCode })).status, 200);

  const clean = await snapshotTeam(abandoned.teamCode);
  assert.equal(clean.state, 'WAITING');
  assert.equal(clean.current_phase, 1);
  assert.deepEqual([clean.phase1_cleared, clean.phase2_cleared, clean.phase3_cleared], [false, false, false]);
  assert.equal(clean.total_pts, 0);
  assert.equal(clean.phase1_pts, 0);
  assert.equal(clean.subs, 0);
  assert.equal(clean.assigns, 0);
  assert.equal(clean.culprits, 0);
  assert.equal(clean.finished_at, null);
  assert.equal(clean.players, 2); // slot kept: rejoinable
  assert.ok(new Date(clean.started_at) > new Date(mid.started_at));

  // the team's sessions still work, show a clean slate, and can play the whole thing again
  const st = (await abandoned.head.get('/api/state')).data;
  assert.equal(st.state, 'WAITING');
  assert.deepEqual(st.tasks, []);
  const rejoin = new Client();
  assert.equal((await rejoin.joinTeam(abandoned.teamCode, 'Inv1')).status, 200);
  assert.equal((await abandoned.head.post('/api/start')).status, 200);
  await solve(abandoned.head, 1);
  assert.equal((await abandoned.head.get('/api/state')).data.scores.total_pts, 20);

  // no effect on any other team
  assert.deepEqual(await snapshotTeam(other.teamCode), otherBefore);
  assert.deepEqual(strip((await other.head.get('/api/state')).data), otherStateBefore);
  assert.equal((await pool.query('select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1', [rawCode(other.teamCode)])).rows[0].n, otherLogsBefore);
});

test('ADMIN RESET of a FINISHED team clears the culprit and finish time', async () => {
  const t = await team();
  await t.head.post('/api/start');
  for (const p of [1, 2, 3]) await solve(t.head, p);
  assert.equal((await t.head.post('/api/submit-culprit', { character_id: S.culpritId })).data.total_pts, 100);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: t.teamCode })).status, 200);
  const s = await snapshotTeam(t.teamCode);
  assert.equal(s.state, 'WAITING');
  assert.equal(s.culprits, 0);
  assert.equal(s.finished_at, null);
  assert.equal(s.total_pts, 0);
  // and they can finish again
  await t.head.post('/api/start');
  for (const p of [1, 2, 3]) await solve(t.head, p);
  assert.equal((await t.head.post('/api/submit-culprit', { character_id: S.culpritId })).status, 200);
});

test('ADMIN RESET (delete): team and sessions disappear, the code is dead, others unaffected', async () => {
  const gone = await team(1);
  const other = await team(0);
  await other.head.post('/api/start');
  const otherBefore = await snapshotTeam(other.teamCode);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: gone.teamCode, mode: 'delete' })).status, 200);
  assert.equal((await gone.head.get('/api/state')).status, 401);
  assert.equal((await gone.inv[0].get('/api/state')).status, 401);
  assert.equal((await new Client().joinTeam(gone.teamCode, 'Anyone')).status, 401);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: gone.teamCode })).status, 404);
  assert.deepEqual(await snapshotTeam(other.teamCode), otherBefore);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: 'nonsense' })).status, 400);
});

test('EMERGENCY PAUSE (team): scoring/queries/start frozen, timer stops, nothing lost, resume works', async () => {
  const frozen = await team();
  const running = await team();
  for (const t of [frozen, running]) await t.head.post('/api/start');
  const t1 = S.byPhase(1)[0];
  await submit(frozen.head, t1.id, t1.correct_answer);

  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: frozen.teamCode, paused: true })).status, 200);
  assert.equal((await row(frozen.teamCode)).status, 'paused');
  const t2 = S.byPhase(1)[1];
  for (const [path, body] of [
    ['/api/submit-task', { task_id: t2.id, value: t2.correct_answer }],
    ['/api/query', { sql: 'select 1' }],
    ['/api/submit-culprit', { character_id: S.culpritId }],
    ['/api/start', {}],
  ]) assert.equal((await frozen.head.post(path, body)).status, 423, path);
  // the other team is unaffected
  assert.equal((await submit(running.head, t2.id, t2.correct_answer)).status, 200);

  const s1 = (await frozen.head.get('/api/state')).data;
  assert.equal(s1.paused, true);
  assert.equal(s1.scores.total_pts, 0);
  assert.equal(s1.tasks.filter((t) => t.solved).length, 1); // state retained
  const e1 = (await row(frozen.teamCode)).elapsed_s;
  const r1 = (await row(running.teamCode)).elapsed_s;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await row(frozen.teamCode)).elapsed_s, e1, 'paused timer is frozen');
  assert.ok((await row(running.teamCode)).elapsed_s >= r1 + 2, 'running timer keeps going');

  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: frozen.teamCode, paused: false })).status, 200);
  assert.equal((await submit(frozen.head, t2.id, t2.correct_answer)).status, 200);
  const e2 = (await row(frozen.teamCode)).elapsed_s;
  assert.ok(e2 <= e1 + 2, `pause time excluded from elapsed (${e1} -> ${e2})`);
  const pt = (await pool.query("select extract(epoch from paused_total)::int s, paused_at from teams where team_code = $1", [rawCode(frozen.teamCode)])).rows[0];
  assert.ok(pt.s >= 2 && pt.paused_at === null);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: 'ZZZ-ZZZ', paused: true })).status, 404);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: frozen.teamCode })).status, 400);
});

test('EMERGENCY PAUSE (global): freezes everyone, covers teams created while paused, resumes cleanly', async () => {
  const a = await team();
  const b = await team();
  await a.head.post('/api/start');
  try {
    assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: true })).status, 200);
    assert.equal((await dash()).game_paused, true);
    const t1 = S.byPhase(1)[0];
    assert.equal((await submit(a.head, t1.id, t1.correct_answer)).status, 423);
    assert.equal((await b.head.post('/api/start')).status, 423);
    const late = await team(); // created during the pause
    assert.equal((await late.head.post('/api/start')).status, 423);
    assert.equal((await row(late.teamCode)).status, 'paused');
    assert.equal((await late.head.get('/api/state')).data.paused, true);

    assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: false })).status, 200);
    assert.equal((await dash()).game_paused, false);
    assert.equal((await late.head.post('/api/start')).status, 200);
    assert.equal((await submit(a.head, t1.id, t1.correct_answer)).status, 200);
    assert.equal((await b.head.post('/api/start')).status, 200);
  } finally {
    await admin.post('/api/admin/pause', { scope: 'global', paused: false });
  }
});

test('leaderboard export is CSV, ordered like the leaderboard, with formula text neutralized', async () => {
  const t = await team(0, '=HYPERLINK("http://evil")');
  await t.head.post('/api/start');
  const r = await admin.get('/api/admin/export');
  assert.equal(r.status, 200);
  const res = await fetch(`${process.env.TEST_BASE_URL ?? 'http://localhost:3101'}/api/admin/export`, { headers: { cookie: admin.cookie } });
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = await res.text();
  const lines = text.trim().split('\n');
  assert.match(lines[0], /^rank,team_name,case_title,total_pts/);
  assert.ok(lines.length >= 2);
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`) || text.includes("'=HYPERLINK"), 'formula neutralized');
  assert.ok(!lines.some((l) => /^\d+,=/.test(l)));
  assert.equal((await new AdminClient().get('/api/admin/export')).status, 401);
  void randomIp;
});
