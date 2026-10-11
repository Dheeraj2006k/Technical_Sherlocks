// Recovery: the browser tab dies, the phone loses signal, a request is retried, the whole team rejoins. Nothing is lost
// and nothing is counted twice. (Polling is the safety net when realtime is down: the state endpoint is the single truth.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeGame, defByCode, Client, makeTeam, startedTeam, submit, hint, final, answerValue, solvePhase, flattenQuestions } from './helpers.mjs';

const pool = db();
let G;
before(async () => {
  G = await makeGame(pool, defByCode('SQL07'));
});
after(async () => {
  await G.cleanup();
  await pool.end();
});

const state = async (c) => (await c.get('/api/state')).data;

test('CRASH RECOVERY: rejoining with the team code (and the case password for the head) restores the exact state', async () => {
  const t = await startedTeam(G, 1);
  const q = G.tasks[0];
  await hint(t.head, q.id);
  await submit(t.head, q.id, answerValue(q));
  await submit(t.head, G.tasks[1].id, 'wrong');
  const before = await state(t.head);

  // the investigator's tab dies: same team code + same codename
  const inv = new Client();
  const back = await inv.joinTeam(t.teamCode, 'inv1');
  assert.equal(back.status, 200);
  assert.equal(back.data.replay, true);
  const s1 = await state(inv);
  assert.equal(s1.scores.total_pts, before.scores.total_pts);
  assert.deepEqual(s1.threads, before.threads, 'hints, completions, wrong-attempt counts and thread states are all intact');
  assert.equal(s1.me.role, 'investigator');

  // the head's laptop dies: rejoin with the registration credentials, or by team code + case password
  const head2 = new Client();
  const viaReg = await head2.headJoin(G, t.reg, 'Whatever');
  assert.equal(viaReg.status, 200);
  assert.equal(viaReg.data.player.role, 'head');
  assert.deepEqual((await state(head2)).threads, before.threads);
  const head3 = new Client();
  assert.equal((await head3.post('/api/join', { team_code: t.teamCode, display_name: 'Head', case_password: G.password })).status, 200);
  assert.equal((await state(head3)).state, before.state);
});

test('a dropped connection is safe to retry: the same idempotency key never scores twice', async () => {
  const t = await startedTeam(G);
  const q = G.tasks[0];
  const key = randomUUID();
  const first = await submit(t.head, q.id, answerValue(q), key); // the response is "lost" by the client
  const retry = await submit(t.head, q.id, answerValue(q), key);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.points_awarded, first.data.points_awarded);
  assert.equal((await state(t.head)).scores.total_pts, 10);
  // the same holds for hints (by position)
  assert.equal((await t.head.post('/api/hint', { task_id: G.tasks[1].id, position: 1 })).data.already_open, false);
  assert.equal((await t.head.post('/api/hint', { task_id: G.tasks[1].id, position: 1 })).data.already_open, true);
});

test('mid-phase and final-deduction state survive a full team rejoin; a finished team stays finished', async () => {
  const t = await startedTeam(G, 2);
  for (let p = 1; p <= 3; p++) await solvePhase(t.head, G, p);
  await final(t.head, 'culprit', G.culpritId);
  const mid = await state(t.head);
  assert.equal(mid.state, 'FINAL_DEDUCTION');
  assert.equal(mid.final.culprit.resolved, true);
  assert.equal(mid.final.mechanism.resolved, false);
  const everyone = [new Client(), new Client(), new Client()];
  await everyone[0].headJoin(G, t.reg);
  await everyone[1].joinTeam(t.teamCode, 'Inv1');
  await everyone[2].joinTeam(t.teamCode, 'Inv2');
  for (const c of everyone) {
    const s = await state(c);
    assert.equal(s.state, 'FINAL_DEDUCTION');
    assert.equal(s.final.culprit.resolved, true);
    assert.equal(s.scores.total_pts, mid.scores.total_pts);
  }
  const opt = G.options.find((o) => o.correct);
  assert.equal((await final(everyone[2], 'mechanism', opt.id)).data.finished, true, 'any teammate can complete the deduction');
  for (const c of everyone) assert.equal((await state(c)).state, 'FINISHED');
  const fin = await state(everyone[0]);
  assert.equal(flattenQuestions(fin).every((q) => q.completed), true);
});

test('polling is a complete substitute for realtime: the state endpoint alone reflects every change within one request', async () => {
  const a = await startedTeam(G, 1);
  const spectator = a.inv[0];
  const q = G.tasksIn('t1a')[0];
  await hint(a.head, q.id);
  assert.equal(flattenQuestions(await state(spectator)).find((x) => x.id === q.id).hints.length, 1);
  await submit(a.head, q.id, answerValue(q));
  assert.equal((await state(spectator)).scores.total_pts, 8);
  const second = G.tasksIn('t1a')[1];
  await submit(a.head, second.id, answerValue(second));
  assert.equal((await state(spectator)).state, 'PHASE_2');
});

test('a deleted team cannot be resurrected by its old session, and its registration can start fresh', async () => {
  const reg = await G.register();
  assert.equal((await new Client().joinTeam('ZZZZZZ', 'Ghost')).status, 401);
  const t = await makeTeam(G, 0);
  const stolen = t.head.cookie;
  await pool.query('delete from teams where registration_id = $1', [t.reg.id]);
  const c = new Client();
  c.cookie = stolen;
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await new Client().headJoin(G, reg)).status, 200);
  assert.equal((await new Client().headJoin(G, t.reg)).status, 200, 'the deleted team\'s registration can join again');
});
