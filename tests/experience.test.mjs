// Tests for the data behind the redesigned experience: presence, task titles, roster roles, the evidence
// board (verified tasks only) and the case resolution (revealed only to a team that names the culprit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeRealCase, makeCaseFromDefinition, submit, Client, rawCode } from './helpers.mjs';
import { DEFINITIONS } from '../scripts/cases/index.mjs';

const pool = db();
let R;

before(async () => {
  R = await makeRealCase(pool);
});
after(async () => {
  await R.cleanup();
  await pool.end();
});

async function team(n = 1) {
  const head = new Client();
  const r = await head.post('/api/join', { case_code: R.caseCode, case_password: R.password, display_name: 'Head', idempotency_key: randomUUID() });
  assert.equal(r.status, 200, r.text);
  const inv = [];
  for (let i = 0; i < n; i++) {
    const c = new Client();
    assert.equal((await c.joinTeam(r.data.team.team_code, `Inv${i + 1}`)).status, 200);
    inv.push(c);
  }
  await head.post('/api/start');
  return { head, inv, teamCode: r.data.team.team_code };
}
const state = async (c) => (await c.get('/api/state')).data;
const solvePhase = async (c, p) => {
  for (const t of R.byPhase(p)) assert.equal((await submit(c, t.id, t.correct_answer)).data.correct, true);
};

test('presence: players are online right after joining and go offline when they stop polling', async () => {
  const { head, inv, teamCode } = await team(1);
  const st = await state(head);
  assert.ok(st.players.every((p) => p.online === true), 'everyone who just joined is online');
  await pool.query(
    "update players set last_seen_at = now() - interval '2 minutes' where team_id = (select id from teams where team_code = $1) and role = 'investigator'",
    [rawCode(teamCode)],
  );
  const after = await state(head);
  assert.equal(after.players.find((p) => p.role === 'investigator').online, false);
  assert.equal(after.players.find((p) => p.role === 'head').online, true);
  void inv;
});

test('tasks carry titles and evidence kinds; the roster carries public roles but no spoilers', async () => {
  const { head } = await team(0);
  const st = await state(head);
  assert.ok(st.tasks.every((t) => t.title && t.kind));
  assert.ok(st.roster.length === 13 && st.roster.every((c) => typeof c.role === 'string' && c.role.length > 0));
  const text = JSON.stringify(st);
  assert.ok(!/culprit|killer|murderer/i.test(JSON.stringify(st.roster)));
  assert.ok(!text.includes('solution_motive') && !text.includes('quietly selling'), 'resolution text is not in the state');
  assert.equal(st.solution, null);
});

test('evidence board: only verified tasks, only reached phases, answers shown as names, never a locked clue', async () => {
  const { head } = await team(0);
  assert.deepEqual((await state(head)).evidence, []);
  const [t1, t2] = R.byPhase(1);
  await submit(head, t1.id, t1.correct_answer);
  await submit(head, t2.id, 'wrong answer');
  let st = await state(head);
  assert.equal(st.evidence.length, 1);
  assert.equal(st.evidence[0].task_id, t1.id);
  assert.equal(st.evidence[0].value, t1.correct_answer);
  assert.match(st.evidence[0].label, /\{value\}/);

  await submit(head, t2.id, t2.correct_answer);
  const t3 = R.byPhase(1)[2];
  await submit(head, t3.id, t3.correct_answer);
  st = await state(head);
  assert.equal(st.state, 'PHASE_2');
  assert.equal(st.evidence.length, 3);
  const person = st.evidence.find((e) => e.answer_type === 'SINGLE_CHARACTER');
  assert.equal(person.value, 'Jonah Pike', 'a character answer is returned as the name, not an id');
  assert.ok(!JSON.stringify(st.evidence).includes(t3.correct_answer), 'no character id in the evidence');
  // nothing about phase 2 / 3 answers or labels before they are solved
  // (character answers are ids that legitimately appear in the roster dropdown, so only typed answers are checked)
  const later = [...R.byPhase(2), ...R.byPhase(3)].filter((t) => t.answer_type !== 'SINGLE_CHARACTER').map((t) => t.correct_answer).filter((a) => a.length >= 4);
  for (const a of later) assert.ok(!JSON.stringify(st).includes(a), `locked answer "${a}" must not appear`);
  assert.ok(st.evidence.every((e) => e.phase === 1));
});

test('resolution: hidden until a correct accusation; a wrong accusation reveals nothing', async () => {
  const wrong = await team(0);
  const right = await team(1);
  const bystander = await team(0);
  for (const t of [wrong, right, bystander]) for (const p of [1, 2, 3]) await solvePhase(t.head, p);
  assert.equal((await state(wrong.head)).state, 'FINAL_DEDUCTION');
  assert.equal((await state(wrong.head)).solution, null);

  const w = await wrong.head.post('/api/submit-culprit', { character_id: R.characters.find((c) => c.id !== R.culpritId).id });
  assert.equal(w.data.correct, false);
  assert.equal(w.data.solution, null);
  const wst = await state(wrong.head);
  assert.equal(wst.solution, null);
  assert.ok(!JSON.stringify(wst).includes('quietly selling') && !JSON.stringify(w.data).includes('quietly selling'));

  const r = await right.inv[0].post('/api/submit-culprit', { character_id: R.culpritId });
  assert.equal(r.data.correct, true);
  assert.equal(r.data.solution.culprit, 'Marcus Bell');
  assert.ok(r.data.solution.motive && r.data.solution.method && r.data.solution.chain.length >= 3);
  for (const c of [right.head, right.inv[0]]) {
    const st = await state(c);
    assert.equal(st.solution.culprit, 'Marcus Bell');
    assert.deepEqual(st.solution.chain, r.data.solution.chain);
  }
  // a team that has not accused (same case) cannot see it
  assert.equal((await state(bystander.head)).solution, null);
});

test('every one of the 10 cases ships a complete resolution, task titles and evidence labels', async () => {
  for (const def of DEFINITIONS) {
    assert.ok(def.solution?.motive && def.solution?.method && def.solution.chain.length >= 3, `${def.title}: resolution`);
    assert.ok(def.solution.chain.join(' ').includes(def.culpritName.split(' ')[0]), `${def.title}: chain names the culprit`);
    assert.ok(def.tasks.every((t) => t.title && t.kind && t.label.includes('{value}')), `${def.title}: task titles + labels`);
    assert.ok(def.rosterNames.every((n) => def.rosterRoles[n]), `${def.title}: roster roles`);
  }
});

test('a generated case (not just Opening Night) resolves and returns its own resolution', async () => {
  const c = await makeCaseFromDefinition(pool, DEFINITIONS[3]);
  try {
    const head = new Client();
    const r = await head.post('/api/join', { case_code: c.caseCode, case_password: c.password, display_name: 'Gen', idempotency_key: randomUUID() });
    assert.equal(r.status, 200);
    await head.post('/api/start');
    for (const p of [1, 2, 3]) for (const t of c.byPhase(p)) assert.equal((await submit(head, t.id, t.correct_answer)).data.correct, true);
    const out = await head.post('/api/submit-culprit', { character_id: c.culpritId });
    assert.equal(out.data.correct, true);
    assert.equal(out.data.solution.culprit, DEFINITIONS[3].culpritName);
    assert.equal(out.data.solution.motive, DEFINITIONS[3].solution.motive);
  } finally {
    await c.cleanup();
  }
});

test('leaderboard rows have an opaque stable ref that is not a credential or id', async () => {
  const { head, teamCode } = await team(0);
  const a = (await new Client().get('/api/leaderboard')).data.teams;
  const b = (await new Client().get('/api/leaderboard')).data.teams;
  const mine = a.find((t) => t.team_name === "Head's team" && t.ref);
  assert.ok(mine && /^[0-9a-f]{12}$/.test(mine.ref));
  assert.ok(b.some((t) => t.ref === mine.ref), 'stable across requests');
  const ids = (await pool.query('select id, realtime_token from teams where team_code = $1', [rawCode(teamCode)])).rows[0];
  assert.ok(!mine.ref.includes(rawCode(teamCode).toLowerCase()) && !ids.id.includes(mine.ref) && !ids.realtime_token.includes(mine.ref));
  void head;
});
