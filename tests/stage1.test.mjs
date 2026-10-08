import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeCase, Client, makeTeam, rawCode } from './helpers.mjs';

const pool = db();
let c;

before(async () => {
  c = await makeCase(pool);
});
after(async () => {
  await c.cleanup();
  await pool.end();
});

const teamCount = async () =>
  (await pool.query('select count(*)::int n from teams where case_id = $1', [c.caseId])).rows[0].n;
const playerCount = async (code) =>
  (
    await pool.query(
      'select count(*)::int n from players p join teams t on t.id = p.team_id where t.team_code = $1',
      [rawCode(code)],
    )
  ).rows[0].n;

test('head joins with valid creds: team + head + progress + scores created, code generated', async () => {
  const head = new Client();
  const r = await head.headJoin(c, 'Holmes');
  assert.equal(r.status, 200);
  assert.match(r.data.team.team_code, /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
  assert.equal(r.data.player.role, 'head');
  assert.ok(r.setCookie.includes('HttpOnly'));
  assert.ok(/samesite=lax/i.test(r.setCookie));

  const row = (
    await pool.query(
      `select t.started_at, tp.state, tp.current_phase, ts.total_pts
         from teams t join team_progress tp on tp.team_id = t.id join team_scores ts on ts.team_id = t.id
        where t.team_code = $1`,
      [rawCode(r.data.team.team_code)],
    )
  ).rows[0];
  assert.ok(row.started_at);
  assert.equal(row.state, 'WAITING');
  assert.equal(row.total_pts, 0);

  const st = await head.get('/api/state');
  assert.equal(st.status, 200);
  assert.equal(st.data.me.role, 'head');
  assert.equal(st.data.team.team_code, r.data.team.team_code);
});

test('2nd and 3rd players become investigators; team shows 3 players; 4th is rejected', async () => {
  const { head, teamCode } = await makeTeam(c, 0);
  const a = new Client();
  const b = new Client();
  const d = new Client();
  const ra = await a.joinTeam(teamCode, 'Watson');
  const rb = await b.joinTeam(teamCode.toLowerCase(), 'Lestrade'); // code is case-insensitive
  assert.equal(ra.data.player.role, 'investigator');
  assert.equal(rb.data.player.role, 'investigator');

  const rd = await d.joinTeam(teamCode, 'Moriarty');
  assert.equal(rd.status, 409);
  assert.match(rd.data.error, /full/i);
  assert.equal(d.cookie, null);
  assert.equal(await playerCount(teamCode), 3);

  const st = await head.get('/api/state');
  assert.equal(st.data.players.length, 3);
});

test('wrong case password: rejected, no team created', async () => {
  const before = await teamCount();
  const x = new Client();
  const r = await x.post('/api/join', {
    case_code: c.caseCode,
    case_password: 'wrong-password',
    display_name: 'Mallory',
    idempotency_key: randomUUID(),
  });
  assert.equal(r.status, 401);
  assert.equal(x.cookie, null);
  assert.equal(await teamCount(), before);

  const r2 = await x.post('/api/join', {
    case_code: 'ZZZZZZZZ',
    case_password: c.password,
    display_name: 'Mallory',
    idempotency_key: randomUUID(),
  });
  assert.equal(r2.status, 401);
  assert.equal(await teamCount(), before);
});

test('unknown team code: generic 401', async () => {
  const r = await new Client().joinTeam('ZZZ-ZZZ', 'Nobody');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'Invalid credentials');
});

test('rejoin with same name restores role (investigator and head), no duplicate player', async () => {
  const { head, teamCode } = await makeTeam(c, 1);
  const before = await playerCount(teamCode);
  const headId = (await head.get('/api/state')).data.me.player_id;

  const again = new Client(); // "closed the browser"
  const ri = await again.joinTeam(teamCode, 'inv1'); // case-insensitive name match
  assert.equal(ri.status, 200);
  assert.equal(ri.data.player.role, 'investigator');
  assert.equal(ri.data.replay, true);

  const headAgain = new Client();
  assert.equal((await headAgain.joinTeam(teamCode, 'Head')).status, 401); // head rejoin needs the password
  const rh = await headAgain.post('/api/join', { team_code: teamCode, display_name: 'Head', case_password: c.password });
  assert.equal(rh.status, 200);
  assert.equal(rh.data.player.role, 'head');
  assert.equal((await headAgain.get('/api/state')).data.me.player_id, headId);

  assert.equal(await playerCount(teamCode), before);
});

test('rejoin works even when the team is full', async () => {
  const { teamCode } = await makeTeam(c, 2);
  const r = await new Client().joinTeam(teamCode, 'Inv2');
  assert.equal(r.status, 200);
  assert.equal(await playerCount(teamCode), 3);
});

test('double-submit with the same idempotency_key creates one team (sequential and concurrent)', async () => {
  const before = await teamCount();
  const key = randomUUID();
  const body = { case_code: c.caseCode, case_password: c.password, display_name: 'Dbl', idempotency_key: key };
  const r1 = await new Client().post('/api/join', body);
  const r2 = await new Client().post('/api/join', body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.data.team.team_code, r2.data.team.team_code);
  assert.equal(r2.data.replay, true);
  assert.equal(await teamCount(), before + 1);

  const key2 = randomUUID();
  const body2 = { ...body, idempotency_key: key2, display_name: 'Dbl2' };
  const rs = await Promise.all([1, 2, 3].map(() => new Client().post('/api/join', body2)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.team.team_code)).size, 1);
  assert.equal(await teamCount(), before + 2);
});

test('4 simultaneous investigator joins give exactly 3 players total', async () => {
  const { teamCode } = await makeTeam(c, 0);
  const rs = await Promise.all(['A', 'B', 'C', 'D'].map((n) => new Client().joinTeam(teamCode, `Racer${n}`)));
  const ok = rs.filter((r) => r.status === 200).length;
  const full = rs.filter((r) => r.status === 409).length;
  assert.equal(ok, 2);
  assert.equal(full, 2);
  assert.equal(await playerCount(teamCode), 3);
});

test('DB constraints: one head per team, unique team_code', async () => {
  const { teamCode } = await makeTeam(c, 0);
  const t = (await pool.query('select id from teams where team_code = $1', [rawCode(teamCode)])).rows[0];
  await assert.rejects(pool.query("insert into players (team_id, display_name, role) values ($1, 'Second', 'head')", [t.id]));
  await assert.rejects(
    pool.query('insert into teams (case_id, team_code, team_name) values ($1, $2, $2)', [c.caseId, rawCode(teamCode)]),
  );
});

test('requests with no or bad session are rejected', async () => {
  const x = new Client();
  assert.equal((await x.get('/api/state')).status, 401);
  assert.equal((await x.post('/api/start')).status, 401);
});
