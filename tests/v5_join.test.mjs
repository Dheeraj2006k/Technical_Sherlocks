import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeGame, defByCode, Client, makeTeam, rawCode } from './helpers.mjs';

const pool = db();
let A; // SQL case
let B; // Logic case

before(async () => {
  A = await makeGame(pool, defByCode('SQL01'));
  B = await makeGame(pool, defByCode('LOG01'));
});
after(async () => {
  await A.cleanup();
  await B.cleanup();
  await pool.end();
});

test('a head joins with registration reference + the assigned case code + case password', async () => {
  const reg = await A.register({ teamRef: 'Byte Detectives' });
  const head = new Client();
  const r = await head.headJoin(A, reg, 'Asha');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.player.role, 'head');
  assert.equal(r.data.team.team_name, 'Byte Detectives', 'team name comes from the registration');
  assert.match(r.data.team.team_code, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'WAITING');
  assert.equal(st.case.code, A.caseCode);
  assert.equal(st.case.track, 'SQL');
  // the assignment is linked to the new team in the same transaction
  const a = (await pool.query('select team_id, status from team_case_assignments where registration_id = $1', [reg.id])).rows[0];
  assert.ok(a.team_id);
  assert.equal(a.status, 'assigned');
});

test('registration reference and case code are accepted in any normalized spelling', async () => {
  const reg = await A.register();
  const spelled = `${reg.ref.slice(0, 4)}-${reg.ref.slice(4)}`.toLowerCase();
  const r = await new Client().post('/api/join', {
    registration_ref: spelled,
    case_code: ` ${A.caseCode.toLowerCase()} `,
    case_password: A.password,
    display_name: 'Case Insensitive',
    idempotency_key: randomUUID(),
  });
  assert.equal(r.status, 200, r.text);
});

test('every credential failure returns the identical 401 body', async () => {
  const reg = await A.register();
  const unassigned = await A.register({ assign: false });
  const withdrawn = await A.register();
  await pool.query("update registrations set registration_status = 'withdrawn' where id = $1", [withdrawn.id]);
  const base = { registration_ref: reg.ref, case_code: A.caseCode, case_password: A.password, display_name: 'X', idempotency_key: randomUUID() };
  const attempts = [
    { ...base, registration_ref: 'ZZZZZZZZ' }, // unknown reference
    { ...base, registration_ref: 'not a ref' }, // malformed
    { ...base, case_code: B.caseCode }, // some other (real) case
    { ...base, case_code: 'NOPE99' }, // unknown case
    { ...base, case_password: 'wrong-password' },
    { ...base, case_password: B.password }, // another case's password
    { ...base, registration_ref: unassigned.ref }, // registered but nothing assigned yet
    { ...base, registration_ref: withdrawn.ref },
    { registration_ref: reg.ref }, // missing fields
    { ...base, case_code: undefined },
  ];
  const seen = new Set();
  for (const a of attempts) {
    const r = await new Client().post('/api/join', a);
    assert.equal(r.status, r.status === 400 ? 400 : 401, JSON.stringify(a));
    if (r.status === 401) seen.add(r.text);
  }
  assert.equal(seen.size, 1, 'all 401 bodies are identical');
  assert.equal((await pool.query('select count(*)::int n from teams where registration_id = any($1)', [[reg.id, unassigned.id, withdrawn.id]])).rows[0].n, 0, 'no team was created by any failed attempt');
});

test('the case comes from the organizer assignment, not from what the head claims', async () => {
  const reg = await A.register(); // assigned to A
  const r = await new Client().post('/api/join', { registration_ref: reg.ref, case_code: B.caseCode, case_password: B.password, display_name: 'Sneaky', idempotency_key: randomUUID() });
  assert.equal(r.status, 401);
  const okRes = await new Client().headJoin(A, reg);
  assert.equal(okRes.status, 200);
});

test('a draft, tested or disabled case cannot be joined even when assigned', async () => {
  const g = await makeGame(pool, defByCode('SQL02'), { status: 'draft' });
  try {
    const reg = await g.register();
    assert.equal((await new Client().headJoin(g, reg)).status, 401);
    await pool.query("update cases set status = 'tested' where id = $1", [g.caseId]);
    assert.equal((await new Client().headJoin(g, reg)).status, 401);
    await pool.query("update cases set status = 'published' where id = $1", [g.caseId]);
    assert.equal((await new Client().headJoin(g, reg)).status, 200);
    await pool.query("update cases set status = 'disabled' where id = $1", [g.caseId]);
    assert.equal((await new Client().headJoin(g, await g.register())).status, 401);
  } finally {
    await g.cleanup();
  }
});

test('a registration owns exactly one team: repeated and concurrent head joins never create a second', async () => {
  const reg = await A.register();
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => new Client().headJoin(A, reg, `Head ${i}`)),
  );
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
  assert.equal(new Set(results.map((r) => r.data.team.team_code)).size, 1);
  assert.equal(new Set(results.map((r) => r.data.player.id)).size, 1, 'everyone gets the one head player');
  const n = (await pool.query('select count(*)::int n from teams where registration_id = $1', [reg.id])).rows[0].n;
  assert.equal(n, 1);
  assert.equal((await pool.query("select count(*)::int n from players p join teams t on t.id = p.team_id where t.registration_id = $1 and p.role = 'head'", [reg.id])).rows[0].n, 1);
  assert.equal(results.filter((r) => !r.data.replay).length, 1, 'exactly one request created the team');
});

test('investigators join with the team code; the registered team size is the cap', async () => {
  const t = await makeTeam(A, 0, { size: 2 });
  const second = new Client();
  assert.equal((await second.joinTeam(t.teamCode, 'Second')).status, 200);
  const third = await new Client().joinTeam(t.teamCode, 'Third');
  assert.equal(third.status, 409);
  assert.match(third.data.error, /full/i);

  const solo = await makeTeam(A, 0, { size: 1 });
  assert.equal((await new Client().joinTeam(solo.teamCode, 'Extra')).status, 409);

  const trio = await makeTeam(A, 2, { size: 3 });
  assert.equal((await new Client().joinTeam(trio.teamCode, 'Fourth')).status, 409);
  const st = (await trio.head.get('/api/state')).data;
  assert.equal(st.players.length, 3);
});

test('rejoin: the same codename restores the same player and role; head rejoin by team code needs the case password', async () => {
  const t = await makeTeam(A, 1);
  const inv = new Client();
  const again = await inv.joinTeam(t.teamCode, 'inv1'); // case-insensitive
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);
  assert.equal(again.data.player.role, 'investigator');
  assert.equal((await new Client().joinTeam(t.teamCode, 'Head')).status, 401, 'head name without the password');
  const back = new Client();
  const okHead = await back.post('/api/join', { team_code: t.teamCode, display_name: 'Head', case_password: A.password });
  assert.equal(okHead.status, 200);
  assert.equal(okHead.data.player.role, 'head');
  assert.equal((await back.get('/api/state')).data.players.length, 2, 'no duplicate player');
});

test('head rejoin with the registration credentials restores the head of the existing team', async () => {
  const reg = await A.register();
  const first = await new Client().headJoin(A, reg, 'Original');
  const crashed = await new Client().headJoin(A, reg, 'Different Name');
  assert.equal(crashed.status, 200);
  assert.equal(crashed.data.player.id, first.data.player.id);
  assert.equal(crashed.data.team.team_code, first.data.team.team_code);
});

test('team code lookup is normalized and an unknown or mixed-up code is a generic 401', async () => {
  const t = await makeTeam(A, 0);
  const raw = rawCode(t.teamCode);
  assert.equal((await new Client().joinTeam(raw.toLowerCase(), 'LowerCase')).status, 200);
  assert.equal((await new Client().joinTeam('ZZZZZZ', 'Nobody')).status, 401);
  assert.equal((await new Client().post('/api/join', { team_code: raw, registration_ref: 'ZZZZZZZZ', display_name: 'Both' })).status, 401);
});

test('start moves the assignment to started and stamps the clock', async () => {
  const t = await makeTeam(A, 0);
  const before = (await pool.query('select started_at from teams t join registrations r on r.id = t.registration_id where r.id = $1', [t.reg.id])).rows[0].started_at;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await t.head.post('/api/start')).status, 200);
  const after = (await pool.query('select started_at from teams t where t.registration_id = $1', [t.reg.id])).rows[0].started_at;
  assert.ok(after > before, 'the clock starts when the head starts the investigation');
  assert.equal((await pool.query('select status from team_case_assignments where registration_id = $1', [t.reg.id])).rows[0].status, 'started');
  assert.equal((await t.head.post('/api/start')).status, 200, 'starting twice is a harmless no-op');
});
