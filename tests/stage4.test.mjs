import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeCase, makeRealCase, submit, Client, rawCode, solvePhase } from './helpers.mjs';

const pool = db();
let S; // stub case (fast: answers submitted directly)
let R; // real case (full playthrough through the console)

before(async () => {
  S = await makeCase(pool);
  R = await makeRealCase(pool);
});
after(async () => {
  await S.cleanup();
  await R.cleanup();
  await pool.end();
});

async function teamOn(c, name = 'Head', teamName) {
  const head = new Client();
  const r = await head.post('/api/join', {
    case_code: c.caseCode,
    case_password: c.password,
    display_name: name,
    idempotency_key: randomUUID(),
    ...(teamName ? { team_name: teamName } : {}),
  });
  assert.equal(r.status, 200, r.text);
  assert.equal((await head.post('/api/start')).status, 200);
  return { head, teamCode: r.data.team.team_code };
}

// Clears all 3 phases of the stub case by submitting the known answers.
async function toFinalDeduction(head, c) {
  for (const p of [1, 2, 3]) for (const t of c.byPhase(p)) assert.equal((await submit(head, t.id, t.correct_answer)).data.correct, true);
  assert.equal((await head.get('/api/state')).data.state, 'FINAL_DEDUCTION');
}
const culprit = (client, id) => client.post('/api/submit-culprit', { character_id: id });
const dbTeam = async (code) =>
  (
    await pool.query(
      `select t.finished_at, tp.state, sc.total_pts, sc.culprit_pts,
              (select count(*)::int from culprit_submission cs where cs.team_id = t.id) as culprit_rows
         from teams t join team_progress tp on tp.team_id = t.id join team_scores sc on sc.team_id = t.id
        where t.team_code = $1`,
      [rawCode(code)],
    )
  ).rows[0];

test('culprit submission before Phase 3 clears is rejected (every earlier state)', async () => {
  const waiting = new Client();
  const r0 = await waiting.post('/api/join', { case_code: S.caseCode, case_password: S.password, display_name: 'W', idempotency_key: randomUUID() });
  assert.equal((await culprit(waiting, S.culpritId)).status, 409); // WAITING

  const { head, teamCode } = await teamOn(S);
  assert.equal((await culprit(head, S.culpritId)).status, 409); // PHASE_1
  for (const t of S.byPhase(1)) await submit(head, t.id, t.correct_answer);
  assert.equal((await culprit(head, S.culpritId)).status, 409); // PHASE_2
  for (const t of S.byPhase(2)) await submit(head, t.id, t.correct_answer);
  assert.equal((await culprit(head, S.culpritId)).status, 409); // PHASE_3
  const d = await dbTeam(teamCode);
  assert.equal(d.culprit_rows, 0);
  assert.equal(d.finished_at, null);
  assert.equal(d.total_pts, 40);
  void r0;
});

test('correct culprit: +40 (total 100 on the full real case), finished_at stamped, state FINISHED', async () => {
  const { head, teamCode } = await teamOn(R);
  const ros = (await head.get('/api/state')).data.roster;
  for (const p of [1, 2, 3]) {
    const rs = await solvePhase(head, R, p, ros);
    assert.ok(rs.every((x) => x.data.correct));
  }
  const st0 = (await head.get('/api/state')).data;
  assert.equal(st0.state, 'FINAL_DEDUCTION');
  assert.deepEqual(st0.culprit, { submitted: false });
  assert.ok(!JSON.stringify(st0).includes(R.culpritId) || st0.roster.some((c) => c.id === R.culpritId)); // only via roster

  const before = Date.now();
  const r = await culprit(head, R.culpritId);
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, true);
  assert.equal(r.data.total_pts, 100);

  const d = await dbTeam(teamCode);
  assert.equal(d.state, 'FINISHED');
  assert.equal(d.total_pts, 100);
  assert.equal(d.culprit_pts, 40);
  assert.equal(d.culprit_rows, 1);
  assert.ok(d.finished_at && Math.abs(new Date(d.finished_at).getTime() - before) < 15000, 'finished_at is the server time');
  const cs = (await pool.query('select cs.* from culprit_submission cs join teams t on t.id = cs.team_id where t.team_code = $1', [rawCode(teamCode)])).rows[0];
  assert.equal(cs.is_correct, true);
  assert.equal(cs.chosen_character_id, R.culpritId);
  assert.ok(cs.submitted_at);

  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'FINISHED');
  assert.equal(st.scores.total_pts, 100);
  assert.equal(st.culprit.correct, true);
  assert.ok(st.team.finished_at);
  // gameplay endpoints are closed after finishing
  assert.equal((await submit(head, R.byPhase(3)[0].id, 'x')).status, 409);
});

test('wrong culprit: 0 culprit points, finished_at still stamped, one shot only', async () => {
  const { head, teamCode } = await teamOn(S);
  await toFinalDeduction(head, S);
  const r = await culprit(head, S.wrongCulpritId);
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, false);
  assert.equal(r.data.total_pts, 60);
  const d = await dbTeam(teamCode);
  assert.equal(d.state, 'FINISHED');
  assert.equal(d.culprit_pts, 0);
  assert.equal(d.total_pts, 60);
  assert.ok(d.finished_at);
  // no second chance with the right answer
  const again = await culprit(head, S.culpritId);
  assert.equal(again.status, 409);
  assert.equal((await dbTeam(teamCode)).total_pts, 60);
});

test('resubmitting a culprit is rejected: no double submission, no score change', async () => {
  const { head, teamCode } = await teamOn(S);
  await toFinalDeduction(head, S);
  assert.equal((await culprit(head, S.culpritId)).status, 200);
  const before = await dbTeam(teamCode);
  for (const id of [S.culpritId, S.wrongCulpritId, S.culpritId]) assert.equal((await culprit(head, id)).status, 409);
  assert.deepEqual(await dbTeam(teamCode), before);
  assert.equal(before.total_pts, 100);
});

test('five simultaneous culprit submissions: exactly one wins, +40 once', async () => {
  const { head, teamCode } = await teamOn(S);
  await toFinalDeduction(head, S);
  const rs = await Promise.all(Array.from({ length: 5 }, () => culprit(head, S.culpritId)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 4);
  const d = await dbTeam(teamCode);
  assert.equal(d.culprit_rows, 1);
  assert.equal(d.total_pts, 100);
});

test('invalid character ids are rejected without consuming the one shot', async () => {
  const { head, teamCode } = await teamOn(S);
  await toFinalDeduction(head, S);
  assert.equal((await culprit(head, 'nope')).status, 400);
  assert.equal((await culprit(head, randomUUID())).status, 404);
  assert.equal((await culprit(head, R.culpritId)).status, 404); // a character from ANOTHER case
  assert.equal((await head.post('/api/submit-culprit', {})).status, 400);
  assert.equal((await dbTeam(teamCode)).culprit_rows, 0);
  assert.equal((await culprit(head, S.culpritId)).status, 200);
});

test('a forged body cannot name the team, case or result', async () => {
  const { head, teamCode } = await teamOn(S);
  await toFinalDeduction(head, S);
  const r = await head.post('/api/submit-culprit', {
    character_id: S.wrongCulpritId,
    is_correct: true,
    team_id: randomUUID(),
    case_id: R.caseId,
    culprit_pts: 40,
  });
  assert.equal(r.data.correct, false);
  assert.equal((await dbTeam(teamCode)).total_pts, 60);
});

test('leaderboard: public, no credentials, sorted by points; tie broken by earliest CORRECT culprit time', async () => {
  const tag = randomUUID().slice(0, 6);
  const mk = async (label, correct) => {
    const { head, teamCode } = await teamOn(S, 'Head', `${label}-${tag}`);
    await toFinalDeduction(head, S);
    return { head, teamCode, label: `${label}-${tag}`, correct };
  };
  const a = await mk('TieA', true);
  const b = await mk('TieB', true);
  const c = await mk('Low', false);
  // B submits first, then A, then C (wrong)
  assert.equal((await culprit(b.head, S.culpritId)).data.total_pts, 100);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await culprit(a.head, S.culpritId)).data.total_pts, 100);
  assert.equal((await culprit(c.head, S.wrongCulpritId)).data.total_pts, 60);

  const anon = new Client(); // no session
  const lb = async () => (await anon.get('/api/leaderboard')).data.teams.filter((t) => t.team_name.endsWith(`-${tag}`));
  let rows = await lb();
  assert.deepEqual(rows.map((r) => r.team_name), [b.label, a.label, c.label]);
  assert.deepEqual(rows.map((r) => r.total_pts), [100, 100, 60]);
  assert.ok(rows.every((r) => r.finished && r.phases_cleared === 3));
  assert.ok(rows[0].rank < rows[1].rank && rows[1].rank < rows[2].rank);

  // flip the server timestamps: A now has the earlier correct submission -> A outranks B
  await pool.query(
    `update culprit_submission set submitted_at = now() - interval '1 hour'
      where team_id = (select id from teams where team_code = $1)`,
    [rawCode(a.teamCode)],
  );
  rows = await lb();
  assert.deepEqual(rows.map((r) => r.team_name), [a.label, b.label, c.label]);

  // a wrong culprit with an early timestamp never beats a correct one on the tie-break (it has fewer points)
  const txt = JSON.stringify((await anon.get('/api/leaderboard')).data);
  for (const t of [a, b, c]) assert.ok(!txt.includes(rawCode(t.teamCode)), 'team codes must not be public');
  assert.ok(!txt.includes(S.caseCode) && !txt.includes(S.caseId) && !txt.includes(S.culpritId));
  assert.deepEqual(Object.keys(rows[0]).sort(), ['case_title', 'elapsed_s', 'finished', 'phases_cleared', 'rank', 'ref', 'state', 'team_name', 'total_pts']);
});

test('default team name is not the team code (the leaderboard is public)', async () => {
  const head = new Client();
  const r = await head.post('/api/join', { case_code: S.caseCode, case_password: S.password, display_name: 'Watson', idempotency_key: randomUUID() });
  assert.equal(r.data.team.team_name, "Watson's team");
  assert.ok(!r.data.team.team_name.includes(rawCode(r.data.team.team_code)));
});
