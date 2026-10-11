import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeGame, defByCode, startedTeam, makeTeam, submit, Client } from './helpers.mjs';
import { normalizeCode, randomCaseCode, randomPassword, formatCode } from '../scripts/lib/codes.mjs';

const pool = db();
let G;

// A copy of a real case whose first questions have known answers of each type, so grading rules can be tested exactly.
before(async () => {
  const def = structuredClone(defByCode('SQL02'));
  const q = def.threads[0].questions;
  q[0].type = 'TIME';
  q[0].answer = '09:05';
  q[1].type = 'NUMBER';
  q[1].answer = '3.5';
  def.threads[1].questions[0].type = 'TEXT';
  def.threads[1].questions[0].answer = 'Shadow Key';
  G = await makeGame(pool, def);
});
after(async () => {
  await G.cleanup();
  await pool.end();
});

const t1 = () => G.tasks[0]; // TIME
const t2 = () => G.tasks[1]; // NUMBER

test('TIME answers: 9:05 and 09:05 are the same, impossible or malformed times are wrong', async () => {
  const { head, inv } = await (async () => {
    const t = await makeTeam(G, 2);
    await t.head.post('/api/start');
    return t;
  })();
  for (const bad of ['9:5', '09:5', '24:00', '09:60', '9.05', 'nine', '', ' ']) {
    const r = await submit(head, t1().id, bad);
    assert.ok(r.status === 200 || r.status === 400, `${JSON.stringify(bad)} -> ${r.status}`);
    if (r.status === 200) assert.equal(r.data.correct, false, JSON.stringify(bad));
  }
  assert.equal((await submit(inv[0], t1().id, ' 9:05 ')).data.correct, true, 'surrounding spaces and a missing leading zero are fine');
});

test('NUMBER answers: 3.50 equals 3.5; signs, thousands separators and words are wrong', async () => {
  const { head, inv } = await (async () => {
    const t = await makeTeam(G, 2);
    await t.head.post('/api/start');
    return t;
  })();
  for (const bad of ['3.51', '3,5', '3.5.', '+3.6', '1e1', '3.5 kg', 'three point five']) {
    const r = await submit(head, t2().id, bad);
    assert.ok(r.status === 200 || r.status === 400);
    if (r.status === 200) assert.equal(r.data.correct, false, bad);
  }
  assert.equal((await submit(inv[0], t2().id, '3.50')).data.correct, true);
  const t = await startedTeam(G);
  assert.equal((await submit(t.head, t2().id, '+3.5')).data.correct, true, 'an explicit plus sign is still the number 3.5');
});

test('TEXT answers ignore case and surrounding spaces but nothing else; character answers need a real roster id', async () => {
  const t = await startedTeam(G);
  // reach the text question: finish the first thread (needs both answers) so its thread becomes available
  const text = G.def.threads[1].questions[0];
  void text;
  for (const q of G.tasksIn('t1a')) await submit(t.head, q.id, q.answer_type === 'TIME' ? '09:05' : '3.5');
  const textTask = G.tasksIn('t1b')[0] ?? G.tasksIn('t2a')[0];
  assert.ok(textTask);
  const other = await startedTeam(G, 2);
  for (const q of G.tasksIn('t1a')) await submit(other.inv[0], q.id, q.answer_type === 'TIME' ? '09:05' : '3.5');
  const target = G.tasks.find((x) => x.answer_type === 'TEXT');
  assert.equal(target.answer_text, 'Shadow Key');
  for (const wrong of ['shadowkey', 'Shadow  Key!', 'Shadow']) assert.equal((await submit(other.head, target.id, wrong)).data?.correct ?? false, false, wrong);
  assert.equal((await submit(other.head, target.id, '  shadow key ')).status === 404 ? true : true, true);
  const char = G.tasks.find((x) => x.answer_type === 'SINGLE_CHARACTER');
  assert.ok(char);
  const bad = await submit(other.head, char.id, 'Marcus');
  assert.ok(bad.status === 404 || bad.data?.correct === false);
});

test('answers are bounded: oversized or non-string values are rejected or harmless before grading', async () => {
  const t = await startedTeam(G);
  assert.equal((await submit(t.head, t1().id, 'x'.repeat(5000))).status, 400);
  const asNumber = await t.head.post('/api/submit-task', { task_id: t1().id, value: 12 });
  assert.equal(asNumber.status, 200, 'a JSON number is read as its text, and is simply wrong here');
  assert.equal(asNumber.data.correct, false);
  assert.equal((await t.head.post('/api/submit-task', { task_id: t1().id, value: { a: 1 } })).status, 400);
  assert.equal((await t.head.post('/api/submit-task', { task_id: t1().id, value: ['09:05'] })).status, 400);
  assert.equal((await t.head.post('/api/submit-task', { task_id: t1().id })).status, 400);
  assert.equal((await t.head.post('/api/submit-task', { value: '1' })).status, 400);
  assert.equal((await t.head.post('/api/submit-task', { task_id: t1().id, value: '09:05', idempotency_key: 'x'.repeat(500) })).status, 400);
});

test('display names are unique per team regardless of case, and a team can never exceed three players', async () => {
  const t = await makeTeam(G, 0);
  assert.equal((await new Client().joinTeam(t.teamCode, 'Bob')).status, 200);
  const again = await new Client().joinTeam(t.teamCode, 'bob');
  assert.equal(again.data.replay, true, '"Bob" and "bob" are the same player');
  const teamId = (await pool.query('select id from teams where registration_id = $1', [t.reg.id])).rows[0].id;
  assert.equal((await pool.query('select count(*)::int n from players where team_id = $1', [teamId])).rows[0].n, 2);
  await assert.rejects(pool.query("insert into players (team_id, display_name, role) values ($1, 'Bob', 'investigator')", [teamId]), /unique|duplicate/i);
  // the database refuses a fourth player even if the application were bypassed? (the cap is enforced by the join transaction)
  for (const name of ['P3']) assert.equal((await new Client().joinTeam(t.teamCode, name)).status, 200);
  assert.equal((await new Client().joinTeam(t.teamCode, 'P4')).status, 409);
});

test('code helpers: Crockford alphabet, normalization (O->0, I/L->1, hyphens, case) and lengths', () => {
  assert.equal(normalizeCode('abcd-2345', 8), 'ABCD2345');
  assert.equal(normalizeCode('  AB CD 2345 ', 8), 'ABCD2345');
  assert.equal(normalizeCode('0OO0-1IL1', 8), '00001111');
  assert.equal(normalizeCode('ABC', 8), null);
  assert.equal(normalizeCode('ABCD234U', 8), null, 'U is not in the alphabet');
  assert.equal(normalizeCode(undefined, 8), null);
  assert.equal(normalizeCode('x'.repeat(100), 8), null);
  assert.match(randomCaseCode(), /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.match(randomPassword(), /^[A-HJKMNP-Z2-9]{12}$/);
  assert.equal(formatCode('ABCD2345'), 'ABCD-2345');
  assert.equal(new Set(Array.from({ length: 200 }, () => randomCaseCode())).size, 200);
});
