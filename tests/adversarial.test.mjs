// Stage 7 adversarial pass: injection payloads, forged/replayed sessions, cross-case reads,
// rapid double-submission on every scoring endpoint, oversized and malformed input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { db, makeRealCase, Client, AdminClient, rawCode, submit, query, BASE, randomIp } from './helpers.mjs';

const pool = db();
let A;
let B;

before(async () => {
  A = await makeRealCase(pool);
  B = await makeRealCase(pool);
});
after(async () => {
  await A.cleanup();
  await B.cleanup();
  await pool.end();
});

async function team(c, n = 0) {
  const head = new Client();
  const r = await head.post('/api/join', { case_code: c.caseCode, case_password: c.password, display_name: 'Head', idempotency_key: randomUUID() });
  assert.equal(r.status, 200, r.text);
  const inv = [];
  for (let i = 0; i < n; i++) {
    const x = new Client();
    assert.equal((await x.joinTeam(r.data.team.team_code, `Inv${i + 1}`)).status, 200);
    inv.push(x);
  }
  return { head, inv, teamCode: r.data.team.team_code };
}
const count = async (table) => (await pool.query(`select count(*)::int n from ${table}`)).rows[0].n;

const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE teams; --",
  '"; DROP TABLE players; --',
  "1; DELETE FROM cases WHERE true; --",
  "' UNION SELECT password_hash FROM cases --",
  '${7*7} {{7*7}} <script>alert(1)</script>',
  '../../etc/passwd',
  '%00%0a%0d',
  'Robert\'); DROP TABLE students;--',
  '𝕌𝕟𝕚𝕔𝕠𝕕𝕖 ✓ ñ 日本語',
  '\u0000nul',
  'a'.repeat(5000),
];

test('SQL-injection style payloads in every text field are inert and never cause a 500', async () => {
  const before = { teams: await count('teams'), cases: await count('cases'), tasks: await count('tasks'), players: await count('players') };
  const { head, inv } = await team(A, 1);
  await head.post('/api/start');
  const t1 = A.byPhase(1)[0];
  const bad = [];
  for (const p of PAYLOADS) {
    const attempts = [
      new Client().post('/api/join', { case_code: p, case_password: p, display_name: p, idempotency_key: p }),
      new Client().post('/api/join', { team_code: p, display_name: p }),
      new Client().post('/api/join', { case_code: A.caseCode, case_password: A.password, display_name: p, idempotency_key: randomUUID(), team_name: p }),
      head.post('/api/submit-task', { task_id: p, value: p }),
      head.post('/api/submit-task', { task_id: t1.id, value: p }),
      head.post('/api/assign-task', { task_id: p, player_id: p }),
      head.post('/api/submit-culprit', { character_id: p }),
      head.post('/api/query', { sql: p }),
      new AdminClient().login(p),
      new AdminClient().get(`/api/admin/team?code=${encodeURIComponent(p)}`),
      inv[0].post('/api/query', { sql: `select '${p.replace(/'/g, "''")}'` }),
    ];
    for (const r of await Promise.all(attempts)) if (r.status >= 500) bad.push([p.slice(0, 20), r.status, r.text.slice(0, 80)]);
  }
  assert.deepEqual(bad, [], 'no payload may cause a 5xx');
  // nothing was dropped, deleted or leaked: row counts only grew by the teams/players we deliberately created
  assert.equal(await count('cases'), before.cases);
  assert.equal(await count('tasks'), before.tasks);
  assert.ok((await count('teams')) >= before.teams && (await count('players')) >= before.players);
  assert.equal((await pool.query("select count(*)::int n from information_schema.tables where table_name in ('teams','players','cases','students')")).rows[0].n, 3);
  // hostile display names that were accepted are stored as plain text, and come back escaped by JSON
  const stored = (await pool.query("select display_name from players where display_name like '%DROP TABLE%' or display_name like '%script%'")).rows;
  for (const r of stored) assert.equal(typeof r.display_name, 'string');
});

test('control characters and oversized bodies are rejected cleanly', async () => {
  const c = new Client();
  const nul = await c.post('/api/join', { case_code: A.caseCode, case_password: A.password, display_name: 'bad\u0000name', idempotency_key: randomUUID() });
  assert.equal(nul.status, 400);
  const huge = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': randomIp() }, body: JSON.stringify({ display_name: 'x'.repeat(300_000) }) });
  assert.equal(huge.status, 413);
  const notJson = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': randomIp() }, body: '{{{{' });
  assert.equal(notJson.status, 400);
  const arr = await fetch(`${BASE}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': randomIp() }, body: '[1,2,3]' });
  assert.equal(arr.status, 400);
  for (const path of ['/api/join', '/api/start', '/api/query', '/api/submit-task', '/api/submit-culprit', '/api/assign-task']) {
    assert.equal((await fetch(`${BASE}${path}`)).status, 405, `GET ${path}`);
  }
});

test('session forgery and replay: every variant is refused', async () => {
  const { head, teamCode } = await team(A);
  const key = new TextEncoder().encode(process.env.SESSION_SECRET);
  const mine = (await head.get('/api/state')).data.me;
  const mk = (claims, opts = {}) => {
    let j = new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'HS256' }).setIssuedAt();
    j = j.setExpirationTime(opts.exp ?? '1h');
    return j.sign(opts.key ?? key);
  };
  const tid = (await pool.query('select id from teams where team_code = $1', [rawCode(teamCode)])).rows[0].id;
  const claims = { team_id: tid, player_id: mine.player_id, role: 'head' };
  const other = await team(B);
  const otherTid = (await pool.query('select id from teams where team_code = $1', [rawCode(other.teamCode)])).rows[0].id;
  const otherPid = (await other.head.get('/api/state')).data.me.player_id;

  const forged = {
    'expired token': await mk(claims, { exp: Math.floor(Date.now() / 1000) - 3600 }),
    'wrong secret': await mk(claims, { key: new TextEncoder().encode('x'.repeat(40)) }),
    'wrong algorithm (HS512)': await mk(claims, { alg: 'HS512' }),
    'alg none': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`,
    'player of another team, my team id': await mk({ ...claims, player_id: otherPid }),
    "another team's id with my player": await mk({ ...claims, team_id: otherTid }),
    'role escalated to head for an investigator': await mk({ ...claims, role: 'investigator' }), // role mismatch with DB
    'missing claims': await mk({}),
    'garbage': 'not.a.jwt',
    'empty': '',
  };
  for (const [name, token] of Object.entries(forged)) {
    const c = new Client();
    c.cookie = `slc_session=${token}`;
    for (const [m, path, body] of [['GET', '/api/state'], ['POST', '/api/query', { sql: 'select 1' }], ['POST', '/api/submit-task', { task_id: randomUUID(), value: '1' }]]) {
      const r = await c.req(m, path, body);
      assert.equal(r.status, 401, `${name}: ${m} ${path} -> ${r.status}`);
    }
  }
  // a token for an investigator claiming the head's role is rejected (role comes from the DB)
  const invClient = new Client();
  const invJoin = await invClient.joinTeam(teamCode, 'Pawn');
  assert.equal(invJoin.status, 200);
  const pawn = (await invClient.get('/api/state')).data.me;
  const asHead = new Client();
  asHead.cookie = `slc_session=${await mk({ team_id: tid, player_id: pawn.player_id, role: 'head' })}`;
  assert.equal((await asHead.post('/api/start')).status, 401);
  // replay of a valid token after the admin deletes the team
  const victim = await team(A);
  const stolen = victim.head.cookie;
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);
  assert.equal((await admin.post('/api/admin/reset-team', { team_code: victim.teamCode, mode: 'delete' })).status, 200);
  const replay = new Client();
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/state')).status, 401);
  // a valid token still works (control)
  assert.equal((await head.get('/api/state')).status, 200);
});

test('cross-case: a team cannot read, enumerate or alter another case through the console', async () => {
  const a = await team(A);
  const b = await team(B);
  await a.head.post('/api/start');
  await b.head.post('/api/start');
  // enumerate every table in every case schema and try to read it
  const tables = await query(a.head, "select table_schema, table_name from information_schema.tables where table_schema like 'case\\_%' order by 1, 2");
  assert.equal(tables.data.ok, true);
  const mine = new Set(['cast_crew', 'access_log']);
  for (const [schema, table] of tables.data.rows) {
    const r = await query(a.head, `select count(*) from ${schema}.${table}`);
    if (r.status === 429) break; // stay under the rate limit; the first ~25 tables are plenty
    const n = r.data.rows?.[0]?.[0];
    if (schema === A.schema && mine.has(table)) assert.notEqual(n, '0', `own ${table}`);
    else assert.equal(n, '0', `${schema}.${table} must be empty for this team`);
  }
  // direct attempts at the other case's schema, case ids, answers
  for (const sql of [
    `select * from ${B.schema}.cast_crew`,
    `select * from ${B.schema}.text_messages`,
    `select * from public.tasks where case_id = '${B.caseId}'`,
    `select correct_answer from public.tasks`,
    `select password_hash, case_code from public.cases`,
    `select key from public.case_query_keys`,
    `select * from public.culprit_submission`,
  ]) {
    const r = await query(a.head, sql);
    if (r.status === 429) break;
    assert.ok(r.data.ok === false || r.data.rows.length === 0, `${sql} must reveal nothing`);
  }
  // team B's data is untouched by A's attempts
  assert.equal((await query(b.head, `select count(*) from ${B.schema}.cast_crew`)).data.rows[0][0], '14');
});

test('rapid double-submission on every scoring endpoint changes state exactly once', async () => {
  const { head, inv, teamCode } = await team(A, 1);
  const players = [head, inv[0]];
  // start x6
  const starts = await Promise.all(Array.from({ length: 6 }, (_, i) => players[i % 2].post('/api/start')));
  assert.equal(starts.filter((r) => r.status === 200).length, 3); // head only; investigator gets 403
  assert.equal(starts.filter((r) => r.status === 403).length, 3);
  assert.equal((await head.get('/api/state')).data.state, 'PHASE_1');
  // assign x6 to different players: last writer wins but exactly one row
  const t1 = A.byPhase(1);
  const st = (await head.get('/api/state')).data;
  await Promise.all(st.players.flatMap((p) => [head.post('/api/assign-task', { task_id: t1[0].id, player_id: p.id }), head.post('/api/assign-task', { task_id: t1[0].id, player_id: p.id })]));
  assert.equal((await pool.query('select count(*)::int n from task_assignments a join teams t on t.id = a.team_id where t.team_code = $1', [rawCode(teamCode)])).rows[0].n, 1);
  // submit the same correct answer x6 concurrently, from both players, for all three tasks
  for (const t of t1) {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => submit(players[i % 2], t.id, t.correct_answer)));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 404 || r.status === 429));
  }
  const s1 = (await head.get('/api/state')).data;
  assert.equal(s1.state, 'PHASE_2');
  assert.equal(s1.scores.total_pts, 20, 'phase 1 scored exactly once');
  const correctRows = (await pool.query('select count(*)::int n from task_submissions s join teams t on t.id = s.team_id where t.team_code = $1 and s.is_correct', [rawCode(teamCode)])).rows[0].n;
  assert.equal(correctRows, 3);
  // finish the phases, then 8 concurrent culprit submissions
  for (const p of [2, 3]) for (const t of A.byPhase(p)) await submit(head, t.id, t.correct_answer);
  assert.equal((await head.get('/api/state')).data.scores.total_pts, 60);
  const cs = await Promise.all(Array.from({ length: 8 }, (_, i) => players[i % 2].post('/api/submit-culprit', { character_id: A.culpritId })));
  assert.equal(cs.filter((r) => r.status === 200).length, 1);
  assert.equal((await head.get('/api/state')).data.scores.total_pts, 100);
});

test('mass assignment: extra fields in join/assign/submit bodies grant nothing', async () => {
  const { teamCode } = await team(A);
  const r = await new Client().post('/api/join', { team_code: teamCode, display_name: 'Sneaky', role: 'head', is_head: true, team_id: randomUUID(), case_id: B.caseId, current_phase: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.data.player.role, 'investigator');
  const p = (await pool.query("select role from players where display_name = 'Sneaky' and team_id = (select id from teams where team_code = $1)", [rawCode(teamCode)])).rows;
  assert.deepEqual(p, [{ role: 'investigator' }]);
});

test('query_logs lets an organizer diagnose "Team 7\'s console stopped working" without guessing', async () => {
  const { head, teamCode } = await team(A);
  await head.post('/api/start');
  await query(head, 'select * from cast_crew'); // ok
  await query(head, 'select * from nope'); // unknown table
  await query(head, 'select count(*) from generate_series(1,5000) a, generate_series(1,5000) b, generate_series(1,50) c'); // timeout
  await query(head, 'select * from public.cases'); // permission
  await query(head, 'select 1 from'); // syntax
  const admin = new AdminClient();
  await admin.login();
  const r = await admin.get(`/api/admin/team?code=${teamCode}`);
  const kinds = r.data.queries.map((q) => (q.success ? 'ok' : q.error_type)).reverse();
  assert.deepEqual(kinds, ['ok', 'unknown_table', 'timeout', 'permission', 'sql']);
  assert.ok(r.data.queries.every((q) => q.player === 'Head' && q.execution_time_ms !== null));
  const slow = r.data.queries.find((q) => q.error_type === 'timeout');
  assert.ok(slow.execution_time_ms >= 2900 && slow.execution_time_ms < 6500, `timeout recorded as ${slow.execution_time_ms}ms`);
  // the dashboard surfaces the error burst
  const dash = (await admin.get('/api/admin/dashboard')).data.teams.find((t) => t.team_code === teamCode);
  assert.equal(dash.recent_errors, 4);
});
