// Player onboarding state (PRD 17.2 / 17.3): the guided tour belongs to the PLAYER, survives a refresh, never touches the
// game, and works for both tracks. Browser behaviour of the tour itself is covered in v5_ui.e2e.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeGame, defByCode, Client, AdminClient, startedTeam, makeTeam, submit, answerValue, rawCode } from './helpers.mjs';

const pool = db();
let G;
let L;
before(async () => {
  G = await makeGame(pool, defByCode('SQL02'));
  L = await makeGame(pool, defByCode('LOG02'));
});
after(async () => {
  await G.cleanup();
  await L.cleanup();
  await pool.end();
});

const counts = async (teamId) => {
  const q = async (sql) => (await pool.query(sql, [teamId])).rows[0].n;
  return {
    attempts: await q('select count(*)::int n from task_attempts where team_id = $1'),
    hints: await q('select count(*)::int n from team_hint_usage where team_id = $1'),
    completions: await q('select count(*)::int n from team_task_completions where team_id = $1'),
    threads: await q('select count(*)::int n from team_thread_progress where team_id = $1'),
    finals: await q('select count(*)::int n from team_final_completions where team_id = $1'),
    score: (await pool.query('select total_pts, points_by_component from team_scores where team_id = $1', [teamId])).rows[0],
    progress: (await pool.query('select state, current_phase from team_progress where team_id = $1', [teamId])).rows[0],
    assignment: (await pool.query('select status, case_id from team_case_assignments where team_id = $1', [teamId])).rows[0],
    players: await q('select count(*)::int n from players where team_id = $1'),
  };
};

test('a new player has no tour state; the state endpoint says so and exposes nothing else about the tour', async () => {
  const { head, inv } = await makeTeam(G, 1);
  const a = (await head.get('/api/state')).data;
  const b = (await inv[0].get('/api/state')).data;
  assert.equal(a.me.tour_state, null);
  assert.equal(b.me.tour_state, null);
});

test('two teammates complete and skip their tours independently, and a refresh restores each one without touching the team', async () => {
  const t = await startedTeam(G, 2);
  const teamId = (await pool.query('select id from teams where team_code = $1', [rawCode(t.teamCode)])).rows[0].id;
  const before = await counts(teamId);

  assert.equal((await t.head.post('/api/tour', { state: 'completed' })).status, 200);
  assert.equal((await t.inv[0].post('/api/tour', { state: 'dismissed' })).status, 200);

  assert.equal((await t.head.get('/api/state')).data.me.tour_state, 'completed');
  assert.equal((await t.inv[0].get('/api/state')).data.me.tour_state, 'dismissed');
  assert.equal((await t.inv[1].get('/api/state')).data.me.tour_state, null, 'the third teammate has not touched their tour');

  // a refresh is just another state fetch (new client, same cookie): nothing changes
  const again = Object.assign(new Client(), { cookie: t.head.cookie });
  assert.equal((await again.get('/api/state')).data.me.tour_state, 'completed');

  // a player can finish after skipping (replaying from Help and finishing it)
  assert.equal((await t.inv[0].post('/api/tour', { state: 'completed' })).status, 200);
  assert.equal((await t.inv[0].get('/api/state')).data.me.tour_state, 'completed');

  assert.deepEqual(await counts(teamId), before, 'tour state touched no score, hint, attempt, completion, phase, assignment or player');
});

test('the tour endpoint changes only the caller\'s own row: it needs a session, validates its input and ignores any claim about someone else', async () => {
  const t = await startedTeam(G, 1);
  assert.equal((await new Client().post('/api/tour', { state: 'completed' })).status, 401);
  assert.equal((await t.head.post('/api/tour', { state: 'banana' })).status, 400);
  assert.equal((await t.head.post('/api/tour', {})).status, 400);
  const victim = (await t.inv[0].get('/api/state')).data.me.player_id;
  const r = await t.head.post('/api/tour', { state: 'completed', player_id: victim, team_id: 'x', tour_state: 'dismissed' });
  assert.equal(r.status, 200);
  assert.equal((await t.inv[0].get('/api/state')).data.me.tour_state, null, 'the teammate\'s tour is untouched');
  assert.equal((await t.head.get('/api/state')).data.me.tour_state, 'completed');
});

test('the tour still saves while the game is paused and never unlocks, scores or advances anything', async () => {
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
  const t = await startedTeam(G, 0);
  const teamId = (await pool.query('select id from teams where team_code = $1', [rawCode(t.teamCode)])).rows[0].id;
  const stateBefore = (await t.head.get('/api/state')).data;
  const before = await counts(teamId);
  await admin.post('/api/admin/pause', { scope: 'team', team_code: rawCode(t.teamCode), paused: true });
  try {
    assert.equal((await t.head.post('/api/tour', { state: 'dismissed' })).status, 200);
    assert.equal((await t.head.get('/api/state')).data.me.tour_state, 'dismissed');
  } finally {
    await admin.post('/api/admin/pause', { scope: 'team', team_code: rawCode(t.teamCode), paused: false });
  }
  const stateAfter = (await t.head.get('/api/state')).data;
  assert.deepEqual(stateAfter.unlocked_tables, stateBefore.unlocked_tables);
  assert.deepEqual(stateAfter.scores, stateBefore.scores);
  assert.deepEqual(stateAfter.threads.map((x) => x.id), stateBefore.threads.map((x) => x.id));
  assert.deepEqual(await counts(teamId), before);
});

test('tour state is separate from the game: solving a question, a reset or a refresh never sets it, and setting it never solves anything', async () => {
  const t = await startedTeam(L, 0);
  const q = L.tasks[0];
  assert.equal((await submit(t.head, q.id, answerValue(q))).status, 200);
  assert.equal((await t.head.get('/api/state')).data.me.tour_state, null, 'playing does not complete the tour');
  await t.head.post('/api/tour', { state: 'completed' });
  const st = (await t.head.get('/api/state')).data;
  assert.equal(st.scores.total_pts, 10, 'only the one answered question scored');
  assert.equal(st.threads.flatMap((x) => x.questions).filter((x) => x.completed).length, 1);
});

test('the player record has only a nullable, constrained tour column and no score or progress column', async () => {
  const cols = (await pool.query("select column_name, is_nullable, data_type from information_schema.columns where table_name = 'players' and column_name like 'tour%'")).rows;
  assert.deepEqual(cols.map((c) => c.column_name).sort(), ['tour_state', 'tour_updated_at']);
  assert.ok(cols.every((c) => c.is_nullable === 'YES'));
  const p = await makeTeam(G, 0);
  await assert.rejects(pool.query("update players set tour_state = 'whatever' where id = (select id from players where team_id = (select id from teams where team_code = $1))", [rawCode(p.teamCode)]), /tour_state/);
});

test('both interfaces are tour targets: SQL and Logic teams each get their own state record', async () => {
  const s = await startedTeam(G, 0);
  const l = await startedTeam(L, 0);
  assert.equal((await s.head.get('/api/state')).data.case.track, 'SQL');
  assert.equal((await l.head.get('/api/state')).data.case.track, 'LOGIC');
  await s.head.post('/api/tour', { state: 'completed' });
  await l.head.post('/api/tour', { state: 'dismissed' });
  assert.equal((await s.head.get('/api/state')).data.me.tour_state, 'completed');
  assert.equal((await l.head.get('/api/state')).data.me.tour_state, 'dismissed');
});
