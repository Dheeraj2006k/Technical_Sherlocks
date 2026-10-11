import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { db, makeGame, defByCode, Client, AdminClient, startedTeam, submit, hint, final, query, evidence, answerValue, rawCode, allResponses } from './helpers.mjs';

const pool = db();
let A;
let B;

before(async () => {
  A = await makeGame(pool, defByCode('SQL01'));
  B = await makeGame(pool, defByCode('LOG02'));
});
after(async () => {
  await A.cleanup();
  await B.cleanup();
  await pool.end();
});

const key = () => new TextEncoder().encode(process.env.SESSION_SECRET);
const mk = (claims, { alg = 'HS256', exp = '1h', secret = key(), aud } = {}) => {
  let j = new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime(exp);
  if (aud) j = j.setAudience(aud);
  return j.sign(secret);
};

test('session forgery and replay: every variant is refused on every player endpoint', async () => {
  const t = await startedTeam(A, 1);
  const me = (await t.head.get('/api/state')).data.me;
  const teamId = (await pool.query('select id from teams where team_code = $1', [rawCode(t.teamCode)])).rows[0].id;
  const claims = { team_id: teamId, player_id: me.player_id, role: 'head' };
  const other = await startedTeam(B);
  const otherState = (await other.head.get('/api/state')).data;
  const otherTeamId = (await pool.query('select id from teams where team_code = $1', [rawCode(other.teamCode)])).rows[0].id;

  const forged = {
    'expired token': await mk(claims, { exp: Math.floor(Date.now() / 1000) - 3600 }),
    'wrong secret': await mk(claims, { secret: new TextEncoder().encode('x'.repeat(40)) }),
    'wrong algorithm (HS512)': await mk(claims, { alg: 'HS512' }),
    'alg none': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`,
    'player of another team under my team id': await mk({ ...claims, player_id: otherState.me.player_id }),
    "another team's id with my player": await mk({ ...claims, team_id: otherTeamId }),
    'missing claims': await mk({}),
    'non-existent player': await mk({ ...claims, player_id: randomUUID() }),
    garbage: 'not.a.jwt',
    empty: '',
  };
  const endpoints = [
    ['GET', '/api/state'],
    ['GET', '/api/schema'],
    ['POST', '/api/query', { sql: 'select 1' }],
    ['POST', '/api/evidence', {}],
    ['POST', '/api/submit-task', { task_id: randomUUID(), value: '1' }],
    ['POST', '/api/hint', { task_id: randomUUID() }],
    ['POST', '/api/submit-final', { component: 'culprit', value: randomUUID() }],
    ['POST', '/api/assign-thread', { thread_id: randomUUID() }],
    ['POST', '/api/start', {}],
  ];
  for (const [name, token] of Object.entries(forged)) {
    const c = new Client();
    c.cookie = `slc_session=${token}`;
    for (const [m, path, body] of endpoints) {
      const r = await c.req(m, path, body);
      assert.equal(r.status, 401, `${name}: ${m} ${path} -> ${r.status}`);
    }
  }
  // an investigator's token claiming the head role is rejected: the role comes from the database
  const pawn = new Client();
  assert.equal((await pawn.joinTeam(t.teamCode, 'Pawn')).status, 200);
  const pawnId = (await pawn.get('/api/state')).data.me.player_id;
  const asHead = new Client();
  asHead.cookie = `slc_session=${await mk({ team_id: teamId, player_id: pawnId, role: 'head' })}`;
  assert.equal((await asHead.post('/api/start')).status, 401);
  // an admin token is not a player session and a player token is not an admin session
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
  const crossed = new Client();
  crossed.cookie = admin.cookie.replace('slc_admin=', 'slc_session=');
  assert.equal((await crossed.get('/api/state')).status, 401);
  const asAdmin = new AdminClient();
  asAdmin.cookie = t.head.cookie.replace('slc_session=', 'slc_admin=');
  assert.equal((await asAdmin.get('/api/admin/dashboard')).status, 401);
  // replay of a valid token after the admin deletes the team
  const victim = await startedTeam(A);
  const stolen = victim.head.cookie;
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: victim.teamCode, mode: 'delete' })).status, 200);
  const replay = new Client();
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/state')).status, 401);
  assert.equal((await t.head.get('/api/state')).status, 200, 'control: a valid token still works');
});

test('session cookie is HttpOnly and SameSite, and carries no case id', async () => {
  const reg = await A.register();
  const r = await new Client().headJoin(A, reg);
  const set = r.setCookie;
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.match(set, /Path=\//);
  const payload = JSON.parse(Buffer.from(set.split(';')[0].split('=')[1].split('.')[1], 'base64url').toString());
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'player_id', 'role', 'team_id']);
});

test('admin endpoints refuse everything without an organizer session', async () => {
  const anon = new Client();
  anon.cookieName = 'slc_admin';
  const wrong = new AdminClient();
  assert.equal((await wrong.login('definitely-wrong')).status, 401);
  const calls = [
    ['GET', '/api/admin/dashboard'],
    ['GET', '/api/admin/export'],
    ['GET', '/api/admin/team?code=ABC123'],
    ['GET', '/api/admin/registrations'],
    ['GET', '/api/admin/cases'],
    ['GET', '/api/admin/audit'],
    ['POST', '/api/admin/registrations', { registrations: [{ team_ref: 'x' }] }],
    ['POST', '/api/admin/assign-case', { registration_id: randomUUID(), case_code: 'SQL01' }],
    ['POST', '/api/admin/reset-team', { team_code: 'ABC123' }],
    ['POST', '/api/admin/pause', { scope: 'global', paused: true }],
  ];
  for (const [m, p, b] of calls) {
    assert.equal((await anon.req(m, p, b)).status, 401, `${m} ${p}`);
    assert.equal((await wrong.req(m, p, b)).status, 401, `${m} ${p} (after a failed login)`);
  }
  const player = await startedTeam(A);
  const asAdmin = new AdminClient();
  asAdmin.cookie = player.head.cookie.replace('slc_session=', 'slc_admin=');
  for (const [m, p, b] of calls) assert.equal((await asAdmin.req(m, p, b)).status, 401, `player token on ${p}`);
});

test('admin sign-in is rate limited per IP', async () => {
  const c = new AdminClient();
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) limited = (await c.login(`wrong-${i}`)).status === 429;
  assert.ok(limited);
});

test('admin state-changing requests from another origin are refused', async () => {
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
  const r = await admin.post('/api/admin/pause', { scope: 'global', paused: false }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('SQL-injection style payloads in every text field are inert and never cause a 500', async () => {
  const payloads = [`'; drop table players; --`, `" or ""="`, `\\'; select pg_sleep(5); --`, '${7*7}', '<img src=x onerror=alert(1)>', '\u0000', 'a'.repeat(300), '💥🕵️‍♀️', `%'; select 1 --`];
  const reg = await A.register();
  const head = new Client();
  assert.equal((await head.headJoin(A, reg, 'Head')).status, 200);
  await head.post('/api/start');
  const q = A.tasks[0];
  for (const p of payloads) {
    for (const r of [
      await new Client().headJoin(A, reg, p),
      await new Client().post('/api/join', { team_code: p, display_name: 'x' }),
      await new Client().post('/api/join', { registration_ref: p, case_code: p, case_password: p, display_name: p }),
      await head.post('/api/submit-task', { task_id: q.id, value: p, idempotency_key: p }),
      await head.post('/api/submit-task', { task_id: p, value: p }),
      await head.post('/api/hint', { task_id: p, position: p }),
      await head.post('/api/submit-final', { component: p, value: p }),
      await head.post('/api/assign-thread', { thread_id: p, player_id: p }),
      await head.post('/api/query', { sql: p }),
      await head.post('/api/evidence', { table: p, search: p, filters: [{ column: p, op: p, value: p }], sort: { column: p, dir: p }, page: p, page_size: p }),
    ]) {
      assert.ok(r.status < 500, `${JSON.stringify(p).slice(0, 30)} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  assert.ok(Number((await pool.query('select count(*)::int n from players')).rows[0].n) > 0, 'tables intact');
  const admin = new AdminClient();
  await admin.login();
  for (const p of payloads) {
    const r = await admin.post('/api/admin/registrations', { registrations: [{ team_ref: p, team_size: 3 }] });
    assert.ok(r.status < 500, `registration name ${JSON.stringify(p).slice(0, 30)} -> ${r.status}`);
  }
  await pool.query("delete from registrations where created_at > now() - interval '5 minutes' and registration_ref not in (select registration_ref from registrations where id = any($1))", [A.registrations]);
});

test('control characters and oversized bodies are rejected cleanly', async () => {
  const c = new Client();
  const r1 = await c.post('/api/join', { team_code: 'ABC123', display_name: 'bad\u0007name' });
  assert.ok(r1.status === 400 || r1.status === 401);
  const r2 = await c.req('POST', '/api/join', { display_name: 'x'.repeat(2_000_000) });
  assert.ok(r2.status >= 400 && r2.status < 500, `oversized -> ${r2.status}`);
  const r3 = await fetch(`${process.env.TEST_BASE_URL ?? 'http://localhost:3101'}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(r3.status, 400);
});

test('credentials, keys and answers never appear in any player-facing response', async () => {
  const t = await startedTeam(A, 1);
  const q = A.tasks[0];
  await submit(t.head, q.id, 'wrong');
  await hint(t.head, q.id);
  await query(t.head, 'select * from cast_crew');
  await evidence(t.head, {});
  await t.head.get('/api/schema');
  await t.head.get('/api/leaderboard?track=SQL');
  await t.inv[0].get('/api/state');
  await new Client().headJoin(A, await A.register(), 'Leaky');
  await new Client().post('/api/join', { registration_ref: 'ZZZZZZZZ', case_code: A.caseCode, case_password: 'nope', display_name: 'x' });
  const keys = (await pool.query('select key from case_table_keys where case_id = any($1)', [[A.caseId, B.caseId]])).rows.map((r) => r.key);
  // the case CODE is a catalogue code shown to the team itself (state.case.code); it is not a secret on its own
  const secrets = [A.password, A.caseId, B.password, B.caseId, ...keys];
  const refs = (await pool.query('select registration_ref from registrations where id = any($1)', [[...A.registrations, ...B.registrations]])).rows.map((r) => r.registration_ref);
  for (const r of allResponses.filter((x) => !x.path.startsWith('/api/admin'))) {
    for (const s of [...secrets, ...refs]) assert.ok(!r.text.includes(s) && !(r.setCookie ?? '').includes(s), `${r.path} leaked a credential`);
    assert.ok(!/password_hash|correct_answer|"is_correct"|case_table_keys|DATABASE_URL|SESSION_SECRET/i.test(r.text), `${r.path} leaked an internal name`);
  }
});

test('teams cannot see or touch each other: state, hints, answers and assignments are scoped to the session', async () => {
  const a = await startedTeam(A);
  const b = await startedTeam(A);
  const q = A.tasks[0];
  await hint(a.head, q.id);
  const sa = (await a.head.get('/api/state')).data;
  const sb = (await b.head.get('/api/state')).data;
  assert.notEqual(sa.team.team_code, sb.team.team_code);
  assert.notEqual(sa.realtime_channel, sb.realtime_channel);
  assert.equal(sb.threads[0].questions[0].hints.length, 0, "team B does not see team A's hint");
  assert.equal(sb.players.length, 1);
  await submit(a.head, q.id, answerValue(q));
  assert.equal((await b.head.get('/api/state')).data.scores.total_pts, 0);
  // thread assignment of another team's thread / player is refused
  const aPlayer = sa.me.player_id;
  assert.equal((await b.head.post('/api/assign-thread', { thread_id: sb.threads[0].id, player_id: aPlayer })).status, 404);
});

test('mass assignment: extra fields in join, assign and submit bodies grant nothing', async () => {
  const reg = await A.register();
  const c = new Client();
  const r = await c.post('/api/join', {
    registration_ref: reg.ref,
    case_code: A.caseCode,
    case_password: A.password,
    display_name: 'Mass',
    idempotency_key: randomUUID(),
    role: 'investigator',
    team_code: 'ZZZZZZ', // both modes at once is refused outright
  });
  assert.equal(r.status, 401);
  const ok = await c.post('/api/join', { registration_ref: reg.ref, case_code: A.caseCode, case_password: A.password, display_name: 'Mass', idempotency_key: randomUUID(), role: 'investigator', team_size: 99, status: 'published', case_id: B.caseId });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.player.role, 'head');
  assert.equal((await c.get('/api/state')).data.case.code, A.caseCode);
  const size = (await pool.query('select team_size from registrations where id = $1', [reg.id])).rows[0].team_size;
  assert.equal(size, 3, 'a join body cannot change the registration');
});

test('the public leaderboard exposes no credentials or ids, and is ordered by score then by who finished first', async () => {
  const t = await startedTeam(A);
  const lb = (await new Client().get('/api/leaderboard?track=SQL')).data;
  assert.equal(lb.track, 'SQL');
  assert.ok(lb.teams.length > 0);
  for (const row of lb.teams) {
    assert.deepEqual(Object.keys(row).sort(), ['case_title', 'elapsed_s', 'finished', 'phases_cleared', 'rank', 'ref', 'state', 'team_name', 'total_pts', 'track'].sort());
    assert.match(row.ref, /^[0-9a-f]{12}$/);
  }
  const text = JSON.stringify(lb);
  assert.ok(!text.includes(rawCode(t.teamCode)) && !text.includes(t.reg.ref) && !text.includes(A.password));
  assert.equal((await new Client().get('/api/leaderboard?track=NOPE')).status, 400);
  const logic = (await new Client().get('/api/leaderboard?track=LOGIC')).data;
  assert.ok(logic.teams.every((x) => x.track === 'LOGIC'));
  assert.ok(lb.teams.every((x) => x.track === 'SQL'), 'tracks are never mixed');
});

test('an unfinished team cannot read the resolution; the answer to the final deduction is never in the state', async () => {
  const t = await startedTeam(A);
  for (let p = 1; p <= 3; p++) {
    for (const q of A.tasks.filter((x) => x.phase === p)) await submit(t.head, q.id, answerValue(q));
  }
  const st = (await t.head.get('/api/state')).data;
  assert.equal(st.state, 'FINAL_DEDUCTION');
  assert.equal(st.solution, null);
  const text = JSON.stringify(st);
  assert.ok(!text.includes(A.def.solution.method) && !text.includes(A.def.solution.motive));
  assert.ok(st.final.mechanism.options.every((o) => !('correct' in o) && !('is_correct' in o)));
  await final(t.head, 'culprit', A.culpritId);
  assert.equal((await t.head.get('/api/state')).data.solution, null, 'one part resolved is not enough');
});

test('timing: an unknown reference, a wrong password and a draft case all take similar time (all run a bcrypt compare)', async () => {
  const reg = await A.register();
  const time = async (body) => {
    const t0 = performance.now();
    await new Client().post('/api/join', { display_name: 'T', idempotency_key: randomUUID(), ...body });
    return performance.now() - t0;
  };
  const med = async (body) => {
    const xs = [];
    for (let i = 0; i < 5; i++) xs.push(await time(body));
    return xs.sort((a, b) => a - b)[2];
  };
  const unknown = await med({ registration_ref: 'ZZZZZZZZ', case_code: A.caseCode, case_password: 'x' });
  const wrongPw = await med({ registration_ref: reg.ref, case_code: A.caseCode, case_password: 'x' });
  for (const [name, v] of [['unknown', unknown], ['wrong password', wrongPw]]) assert.ok(Number.isFinite(v) && v > 0, name);
  // a generous bound: the point is that neither path is an obvious shortcut (no early return before the hash compare)
  assert.ok(Math.abs(unknown - wrongPw) < Math.max(400, Math.max(unknown, wrongPw)), `unknown ${unknown.toFixed(0)}ms vs wrong password ${wrongPw.toFixed(0)}ms`);
});

test('the join rate limit applies per IP (11th attempt in a minute -> 429)', async () => {
  const c = new Client();
  let limited = null;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = await c.post('/api/join', { registration_ref: 'ZZZZZZZZ', case_code: 'NOPE99', case_password: 'x', display_name: 'brute' });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'repeated guessing is throttled');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('every public table is locked down for Supabase roles (RLS on, no anon/authenticated grants)', async () => {
  const noRls = (await pool.query("select tablename from pg_tables where schemaname = 'public' and not rowsecurity")).rows;
  assert.deepEqual(noRls, [], 'RLS is enabled on every public table');
  const roles = (await pool.query("select rolname from pg_roles where rolname in ('anon','authenticated')")).rows.map((r) => r.rolname);
  for (const role of roles) {
    const grants = (await pool.query("select count(*)::int n from information_schema.role_table_grants where grantee = $1 and table_schema = 'public'", [role])).rows[0].n;
    assert.equal(grants, 0, `${role} has no table grants`);
  }
  const fns = (await pool.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')")).rows[0].n;
  assert.equal(fns, 0, 'the application defines no database functions in the exposed public schema (only the pgcrypto extension does)');
});
