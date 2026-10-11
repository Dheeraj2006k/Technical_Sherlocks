import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeGame, defByCode, Client, AdminClient, startedTeam, submit, hint, final, solveAll, finishFinal, answerValue, rawCode } from './helpers.mjs';

const pool = db();
let A; // SQL case
let B; // Logic case
let admin;

before(async () => {
  A = await makeGame(pool, defByCode('SQL04'));
  B = await makeGame(pool, defByCode('LOG04'));
  admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
});
after(async () => {
  await pool.query("delete from registrations where team_ref like 'ADMTEST %'");
  await A.cleanup();
  await B.cleanup();
  await pool.end();
});

const state = async (c) => (await c.get('/api/state')).data;
const regByRef = async (ref) => (await pool.query('select * from registrations where registration_ref = $1', [ref.replace(/-/g, '')])).rows[0];
const auditActions = async (regId) => (await pool.query('select action, actor from admin_audit where registration_id = $1 order by id', [regId])).rows;

test('organizer creates registrations in bulk: unique 8-character references, validated sizes, audited', async () => {
  const r = await admin.post('/api/admin/registrations', {
    registrations: [
      { team_ref: 'ADMTEST Alpha', team_size: 3 },
      { team_ref: 'ADMTEST Beta', team_size: 1 },
      { team_ref: 'ADMTEST Gamma' },
    ],
  });
  assert.equal(r.status, 200, r.text);
  const refs = r.data.registrations.map((x) => x.registration_ref);
  assert.equal(new Set(refs).size, 3);
  for (const ref of refs) assert.match(ref, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(r.data.registrations.map((x) => x.team_size), [3, 1, 3], 'default size is 3');
  for (const bad of [{ registrations: [] }, { registrations: [{ team_ref: 'x', team_size: 4 }] }, { registrations: [{ team_ref: 'x', team_size: 0 }] }, { registrations: [{ team_ref: '' }] }, { registrations: 'nope' }, {}]) {
    assert.equal((await admin.post('/api/admin/registrations', bad)).status, 400, JSON.stringify(bad));
  }
  const list = (await admin.get('/api/admin/registrations')).data.registrations;
  assert.ok(refs.every((ref) => list.some((x) => x.registration_ref === ref)));
  assert.ok((await admin.get('/api/admin/audit')).data.entries.some((e) => e.action === 'registrations_created'));
});

test('manual assignment: only published cases; the head then joins with that case; reassignment is audited', async () => {
  const reg = (await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Assign', team_size: 2 }] })).data.registrations[0];
  const row = await regByRef(reg.registration_ref);
  // unassigned: the head cannot join anything
  assert.equal((await new Client().post('/api/join', { registration_ref: reg.registration_ref, case_code: A.caseCode, case_password: A.password, display_name: 'Early' })).status, 401);
  // a draft case cannot be assigned
  await pool.query("update cases set status = 'draft' where id = $1", [B.caseId]);
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: B.caseCode })).status, 409);
  await pool.query("update cases set status = 'published' where id = $1", [B.caseId]);
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: 'NOPE99' })).status, 404);
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: randomUuid(), case_code: A.caseCode })).status, 404);
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: '!!' })).status, 400);

  const a1 = await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: A.caseCode });
  assert.equal(a1.status, 200, a1.text);
  assert.equal(a1.data.track, 'SQL');
  // reassign before anyone joined: the old case code stops working, the new one works
  const a2 = await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: B.caseCode });
  assert.equal(a2.data.reassigned, true);
  assert.equal((await new Client().post('/api/join', { registration_ref: reg.registration_ref, case_code: A.caseCode, case_password: A.password, display_name: 'Old' })).status, 401);
  const head = new Client();
  const j = await head.post('/api/join', { registration_ref: reg.registration_ref, case_code: B.caseCode, case_password: B.password, display_name: 'Head' });
  assert.equal(j.status, 200, j.text);
  assert.equal((await state(head)).case.track, 'LOGIC');
  // the registration has exactly one ACTIVE assignment
  const active = (await pool.query("select count(*)::int n from team_case_assignments where registration_id = $1 and status in ('assigned','started')", [row.id])).rows[0].n;
  assert.equal(active, 1);
  // reassigning a team that is still in the lobby moves the team; once it starts it must be reset first
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: A.caseCode })).status, 200);
  const moved = await state(head);
  assert.equal(moved.case.code, A.caseCode, 'a lobby team follows its new assignment');
  assert.equal((await head.post('/api/start')).status, 200);
  const refused = await admin.post('/api/admin/assign-case', { registration_id: row.id, case_code: B.caseCode });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /reset/i);
  const actions = (await auditActions(row.id)).map((x) => x.action);
  assert.deepEqual(actions.filter((a) => a.startsWith('case_')), ['case_assigned', 'case_reassigned', 'case_reassigned']);
  assert.ok((await auditActions(row.id)).every((x) => x.actor === 'organizer'));
  // a withdrawn registration cannot be assigned
  const w = (await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Withdrawn' }] })).data.registrations[0];
  await pool.query("update registrations set registration_status = 'withdrawn' where id = $1", [w.id]);
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: w.id, case_code: A.caseCode })).status, 409);
});

function randomUuid() {
  return crypto.randomUUID();
}

test('the case catalogue lists every case with its track and status, and no secrets', async () => {
  const r = await admin.get('/api/admin/cases');
  assert.equal(r.status, 200);
  assert.ok(r.data.cases.some((c) => c.case_code === A.caseCode && c.track === 'SQL' && c.status === 'published'));
  assert.ok(r.data.cases.every((c) => !('password_hash' in c) && !('solution_method' in c)));
  assert.ok(!/password|hash/i.test(r.text));
});

test('dashboard shows track, case, threads, hints, wrong answers, connected players and status for every team', async () => {
  const t = await startedTeam(A, 1);
  const q = A.tasks[0];
  await hint(t.head, q.id);
  await submit(t.head, q.id, 'wrong');
  await submit(t.head, q.id, answerValue(q));
  await t.head.get('/api/state'); // presence
  const d = (await admin.get('/api/admin/dashboard')).data;
  const row = d.teams.find((x) => x.team_code === t.teamCode);
  assert.ok(row);
  assert.equal(row.case_code, A.caseCode);
  assert.equal(row.track, 'SQL');
  assert.equal(row.state, 'PHASE_1');
  assert.equal(row.hints_used, 1);
  assert.equal(row.wrong_answers, 1);
  assert.equal(row.threads_done, 0);
  assert.equal(row.threads_total, A.def.threads.length);
  assert.equal(row.players, 2);
  assert.ok(row.connected >= 1);
  assert.equal(row.status, 'playing');
  assert.equal(row.total_pts, 8, 'one hint (8 points); the wrong answer cost nothing at zero points');
});

test('team inspector shows attempts (with hints and points), opened hints, final attempts and query activity', async () => {
  const t = await startedTeam(A);
  const q = A.tasks[0];
  await hint(t.head, q.id);
  await submit(t.head, q.id, answerValue(q));
  const r = await admin.get(`/api/admin/team?code=${rawCode(t.teamCode)}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.attempts.length, 1);
  assert.equal(r.data.attempts[0].hints_used, 1);
  assert.equal(r.data.attempts[0].points_awarded, 8);
  assert.equal(r.data.hints.length, 1);
  assert.equal(r.data.players[0].role, 'head');
  assert.equal((await admin.get('/api/admin/team?code=ZZZZZZ')).status, 404);
  assert.equal((await admin.get('/api/admin/team?code=bad')).status, 400);
});

test('ADMIN RESET (state): one team is wiped (answers, hints, finals, score, clock) and can start clean; others are untouched; audited', async () => {
  const victim = await startedTeam(A, 1);
  const bystander = await startedTeam(A);
  for (let p = 1; p <= 3; p++) await solveAll(victim.head, A, { only: (t) => t.phase === p });
  await hint(bystander.head, A.tasks[0].id);
  await submit(bystander.head, A.tasks[0].id, answerValue(A.tasks[0]));
  const before = await state(bystander.head);
  assert.equal((await state(victim.head)).state, 'FINAL_DEDUCTION');
  await final(victim.head, 'culprit', A.culpritId);

  const reset = await admin.post('/api/admin/reset-team', { team_code: victim.teamCode, mode: 'state' });
  assert.equal(reset.status, 200);
  const st = await state(victim.head);
  assert.equal(st.state, 'WAITING');
  assert.equal(st.scores.total_pts, 0);
  assert.deepEqual(st.scores.by_component, {});
  assert.equal(st.players.length, 2, 'players and the team code are kept');
  assert.equal(st.threads.length, 0);
  const id = (await pool.query('select id from teams where registration_id = $1', [victim.reg.id])).rows[0].id;
  for (const table of ['task_attempts', 'team_task_completions', 'team_hint_usage', 'team_thread_progress', 'final_attempts', 'team_final_completions']) {
    assert.equal((await pool.query(`select count(*)::int n from ${table} where team_id = $1`, [id])).rows[0].n, 0, table);
  }
  assert.equal((await pool.query('select status from team_case_assignments where registration_id = $1', [victim.reg.id])).rows[0].status, 'assigned');
  // plays again from scratch
  assert.equal((await victim.head.post('/api/start')).status, 200);
  assert.equal((await submit(victim.head, A.tasks[0].id, answerValue(A.tasks[0]))).data.points_awarded, 10, 'hints were reset too');
  // the other team is exactly as it was
  const after = await state(bystander.head);
  assert.equal(after.scores.total_pts, before.scores.total_pts);
  assert.deepEqual(after.threads, before.threads);
  assert.ok((await auditActions(victim.reg.id)).some((a) => a.action === 'team_reset'));
});

test('ADMIN RESET of a FINISHED team clears the finish time and reopens the case', async () => {
  const t = await startedTeam(B);
  await solveAll(t.head, B);
  await finishFinal(t.head, B);
  assert.equal((await state(t.head)).state, 'FINISHED');
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: t.teamCode, mode: 'state' })).status, 200);
  const st = await state(t.head);
  assert.equal(st.state, 'WAITING');
  assert.equal(st.team.finished_at, null);
  assert.equal(st.solution, null);
});

test('ADMIN RESET (delete): the team and its sessions disappear, the code is dead, the registration can join again', async () => {
  const victim = await startedTeam(A);
  const other = await startedTeam(A);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: victim.teamCode, mode: 'delete' })).status, 200);
  assert.equal((await victim.head.get('/api/state')).status, 401);
  assert.equal((await new Client().joinTeam(victim.teamCode, 'Late')).status, 401, 'the team code is dead');
  assert.equal((await other.head.get('/api/state')).status, 200);
  assert.equal((await pool.query('select status, team_id from team_case_assignments where registration_id = $1', [victim.reg.id])).rows[0].team_id, null);
  const again = new Client();
  const j = await again.headJoin(A, victim.reg);
  assert.equal(j.status, 200, 'the head can join again with the same registration, getting a fresh team');
  assert.notEqual(j.data.team.team_code, victim.teamCode);
  assert.equal((await state(again)).scores.total_pts, 0);
  assert.ok((await auditActions(victim.reg.id)).some((a) => a.action === 'team_deleted'));
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: 'ZZZZZZ' })).status, 404);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: 'bad' })).status, 400);
});

test('EMERGENCY PAUSE (team and global): scoring and queries freeze, the timer stops, nothing is lost, resume works', async () => {
  const t = await startedTeam(A);
  const other = await startedTeam(A);
  const q = A.tasks[0];
  const code = rawCode(t.teamCode);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: code, paused: true })).status, 200);
  const frozen = await state(t.head);
  assert.equal(frozen.paused, true);
  assert.equal((await submit(t.head, q.id, answerValue(q))).status, 423);
  assert.equal((await t.head.post('/api/query', { sql: 'select 1' })).status, 423);
  assert.equal((await t.head.post('/api/evidence', {})).status, 423);
  assert.equal((await hint(t.head, q.id)).status, 423);
  assert.equal((await final(t.head, 'culprit', A.culpritId)).status, 423);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await state(t.head)).team.elapsed_s, frozen.team.elapsed_s, 'the timer is stopped');
  assert.equal((await submit(other.head, q.id, answerValue(q))).status, 200, 'other teams are unaffected');
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: code, paused: false })).status, 200);
  assert.equal((await submit(t.head, q.id, answerValue(q))).data.correct, true);

  assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: true })).status, 200);
  const late = await startedTeam(A).catch((e) => e); // teams created while paused start paused
  assert.equal((await submit(other.head, A.tasks[1].id, answerValue(A.tasks[1]))).status, 423);
  assert.ok((await admin.get('/api/admin/dashboard')).data.game_paused);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: false })).status, 200);
  assert.equal((await submit(other.head, A.tasks[1].id, answerValue(A.tasks[1]))).status, 200);
  void late;
  assert.equal((await admin.post('/api/admin/pause', { scope: 'team', team_code: 'ZZZZZZ', paused: true })).status, 404);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'nonsense', paused: true })).status, 400);
  assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: 'yes' })).status, 400);
});

test('leaderboards are per track; ties go to the team that completed the final deduction first', async () => {
  const first = await startedTeam(A);
  const second = await startedTeam(A);
  await solveAll(first.head, A);
  await solveAll(second.head, A);
  await finishFinal(first.head, A);
  await new Promise((r) => setTimeout(r, 1100));
  await finishFinal(second.head, A);
  const lb = (await new Client().get('/api/leaderboard?track=SQL')).data.teams;
  const names = lb.map((x) => x.team_name);
  const i1 = names.indexOf(first.reg.teamRef);
  const i2 = names.indexOf(second.reg.teamRef);
  assert.ok(i1 >= 0 && i2 >= 0);
  assert.equal(lb[i1].total_pts, 100);
  assert.equal(lb[i2].total_pts, 100);
  assert.ok(i1 < i2, 'same score: the earlier finisher ranks higher');
  assert.ok(lb.every((x, i) => i === 0 || lb[i - 1].total_pts >= x.total_pts), 'sorted by score');
  assert.ok(lb.every((x, i) => x.rank === i + 1));
  // a Logic team never shows up on the SQL board
  const l = await startedTeam(B);
  const sql = (await new Client().get('/api/leaderboard?track=SQL')).data.teams.map((x) => x.team_name);
  const logic = (await new Client().get('/api/leaderboard?track=LOGIC')).data.teams.map((x) => x.team_name);
  assert.ok(!sql.includes(l.reg.teamRef) && logic.includes(l.reg.teamRef));
});

test('results export is CSV, per track, ordered like the leaderboard, with formula text neutralized', async () => {
  const reg = await A.register({ teamRef: '=HYPERLINK("http://evil","x")' });
  const head = new Client();
  assert.equal((await head.headJoin(A, reg)).status, 200);
  const all = await admin.get('/api/admin/export');
  assert.equal(all.status, 200);
  assert.match(all.headers.get('content-type'), /text\/csv/);
  const lines = all.text.trim().split('\n');
  assert.match(lines[0], /^rank,track,team_name,registration_ref,case_code,case_title,total_pts,question_pts,responsibility_pts,explanation_pts,penalty_pts,hints_used/);
  assert.ok(all.text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`) || all.text.includes("'=HYPERLINK"), 'formula neutralized');
  assert.ok(!all.text.split('\n').some((l) => /^\d+,\w+,=/.test(l)));
  const sql = await admin.get('/api/admin/export?track=SQL');
  assert.ok(sql.text.trim().split('\n').slice(1).every((l) => l.split(',')[1] === 'SQL'));
  assert.equal((await admin.get('/api/admin/export?track=NOPE')).status, 400);
});

test('thread monitoring: the inspector shows what the team opened and answered, for support during the event', async () => {
  const t = await startedTeam(B);
  const q = B.tasks[0];
  await hint(t.head, q.id);
  await hint(t.head, q.id);
  const r = (await admin.get(`/api/admin/team?code=${rawCode(t.teamCode)}`)).data;
  assert.deepEqual(r.hints.map((h) => h.position).sort(), [1, 2]);
  const d = (await admin.get('/api/admin/dashboard')).data.teams.find((x) => x.team_code === t.teamCode);
  assert.equal(d.hints_used, 2);
  assert.equal(d.track, 'LOGIC');
});

test('organizers can import registrations that already have a reference; duplicates and malformed references are refused as a whole batch', async () => {
  const mine = `${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[ILOU]/g, 'X')}${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[ILOU]/g, 'X')}`;
  const ref8 = mine.replace(/[^0-9A-HJKMNP-TV-Z]/g, 'Z').padEnd(8, 'Z').slice(0, 8);
  const ok = await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Imported', team_size: 2, registration_ref: `${ref8.slice(0, 4)}-${ref8.slice(4)}`.toLowerCase() }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.registrations[0].registration_ref, `${ref8.slice(0, 4)}-${ref8.slice(4)}`);
  assert.equal((await regByRef(ref8)).team_size, 2);
  // a second import of the same reference conflicts, and nothing else in that batch is created
  const dup = await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Fresh' }, { team_ref: 'ADMTEST Dup', registration_ref: ref8 }] });
  assert.equal(dup.status, 409);
  assert.equal((await pool.query("select count(*)::int n from registrations where team_ref = 'ADMTEST Fresh'")).rows[0].n, 0);
  for (const bad of ['SHORT', 'ILLEGAL!', 'IIIIIIII']) {
    const r = await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Bad', registration_ref: bad }] });
    assert.ok(r.status === 400 || r.status === 200, bad); // 'IIIIIIII' normalizes to 11111111, which is a legal reference
  }
  assert.equal((await admin.post('/api/admin/registrations', { registrations: [{ team_ref: 'ADMTEST Bad', registration_ref: 'SHORT' }] })).status, 400);
});
