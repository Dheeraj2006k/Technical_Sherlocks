import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeCase, makeTeam, submit, Client, rawCode } from './helpers.mjs';

const pool = db();
let c;

before(async () => {
  c = await makeCase(pool);
});
after(async () => {
  await c.cleanup();
  await pool.end();
});

const score = async (code) =>
  (
    await pool.query(
      `select ts.* from team_scores ts join teams t on t.id = ts.team_id where t.team_code = $1`,
      [rawCode(code)],
    )
  ).rows[0];

async function startedTeam(investigators = 1) {
  const team = await makeTeam(c, investigators);
  assert.equal((await team.head.post('/api/start')).status, 200);
  return team;
}

test('WAITING: no tasks, narrative, tables or roster until the head starts', async () => {
  const { head, inv } = await makeTeam(c, 1);
  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'WAITING');
  assert.deepEqual(st.tasks, []);
  assert.deepEqual(st.narrative, []);
  assert.deepEqual(st.unlocked_tables, []);
  assert.deepEqual(st.roster, []);
  // investigator cannot start; head can; starting twice is a no-op
  assert.equal((await inv[0].post('/api/start')).status, 403);
  assert.equal((await head.post('/api/start')).data.state, 'PHASE_1');
  assert.equal((await head.post('/api/start')).data.state, 'PHASE_1');
  const after = (await head.get('/api/state')).data;
  assert.equal(after.state, 'PHASE_1');
  assert.equal(after.tasks.length, 3);
  assert.deepEqual(after.unlocked_tables, ['cast_crew']);
});

test('submitting before start is rejected', async () => {
  const { head } = await makeTeam(c, 0);
  const r = await submit(head, c.byPhase(1)[0].id, 'x');
  assert.equal(r.status, 409);
});

test('all 3 phase-1 tasks correct advances to PHASE_2 (checked via /api/state), +20 points', async () => {
  const { head, teamCode } = await startedTeam(0);
  const [t1, t2, t3] = c.byPhase(1);

  assert.equal((await submit(head, t1.id, t1.correct_answer)).data.phase_cleared, false);
  assert.equal((await head.get('/api/state')).data.state, 'PHASE_1');
  await submit(head, t2.id, t2.correct_answer);
  const last = await submit(head, t3.id, t3.correct_answer);
  assert.equal(last.data.phase_cleared, true);

  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'PHASE_2');
  assert.equal(st.current_phase, 2);
  assert.equal(st.scores.phase1_pts, 20);
  assert.equal(st.scores.total_pts, 20);
  assert.equal(st.tasks.length, 3);
  assert.ok(st.tasks.every((t) => !t.solved));
  assert.deepEqual(st.unlocked_tables, ['access_log', 'cast_crew']); // additive
  assert.equal(st.narrative.length, 2);
  assert.equal((await score(teamCode)).total_pts, 20);
});

test('wrong answer: nothing advances, no points, recorded as incorrect', async () => {
  const { head, teamCode } = await startedTeam(0);
  const [t1] = c.byPhase(1);
  const r = await submit(head, t1.id, c.characters[0].id);
  assert.equal(r.data.correct, false);
  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'PHASE_1');
  assert.equal(st.scores.total_pts, 0);
  assert.equal(st.tasks.find((t) => t.id === t1.id).solved, false);
  const rows = (
    await pool.query(
      'select is_correct from task_submissions ts join teams t on t.id = ts.team_id where t.team_code = $1',
      [rawCode(teamCode)],
    )
  ).rows;
  assert.deepEqual(rows, [{ is_correct: false }]);
});

test('duplicate correct answer is a no-op: no double score, no extra correct row', async () => {
  const { head, teamCode } = await startedTeam(0);
  const phase1 = c.byPhase(1);
  for (const t of phase1) await submit(head, t.id, t.correct_answer);
  // phase 1 now cleared (state PHASE_2); resubmitting a phase-1 task is rejected, score stays 20
  const again = await submit(head, phase1[0].id, phase1[0].correct_answer);
  assert.equal(again.status, 404);
  // duplicate within the same phase
  const p2 = c.byPhase(2)[0];
  assert.equal((await submit(head, p2.id, p2.correct_answer)).data.already_solved, false);
  const dup = await submit(head, p2.id, p2.correct_answer);
  assert.equal(dup.status, 200);
  assert.equal(dup.data.already_solved, true);
  assert.equal((await score(teamCode)).total_pts, 20);
  const n = (
    await pool.query(
      `select count(*)::int n from task_submissions ts join teams t on t.id = ts.team_id
        where t.team_code = $1 and ts.task_id = $2 and ts.is_correct`,
      [rawCode(teamCode), p2.id],
    )
  ).rows[0].n;
  assert.equal(n, 1);
});

test('client cannot set phase, team_id or role: body fields are ignored', async () => {
  const other = await startedTeam(0);
  const { head, inv, teamCode } = await startedTeam(1);
  const otherId = (await other.head.get('/api/state')).data.me.player_id;

  // Task from phase 3 while in phase 1 is rejected even with a body claiming phase 3.
  const p3 = c.byPhase(3)[0];
  const r = await head.post('/api/submit-task', {
    task_id: p3.id,
    value: p3.correct_answer,
    phase: 3,
    current_phase: 3,
    team_id: 'whatever',
  });
  assert.equal(r.status, 404);
  assert.equal((await head.get('/api/state')).data.state, 'PHASE_1');

  // A valid task with forged team_id/role is credited to the session's own team.
  const t1 = c.byPhase(1)[0];
  const ok = await inv[0].post('/api/submit-task', {
    task_id: t1.id,
    value: t1.correct_answer,
    team_id: (await pool.query('select id from teams where team_code = $1', [rawCode(other.teamCode)])).rows[0].id,
    role: 'head',
    player_id: otherId,
  });
  assert.equal(ok.data.correct, true);
  const mine = (await head.get('/api/state')).data.tasks.find((t) => t.id === t1.id);
  const theirs = (await other.head.get('/api/state')).data.tasks.find((t) => t.id === t1.id);
  assert.equal(mine.solved, true);
  assert.equal(theirs.solved, false);
  const sub = (
    await pool.query(
      `select p.role from task_submissions ts join players p on p.id = ts.player_id
         join teams t on t.id = ts.team_id where t.team_code = $1 and ts.task_id = $2`,
      [rawCode(teamCode), t1.id],
    )
  ).rows;
  assert.deepEqual(sub, [{ role: 'investigator' }]);

  // Role claim in body does not grant head powers.
  assert.equal((await inv[0].post('/api/start', { role: 'head' })).status, 403);
  const t2 = c.byPhase(1)[1];
  const re = await inv[0].post('/api/assign-task', { task_id: t2.id, player_id: otherId, role: 'head' });
  assert.equal(re.status, 403);
});

test('tampered or forged cookies are rejected', async () => {
  const { head } = await startedTeam(0);
  const good = head.cookie; // slc_session=<jwt>
  const [name, jwt] = [good.slice(0, good.indexOf('=')), good.slice(good.indexOf('=') + 1)];
  const parts = jwt.split('.');

  const flipped = parts[2].slice(0, -2) + (parts[2].endsWith('AA') ? 'BB' : 'AA');
  const badSig = `${name}=${parts[0]}.${parts[1]}.${flipped}`;
  assert.equal((await new Client().get('/api/state', { rawCookie: badSig })).status, 401);

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  payload.role = 'head';
  payload.team_id = '00000000-0000-4000-8000-00000000dead';
  const forged = `${name}=${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
  assert.equal((await new Client().get('/api/state', { rawCookie: forged })).status, 401);

  const none = `${name}=${parts[0]}.${parts[1]}.`;
  assert.equal((await new Client().get('/api/state', { rawCookie: none })).status, 401);
  assert.equal((await new Client().get('/api/state', { rawCookie: `${name}=garbage` })).status, 401);
  assert.equal((await head.get('/api/state')).status, 200);
});

test('session is invalidated when the player/team rows are deleted (admin reset)', async () => {
  const { head, teamCode } = await startedTeam(0);
  assert.equal((await head.get('/api/state')).status, 200);
  await pool.query('delete from teams where team_code = $1', [rawCode(teamCode)]);
  assert.equal((await head.get('/api/state')).status, 401);
});

test('two teammates submitting different tasks at the same instant: advances once, exactly +20', async () => {
  for (let round = 0; round < 3; round++) {
    const { head, inv, teamCode } = await startedTeam(1);
    const [t1, t2, t3] = c.byPhase(1);
    await submit(head, t1.id, t1.correct_answer);
    const [ra, rb] = await Promise.all([submit(head, t2.id, t2.correct_answer), submit(inv[0], t3.id, t3.correct_answer)]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.equal([ra, rb].filter((r) => r.data.phase_cleared).length, 1, 'exactly one request clears the phase');
    const st = (await head.get('/api/state')).data;
    assert.equal(st.state, 'PHASE_2');
    assert.equal(st.scores.total_pts, 20);
    assert.equal((await score(teamCode)).phase1_pts, 20);
  }
});

test('same final task submitted concurrently by two players: still exactly +20', async () => {
  const { head, inv, teamCode } = await startedTeam(1);
  const [t1, t2, t3] = c.byPhase(1);
  await submit(head, t1.id, t1.correct_answer);
  await submit(head, t2.id, t2.correct_answer);
  const rs = await Promise.all([submit(head, t3.id, t3.correct_answer), submit(inv[0], t3.id, t3.correct_answer)]);
  assert.ok(rs.every((r) => r.status === 200 || r.status === 404)); // loser may land after the advance
  assert.equal((await score(teamCode)).total_pts, 20);
  assert.equal((await head.get('/api/state')).data.state, 'PHASE_2');
});

test('full run through all phases ends in FINAL_DEDUCTION with 60 points', async () => {
  const { head, teamCode } = await startedTeam(0);
  for (const p of [1, 2, 3]) {
    for (const t of c.byPhase(p)) await submit(head, t.id, t.correct_answer);
  }
  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'FINAL_DEDUCTION');
  assert.equal(st.scores.total_pts, 60);
  assert.equal(st.narrative.length, 3);
  assert.deepEqual(st.tasks, []);
  assert.equal((await submit(head, c.byPhase(3)[0].id, 'x')).status, 409);
  const prog = (
    await pool.query(
      'select phase1_cleared a, phase2_cleared b, phase3_cleared c from team_progress tp join teams t on t.id = tp.team_id where t.team_code = $1',
      [rawCode(teamCode)],
    )
  ).rows[0];
  assert.deepEqual(prog, { a: true, b: true, c: true });
});

test('assignment: head assigns/reassigns anyone; investigator may only self-assign unassigned open tasks', async () => {
  const { head, inv } = await startedTeam(2);
  const st = (await head.get('/api/state')).data;
  const [i1, i2] = [st.players.find((p) => p.display_name === 'Inv1'), st.players.find((p) => p.display_name === 'Inv2')];
  const [t1, t2, t3] = c.byPhase(1);

  assert.equal((await head.post('/api/assign-task', { task_id: t1.id, player_id: i1.id })).status, 200);
  assert.equal((await head.post('/api/assign-task', { task_id: t1.id, player_id: i2.id })).status, 200); // reassign
  let tasks = (await head.get('/api/state')).data.tasks;
  assert.equal(tasks.find((t) => t.id === t1.id).assigned_to, i2.id);

  // investigator cannot take an assigned task, cannot assign to others
  assert.equal((await inv[0].post('/api/assign-task', { task_id: t1.id })).status, 409);
  assert.equal((await inv[0].post('/api/assign-task', { task_id: t2.id, player_id: i2.id })).status, 403);
  // self-assign unassigned works; repeating is fine
  assert.equal((await inv[0].post('/api/assign-task', { task_id: t2.id })).status, 200);
  assert.equal((await inv[0].post('/api/assign-task', { task_id: t2.id })).status, 200);
  tasks = (await head.get('/api/state')).data.tasks;
  assert.equal(tasks.find((t) => t.id === t2.id).assigned_to, i1.id);

  // cannot assign to a player outside the team, nor a task from another phase, nor a solved task
  assert.equal((await head.post('/api/assign-task', { task_id: t3.id, player_id: '00000000-0000-4000-8000-00000000beef' })).status, 404);
  assert.equal((await head.post('/api/assign-task', { task_id: c.byPhase(2)[0].id, player_id: i1.id })).status, 404);
  await submit(head, t3.id, t3.correct_answer);
  assert.equal((await head.post('/api/assign-task', { task_id: t3.id, player_id: i1.id })).status, 409);
});

test('investigators racing to self-assign the same task: exactly one wins', async () => {
  const { inv } = await startedTeam(2);
  const t = c.byPhase(1)[0];
  const rs = await Promise.all(inv.map((x) => x.post('/api/assign-task', { task_id: t.id })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
});

test('/api/state never leaks correct_answer or content of unreached phases', async () => {
  const { head, inv } = await startedTeam(1);
  // Stub prompts for reached tasks state their answer ("Type the code word ALPHA-7"), so only
  // answers belonging to UNREACHED phases are asserted absent. Short ones ("5") can't substring-match.
  const hiddenAnswers = (reached) =>
    c.tasks.filter((t) => t.phase > reached && t.answer_type !== 'SINGLE_CHARACTER' && t.correct_answer.length >= 4).map((t) => t.correct_answer);

  const check = async (reachedPhase) => {
    for (const cl of [head, inv[0]]) {
      const { text, data } = await cl.get('/api/state');
      assert.ok(!text.includes('correct_answer'), 'no correct_answer key');
      for (const a of hiddenAnswers(reachedPhase)) assert.ok(!text.includes(a), `answer "${a}" must not appear`);
      for (let p = 1; p <= 3; p++) {
        const present = text.includes(`CLUE_PHASE_${p}${c.tag}`) || text.includes(`[P${p}${c.tag}]`);
        assert.equal(present, p <= reachedPhase, `phase ${p} content visibility at phase ${reachedPhase}`);
      }
      assert.ok(data.tasks.every((t) => !('correct_answer' in t)));
    }
  };
  await check(1);
  for (const t of c.byPhase(1)) await submit(head, t.id, t.correct_answer);
  await check(2);
  for (const t of c.byPhase(2)) await submit(head, t.id, t.correct_answer);
  await check(3);
});

test('each answer_type grades correctly (exact match, normalized)', async () => {
  const run = async (phase, idx, wrongs, rights) => {
    const { head } = await startedTeam(0);
    for (let p = 1; p < phase; p++) for (const t of c.byPhase(p)) await submit(head, t.id, t.correct_answer);
    const t = c.byPhase(phase)[idx];
    for (const w of wrongs) assert.equal((await submit(head, t.id, w)).data.correct, false, `wrong: ${w}`);
    for (const r of rights) {
      const { head: h2 } = await startedTeam(0);
      for (let p = 1; p < phase; p++) for (const x of c.byPhase(p)) await submit(h2, x.id, x.correct_answer);
      assert.equal((await submit(h2, t.id, r)).data.correct, true, `right: ${r}`);
    }
  };
  // SINGLE_CHARACTER (p1 easy): exact character id
  await run(1, 0, [c.characters[0].id, 'nobody'], [c.characters[2].id, c.characters[2].id.toUpperCase()]);
  // NUMBER (p1 medium "5"): numeric equality after normalization
  await run(1, 1, ['6', '5x', 'five', '4.99'], ['5', ' 5 ', '5.0', '05']);
  // TIME (p1 hard "21:45"): canonical HH:MM
  await run(1, 2, ['21:46', '9:45', '2145', '25:00', '21:45:00'], ['21:45']);
  // TIME with zero padding (p3 easy "09:05"): H:MM and HH:MM both accepted
  await run(3, 0, ['09:06', '9:6'], ['09:05', '9:05']);
  // TEXT (p2 medium "ALPHA-7"): trimmed, case-insensitive, otherwise exact
  await run(2, 1, ['ALPHA7', 'alpha - 7', 'ALPHA-8'], ['ALPHA-7', ' alpha-7 ', 'Alpha-7']);
  // NUMBER decimal (p3 hard "3.5")
  await run(3, 2, ['3', '3.51'], ['3.5', '3.50']);
});
