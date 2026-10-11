import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeGame, defByCode, Client, makeTeam, startedTeam, submit, hint, final, answerValue, solveAll, solvePhase, finishFinal, flattenQuestions, AdminClient } from './helpers.mjs';

const pool = db();
let G; // SQL01 copy
let L; // LOG01 copy

before(async () => {
  G = await makeGame(pool, defByCode('SQL01'));
  L = await makeGame(pool, defByCode('LOG01'));
});
after(async () => {
  await G.cleanup();
  await L.cleanup();
  await pool.end();
});

const state = async (c) => (await c.get('/api/state')).data;
const task = (game, key, i = 0) => game.tasksIn(key)[i];
const total = async (c) => (await state(c)).scores.total_pts;
const wrongValue = (t) => (t.answer_type === 'SINGLE_CHARACTER' ? null : t.answer_type === 'TIME' ? '03:33' : t.answer_type === 'NUMBER' ? '9999' : 'definitely wrong');

test('a correct answer with no hints awards the full 10; the answer is stored as an attempt and a completion', async () => {
  const { head, reg } = await startedTeam(G);
  const t = task(G, 't1a', 0);
  const r = await submit(head, t.id, answerValue(t));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.correct, true);
  assert.equal(r.data.points_awarded, 10);
  assert.equal(r.data.total_points, 10);
  const teamId = (await pool.query('select id from teams where registration_id = $1', [reg.id])).rows[0].id;
  assert.equal((await pool.query('select count(*)::int n from task_attempts where team_id = $1', [teamId])).rows[0].n, 1);
  assert.equal((await pool.query('select points_awarded from team_task_completions where team_id = $1', [teamId])).rows[0].points_awarded, 10);
});

test('hints cost the whole team: 10 / 8 / 6 / 4 / 2 by hints opened', async () => {
  const { head } = await startedTeam(G);
  const q = task(G, 't1a', 0);
  for (let n = 1; n <= 4; n++) {
    const h = await hint(head, q.id);
    assert.equal(h.status, 200, h.text);
    assert.equal(h.data.position, n);
    assert.equal(h.data.reward_now, [10, 8, 6, 4, 2][n]);
    assert.equal(h.data.text, q.hints[n - 1]);
  }
  assert.equal((await hint(head, q.id)).status, 409, 'there is no fifth hint');
  const r = await submit(head, q.id, answerValue(q));
  assert.equal(r.data.points_awarded, 2);
  assert.equal(r.data.hints_used, 4);

  // each level pays exactly its schedule
  for (const [n, pts] of [[1, 8], [2, 6], [3, 4]]) {
    const t = await startedTeam(G);
    const qq = task(G, 't1a', 0);
    for (let i = 0; i < n; i++) await hint(t.head, qq.id);
    assert.equal((await submit(t.head, qq.id, answerValue(qq))).data.points_awarded, pts, `${n} hints`);
  }
});

test('hints are shared by the team, in order, and opening the same position twice costs nothing extra', async () => {
  const { head, inv } = await startedTeam(G, 1);
  const q = task(G, 't1a', 0);
  const a = await head.post('/api/hint', { task_id: q.id, position: 1 });
  const b = await inv[0].post('/api/hint', { task_id: q.id, position: 1 });
  assert.equal(a.data.already_open, false);
  assert.equal(b.data.already_open, true, 'the teammate who clicked second pays nothing');
  assert.equal((await inv[0].post('/api/hint', { task_id: q.id, position: 3 })).status, 409, 'cannot skip ahead');
  // the teammate sees the hint the head opened
  const st = await state(inv[0]);
  const sq = flattenQuestions(st).find((x) => x.id === q.id);
  assert.deepEqual(sq.hints.map((h) => h.position), [1]);
  assert.equal(sq.hints[0].text, q.hints[0]);
  // simultaneous reveals of the same position by both players open exactly one hint
  const t = await startedTeam(G, 1);
  const rs = await Promise.all([t.head, t.inv[0], t.head, t.inv[0]].map((c) => c.post('/api/hint', { task_id: q.id, position: 1 })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => !r.data.already_open).length, 1);
  assert.equal((await submit(t.head, q.id, answerValue(q))).data.points_awarded, 8);
});

test('unopened hints, answers and final-option correctness never reach the browser', async () => {
  const { head } = await startedTeam(G);
  const q = task(G, 't1a', 0);
  await hint(head, q.id);
  const text = JSON.stringify(await state(head));
  assert.ok(text.includes(q.hints[0]));
  for (const h of q.hints.slice(1)) assert.ok(!text.includes(h), 'a hint that was not opened is not in the state');
  assert.ok(!text.includes('correct_answer'));
  const shown = flattenQuestions(await state(head)).find((x) => x.id === q.id);
  assert.equal(shown.answer, null, 'the unanswered question does not expose its answer');
  // the final options only appear at the final deduction and never say which is right
  assert.deepEqual((await state(head)).final.mechanism.options, []);
});

test('a wrong answer costs 2 points but the score never goes below zero', async () => {
  const t = await startedTeam(G, 2);
  const q = task(G, 't1a', 0);
  const w = wrongValue(q);
  // at zero points a wrong answer takes nothing
  const r0 = await submit(t.head, q.id, w);
  assert.equal(r0.data.correct, false);
  assert.equal(r0.data.points_awarded, 0);
  assert.equal(await total(t.head), 0);
  // earn 10, then wrong answers cost 2 each
  const q2 = task(G, 't1a', 1);
  assert.equal((await submit(t.inv[0], q2.id, answerValue(q2))).data.total_points, 10);
  const wrong2 = await submit(t.inv[1], q.id, w);
  assert.equal(wrong2.data.points_awarded, -2);
  assert.equal(wrong2.data.total_points, 8);
  assert.equal(await total(t.head), 8);
  for (let i = 0; i < 4; i++) await submit(t.inv[1], q.id, w);
  assert.equal(await total(t.head), 0, 'floored at 0, not negative');
  // the penalty column records what was actually taken: five wrong answers from 10 points (2+2+2+2+2)
  const comp = (await state(t.head)).scores.by_component;
  assert.equal(comp.penalties, -10);
  assert.equal(comp.tasks, 10);
});

test('retries are allowed: a wrong answer then the right one completes the question', async () => {
  const { head } = await startedTeam(G);
  const q = task(G, 't1a', 0);
  assert.equal((await submit(head, q.id, wrongValue(q))).data.correct, false);
  assert.equal((await submit(head, q.id, answerValue(q))).data.correct, true);
  const sq = flattenQuestions(await state(head)).find((x) => x.id === q.id);
  assert.equal(sq.completed, true);
  assert.equal(sq.wrong_attempts, 1);
});

test('idempotency: a repeated request with the same key changes nothing, for right and wrong answers alike', async () => {
  const { head } = await startedTeam(G);
  const q = task(G, 't1a', 0);
  const wk = randomUUID();
  const w1 = await submit(head, q.id, wrongValue(q), wk);
  const w2 = await submit(head, q.id, wrongValue(q), wk);
  assert.equal(w2.data.replayed, true);
  assert.equal(w1.data.points_awarded, w2.data.points_awarded);
  const ck = randomUUID();
  const c1 = await submit(head, q.id, answerValue(q), ck);
  const c2 = await submit(head, q.id, answerValue(q), ck);
  assert.equal(c1.data.points_awarded, 10);
  assert.equal(c2.data.replayed, true);
  assert.equal(c2.data.total_points, c1.data.total_points);
  assert.equal(await total(head), 10);
  // a NEW key for an already completed question is a harmless no-op
  const again = await submit(head, q.id, answerValue(q));
  assert.equal(again.data.already_completed, true);
  assert.equal(again.data.points_awarded, 0);
  assert.equal(await total(head), 10);
});

test('concurrency: many simultaneous correct answers to one question award it exactly once', async () => {
  const t = await startedTeam(G, 2);
  const q = task(G, 't1a', 0);
  const clients = [t.head, t.inv[0], t.inv[1]];
  const rs = await Promise.all(Array.from({ length: 9 }, (_, i) => submit(clients[i % 3], q.id, answerValue(q))));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => r.data.points_awarded === 10).length, 1);
  assert.equal(await total(t.head), 10);
  const teamId = (await pool.query('select id from teams where registration_id = $1', [t.reg.id])).rows[0].id;
  assert.equal((await pool.query('select count(*)::int n from team_task_completions where team_id = $1 and task_id = $2', [teamId, q.id])).rows[0].n, 1);
});

test('concurrency: teammates answering different questions at once all count and the thread completes once', async () => {
  const t = await startedTeam(G, 1);
  const [a, b] = G.tasksIn('t1a');
  const rs = await Promise.all([submit(t.head, a.id, answerValue(a)), submit(t.inv[0], b.id, answerValue(b))]);
  assert.deepEqual(rs.map((r) => r.data.correct), [true, true]);
  assert.equal(await total(t.head), 20);
  assert.equal(rs.filter((r) => r.data.thread_completed).length, 1);
  assert.equal(rs.filter((r) => r.data.phase_cleared).length, 1, 'the phase advances exactly once');
  assert.equal((await state(t.head)).state, 'PHASE_2');
});

test('threads: required threads gate the phase, optional threads never block it and stay open afterwards', async () => {
  const { head } = await startedTeam(G);
  let st = await state(head);
  assert.equal(st.state, 'PHASE_1');
  const p1 = st.threads.filter((t) => t.phase === 1);
  assert.ok(p1.length >= 1 && p1.every((t) => t.required), 'only the required, unlocked thread is listed at first');
  const optional = G.def.threads.find((t) => t.phase === 1 && !t.required);
  // the optional thread is locked behind its prerequisite until that is complete
  assert.ok(!st.threads.some((t) => t.title === optional.title), 'an unavailable thread is not even listed');
  const oq = G.tasksIn(optional.key)[0];
  assert.equal((await submit(head, oq.id, answerValue(oq))).status, 404, 'its questions cannot be answered yet');
  assert.equal((await hint(head, oq.id)).status, 404);
  // finish the required thread: the phase advances although the optional thread is untouched
  for (const q of G.tasksIn('t1a')) await submit(head, q.id, answerValue(q));
  st = await state(head);
  assert.equal(st.state, 'PHASE_2');
  const listed = st.threads.find((t) => t.title === optional.title);
  assert.ok(listed && !listed.done, 'the optional thread is now available but not done');
  // later: it can still be answered, awards points and shows its outcome
  const before = st.scores.total_pts;
  const ans = await submit(head, oq.id, answerValue(oq));
  assert.equal(ans.data.thread_completed, true);
  assert.equal(ans.data.phase_cleared, false);
  assert.equal(ans.data.total_points, before + 10);
  const done = (await state(head)).threads.find((t) => t.title === optional.title);
  assert.equal(done.done, true);
  assert.equal(done.outcome_type, optional.outcomeType);
  assert.equal(done.outcome_text, optional.outcomeText);
});

test('questions from a later phase or another case are not reachable', async () => {
  const { head } = await startedTeam(G);
  const later = G.tasksIn('t2a')[0];
  assert.equal((await submit(head, later.id, answerValue(later))).status, 404);
  assert.equal((await hint(head, later.id)).status, 404);
  const other = L.tasks[0];
  assert.equal((await submit(head, other.id, answerValue(other))).status, 404, 'a question of another case');
  assert.equal((await submit(head, randomUUID(), 'x')).status, 404);
  assert.equal((await head.post('/api/submit-task', { task_id: 'not-a-uuid', value: 'x' })).status, 400);
});

test('story events and thread outcomes unfold only as threads complete', async () => {
  const { head } = await startedTeam(G);
  assert.deepEqual((await state(head)).story, []);
  for (const q of G.tasksIn('t1a')) await submit(head, q.id, answerValue(q));
  const st = await state(head);
  assert.equal(st.story.length, 1);
  assert.equal(st.story[0].title, G.def.threads.find((t) => t.key === 't1a').title);
  const body = JSON.stringify(st);
  assert.ok(!body.includes(G.def.threads.find((t) => t.key === 't2b').outcomeText), 'a later thread outcome is not revealed');
});

test('a full playthrough: all threads, phase by phase, then the two-part final deduction', async () => {
  const { head } = await startedTeam(G);
  for (let p = 1; p <= 3; p++) {
    const rs = await solvePhase(head, G, p);
    assert.ok(rs.every((r) => r.data.correct), `phase ${p}`);
  }
  let st = await state(head);
  assert.equal(st.state, 'FINAL_DEDUCTION');
  assert.equal(st.scores.total_pts, 80, '8 questions x 10');
  assert.equal(st.final.mechanism.options.length, 4);
  assert.ok(st.final.mechanism.options.every((o) => Object.keys(o).sort().join() === 'id,label'), 'options carry no correctness flag');

  // wrong culprit: -2, retry allowed; same for a wrong explanation
  const wrongChar = st.roster.find((c) => c.id !== G.culpritId);
  const w = await final(head, 'culprit', wrongChar.id);
  assert.equal(w.data.correct, false);
  assert.equal(w.data.points_awarded, -2);
  assert.equal((await state(head)).state, 'FINAL_DEDUCTION');
  const wrongOpt = G.options.find((o) => !o.correct);
  assert.equal((await final(head, 'mechanism', wrongOpt.id)).data.points_awarded, -2);
  assert.equal((await state(head)).scores.total_pts, 76);

  // first component right: not finished yet
  const a = await final(head, 'culprit', G.culpritId);
  assert.equal(a.data.correct, true);
  assert.equal(a.data.points_awarded, 12);
  assert.equal(a.data.finished, false);
  assert.equal((await state(head)).state, 'FINAL_DEDUCTION');
  assert.equal((await state(head)).solution, null, 'the resolution stays hidden until both parts are resolved');
  // resolved components cannot be resolved (or scored) twice
  const dup = await final(head, 'culprit', G.culpritId);
  assert.equal(dup.data.already_resolved, true);
  assert.equal(dup.data.points_awarded, 0);

  const b = await final(head, 'mechanism', G.options.find((o) => o.correct).id);
  assert.equal(b.data.correct, true);
  assert.equal(b.data.finished, true);
  st = await state(head);
  assert.equal(st.state, 'FINISHED');
  assert.equal(st.scores.total_pts, 76 + 12 + 8);
  assert.ok(st.team.finished_at);
  assert.equal(st.solution.culprit, G.def.culpritName);
  assert.equal(st.scores.by_component.culprit, 12);
  assert.equal(st.scores.by_component.mechanism, 8);
  assert.equal((await pool.query("select status from team_case_assignments where team_id = (select id from teams where registration_id = $1)", [(await pool.query('select registration_id from teams t join players p on p.team_id = t.id where p.id = $1', [st.me.player_id])).rows[0].registration_id])).rows[0].status, 'completed');
  // nothing more can be scored on a closed case
  assert.equal((await final(head, 'culprit', G.culpritId)).status, 409);
  assert.equal((await submit(head, G.tasks[0].id, answerValue(G.tasks[0]))).status, 409);
});

test('a flawless run scores exactly 100 on both tracks', async () => {
  for (const game of [G, L]) {
    const { head } = await startedTeam(game);
    await solveAll(head, game);
    await finishFinal(head, game);
    const st = await state(head);
    assert.equal(st.state, 'FINISHED', game.def.code);
    assert.equal(st.scores.total_pts, 100, game.def.code);
  }
});

test('the final deduction is closed until every required thread is cleared, and rejects foreign ids', async () => {
  const { head } = await startedTeam(G);
  assert.equal((await final(head, 'culprit', G.culpritId)).status, 409);
  assert.equal((await head.post('/api/submit-final', { component: 'nonsense', value: G.culpritId })).status, 400);
  for (let p = 1; p <= 3; p++) await solvePhase(head, G, p);
  const foreign = L.options[0].id;
  assert.equal((await final(head, 'mechanism', foreign)).status, 404, "another case's option");
  assert.equal((await final(head, 'culprit', randomUUID())).status, 404);
  assert.equal((await final(head, 'culprit', L.culpritId)).status, 404, "another case's character");
  assert.equal((await state(head)).scores.total_pts, 80, 'rejected ids cost nothing');
});

test('final attempts are idempotent, and guessing is rate limited per team', async () => {
  const { head } = await startedTeam(G);
  for (let p = 1; p <= 3; p++) await solvePhase(head, G, p);
  const st = await state(head);
  const wrongChar = st.roster.find((c) => c.id !== G.culpritId);
  const key = randomUUID();
  const one = await final(head, 'culprit', wrongChar.id, key);
  const two = await final(head, 'culprit', wrongChar.id, key);
  assert.equal(two.data.replayed, true);
  assert.equal((await state(head)).scores.total_pts, 78, 'the penalty was charged once');
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await final(head, 'culprit', wrongChar.id);
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'brute forcing the final deduction is throttled');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  void one;
});

test('thread assignment: the head can hand threads out, investigators can only take unassigned ones; it never gates answering', async () => {
  const { head, inv } = await startedTeam(G, 1);
  const st = await state(head);
  const thread = st.threads[0];
  const invId = st.players.find((p) => p.role === 'investigator').id;
  assert.equal((await inv[0].post('/api/assign-thread', { thread_id: thread.id, player_id: st.me.player_id })).status, 403, 'an investigator cannot assign to someone else');
  assert.equal((await head.post('/api/assign-thread', { thread_id: thread.id, player_id: invId })).status, 200);
  assert.equal((await state(inv[0])).threads[0].assigned_to, invId);
  assert.equal((await inv[0].post('/api/assign-thread', { thread_id: thread.id })).status, 200, 'taking your own thread again is fine');
  // the head can answer a question in a thread assigned to the investigator
  const q = task(G, 't1a', 0);
  assert.equal((await submit(head, q.id, answerValue(q))).data.correct, true);
  // an investigator cannot grab a thread assigned to a teammate
  assert.equal((await head.post('/api/assign-thread', { thread_id: thread.id, player_id: st.me.player_id })).status, 200);
  assert.equal((await inv[0].post('/api/assign-thread', { thread_id: thread.id })).status, 409);
  // unknown thread / player
  assert.equal((await head.post('/api/assign-thread', { thread_id: randomUUID(), player_id: invId })).status, 404);
  assert.equal((await head.post('/api/assign-thread', { thread_id: thread.id, player_id: randomUUID() })).status, 404);
});

test('a solo player (team of one) can complete every question and finish', async () => {
  const reg = await G.register({ size: 1 });
  const head = new Client();
  assert.equal((await head.headJoin(G, reg)).status, 200);
  assert.equal((await head.post('/api/start')).status, 200);
  await solveAll(head, G);
  await finishFinal(head, G);
  const st = await state(head);
  assert.equal(st.state, 'FINISHED');
  assert.equal(st.players.length, 1);
});

test('nothing is accepted before the investigation starts or while the game is paused', async () => {
  const t = await makeTeam(G, 0);
  const q = task(G, 't1a', 0);
  assert.equal((await submit(t.head, q.id, answerValue(q))).status, 409);
  assert.equal((await hint(t.head, q.id)).status, 409);
  assert.equal((await t.head.post('/api/start')).status, 200);
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
  const code = t.teamCode.replace('-', '');
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: code, paused: true })).status, 200);
  assert.equal((await submit(t.head, q.id, answerValue(q))).status, 423);
  assert.equal((await hint(t.head, q.id)).status, 423);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: code, paused: false })).status, 200);
  assert.equal((await submit(t.head, q.id, answerValue(q))).data.correct, true);
});

test('submissions are rate limited per player (11th in a minute) without awarding anything', async () => {
  const { head } = await startedTeam(G);
  const q = task(G, 't1a', 0);
  for (let i = 0; i < 10; i++) assert.equal((await submit(head, q.id, wrongValue(q))).status, 200);
  const over = await submit(head, q.id, answerValue(q));
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal(flattenQuestions(await state(head)).find((x) => x.id === q.id).completed, false);
});

test('a forged body cannot name the team, case, phase, role, points or result', async () => {
  const { head, inv } = await startedTeam(G, 1);
  const q = task(G, 't1a', 0);
  const r = await head.post('/api/submit-task', {
    task_id: q.id,
    value: wrongValue(q),
    idempotency_key: randomUUID(),
    team_id: randomUUID(),
    case_id: L.caseId,
    phase: 3,
    points: 1000,
    is_correct: true,
    correct: true,
    role: 'head',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, false);
  assert.equal((await state(head)).scores.total_pts, 0);
  assert.equal((await inv[0].post('/api/start', { role: 'head' })).status, 403, 'a forged role does not make an investigator the head');
});
