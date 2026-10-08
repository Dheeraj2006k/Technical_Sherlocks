import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { db, makeCase, makeTeam, submit, Client, rawCode, allResponses, randomIp } from './helpers.mjs';
import { normalizeCode, formatCode } from '../scripts/lib/codes.mjs';

const pool = db();
let c; // normal case (cost-4 hash)
const extraCases = [];
const usedIps = [];

before(async () => {
  c = await makeCase(pool);
});
after(async () => {
  for (const x of [c, ...extraCases]) await x.cleanup();
  const hashes = usedIps.map(ipHash);
  await pool.query('delete from join_attempts where ip_hash = any($1)', [hashes]);
  await pool.end();
});

const ipHash = (ip) => createHmac('sha256', process.env.SESSION_SECRET).update(ip).digest('hex');
const extra = async (opts) => {
  const x = await makeCase(pool, opts);
  extraCases.push(x);
  return x;
};
const rawPost = (ip, body) =>
  fetch(`${process.env.TEST_BASE_URL ?? 'http://localhost:3101'}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });

test('normalizeCode: case, hyphens, spaces, O->0, I/L->1, length and alphabet', () => {
  assert.equal(normalizeCode('a0b1-c0d1', 8), 'A0B1C0D1');
  assert.equal(normalizeCode(' a0b1 c0d1 ', 8), 'A0B1C0D1');
  assert.equal(normalizeCode('AOBI-COD1', 8), 'A0B1C0D1');
  assert.equal(normalizeCode('aobl-c0dl', 8), 'A0B1C0D1');
  assert.equal(normalizeCode('a01b10', 6), 'A01B10');
  assert.equal(normalizeCode('AOI-BIO', 6), 'A01B10');
  assert.equal(normalizeCode('ABC', 6), null); // too short
  assert.equal(normalizeCode('ABCDEFG', 6), null); // too long
  assert.equal(normalizeCode('ABCDEU', 6), null); // U is not in the alphabet
  assert.equal(normalizeCode("AB'; --", 6), null);
  assert.equal(normalizeCode(12345678, 8), null);
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(formatCode('ABCDEF'), 'ABC-DEF');
});

test('head joins with case_code + password, in any normalized spelling of the code', async () => {
  const x = await extra({ caseCode: 'A0B1C0D1' });
  for (const spelling of ['A0B1C0D1', 'a0b1c0d1', 'A0B1-C0D1', 'a0b1 c0d1', 'AOB1-COD1', 'aobl-c0dl']) {
    const r = await new Client().post('/api/join', {
      case_code: spelling,
      case_password: x.password,
      display_name: 'Head',
      idempotency_key: randomUUID(),
    });
    assert.equal(r.status, 200, spelling);
    assert.equal(r.data.player.role, 'head');
  }
});

test('team code normalization works end to end (lowercase, unhyphenated, O/0 and I/L/1 confusion)', async () => {
  const { teamCode } = await makeTeam(c, 0);
  const joiner = async (code, name) => (await new Client().joinTeam(code, name)).status;
  assert.equal(await joiner(teamCode.toLowerCase(), 'N1'), 200);
  assert.equal(await joiner(rawCode(teamCode), 'N2'), 200);
  assert.equal(await joiner(` ${teamCode} `, 'N3'), 409); // head + N1 + N2: now full, still resolved to the right team
});

test('team code with 0/1 characters accepts O/I/L lookalikes', async () => {
  const { teamCode } = await makeTeam(c, 0);
  await pool.query("update teams set team_code = 'A01B10' where team_code = $1", [rawCode(teamCode)]);
  for (const [i, spelling] of ['A01B10', 'a01-b10', 'AOI-BIO', 'aol b1o'].entries()) {
    const r = await new Client().joinTeam(spelling, `Lookalike${i}`);
    // head + up to 2 investigators fit; the 3rd/4th are cleanly rejected as full, not as unknown
    assert.ok(r.status === 200 || r.status === 409, `${spelling}: ${r.status}`);
  }
  const ok = await new Client().joinTeam('AOI-BIO', 'Lookalike0'); // rejoin by name resolves the team
  assert.equal(ok.status, 200);
});

test('wrong code, wrong password, draft case and malformed input all return the identical 401', async () => {
  const draft = await extra({ status: 'draft' });
  const base = { display_name: 'Probe', idempotency_key: randomUUID() };
  const attempts = [
    { case_code: 'ZZZZZZZZ', case_password: c.password }, // unknown code
    { case_code: c.caseCode, case_password: 'wrong-password' }, // wrong password
    { case_code: draft.caseCode, case_password: draft.password }, // right creds, case not live
    { case_code: 'nonsense!', case_password: c.password }, // malformed code
    { case_code: c.caseCode }, // password missing
    { case_code: c.caseCode, case_password: 12345 }, // wrong type
  ];
  const out = [];
  for (const a of attempts) out.push(await new Client().post('/api/join', { ...base, ...a }));
  out.push(await new Client().joinTeam('ZZZ-ZZZ', 'Probe')); // investigator path, unknown team
  out.push(await new Client().joinTeam('nonsense', 'Probe')); // investigator path, malformed
  for (const r of out) {
    assert.equal(r.status, 401);
    assert.equal(r.text, out[0].text, 'identical response body');
    assert.equal(r.setCookie, undefined);
  }
  assert.equal(out[0].text, '{"error":"Invalid credentials"}');
  // and the draft case really is unjoinable, even through a team that exists
  const live = await new Client().headJoin(c);
  assert.equal(live.status, 200);
});

test('timing: wrong code vs wrong password vs draft case take similar time (all run a bcrypt compare)', async () => {
  const slow = await extra({ bcryptCost: 10 });
  const draft = await extra({ bcryptCost: 10, status: 'draft' });
  const time = async (body) => {
    const t0 = performance.now();
    await new Client().post('/api/join', { display_name: 'T', idempotency_key: randomUUID(), ...body });
    return performance.now() - t0;
  };
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const sample = async (body) => {
    const xs = [];
    for (let i = 0; i < 5; i++) xs.push(await time(body));
    return median(xs);
  };
  await time({ case_code: slow.caseCode, case_password: 'x' }); // warm up
  const wrongCode = await sample({ case_code: 'ZZZZZZZZ', case_password: 'x' });
  const wrongPw = await sample({ case_code: slow.caseCode, case_password: 'definitely-wrong' });
  const notLive = await sample({ case_code: draft.caseCode, case_password: draft.password });
  const all = [wrongCode, wrongPw, notLive];
  const ratio = Math.max(...all) / Math.min(...all);
  console.log(`# timing medians ms: wrongCode=${wrongCode.toFixed(0)} wrongPw=${wrongPw.toFixed(0)} notLive=${notLive.toFixed(0)} ratio=${ratio.toFixed(2)}`);
  assert.ok(ratio < 2, `timing ratio ${ratio}`);
});

test('head rejoin: needs the case password; wrong password fails; correct one succeeds', async () => {
  const { head, teamCode } = await makeTeam(c, 1);
  const headId = (await head.get('/api/state')).data.me.player_id;
  assert.equal((await new Client().joinTeam(teamCode, 'Head')).status, 401);
  assert.equal(
    (await new Client().post('/api/join', { team_code: teamCode, display_name: 'Head', case_password: 'nope' })).status,
    401,
  );
  const again = new Client();
  const ok = await again.post('/api/join', { team_code: teamCode, display_name: 'head', case_password: c.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.player.role, 'head');
  assert.equal((await again.get('/api/state')).data.me.player_id, headId);
  // an investigator rejoin never needs the password
  assert.equal((await new Client().joinTeam(teamCode, 'Inv1')).status, 200);
});

test('"Bob" and "bob" are the same player; the DB also refuses a case-variant duplicate', async () => {
  const { teamCode } = await makeTeam(c, 0);
  const a = await new Client().joinTeam(teamCode, 'Bob');
  const b = await new Client().joinTeam(teamCode, 'bob');
  const d = await new Client().joinTeam(teamCode, 'BOB');
  assert.equal(a.data.player.role, 'investigator');
  assert.equal(b.data.player.id, a.data.player.id);
  assert.equal(d.data.player.id, a.data.player.id);
  const n = (
    await pool.query(
      `select count(*)::int n from players p join teams t on t.id = p.team_id
        where t.team_code = $1 and lower(p.display_name) = 'bob'`,
      [rawCode(teamCode)],
    )
  ).rows[0].n;
  assert.equal(n, 1);
  const t = (await pool.query('select id from teams where team_code = $1', [rawCode(teamCode)])).rows[0];
  await assert.rejects(
    pool.query("insert into players (team_id, display_name, role) values ($1, 'bOb', 'investigator')", [t.id]),
  );
});

test('11th submission by a player within a minute returns 429 + Retry-After and awards nothing', async () => {
  const { head, inv, teamCode } = await makeTeam(c, 1);
  await head.post('/api/start');
  const t1 = c.byPhase(1)[1]; // NUMBER task, answer "5"
  for (let i = 0; i < 10; i++) {
    const r = await submit(head, t1.id, `${100 + i}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.correct, false);
  }
  const eleventh = await fetch(`${process.env.TEST_BASE_URL ?? 'http://localhost:3101'}/api/submit-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: head.cookie },
    body: JSON.stringify({ task_id: t1.id, value: t1.correct_answer }), // the RIGHT answer, still refused
  });
  assert.equal(eleventh.status, 429);
  const retry = Number(eleventh.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60, `Retry-After ${retry}`);

  const st = (await head.get('/api/state')).data;
  assert.equal(st.scores.total_pts, 0);
  assert.equal(st.tasks.find((t) => t.id === t1.id).solved, false);
  const rows = (
    await pool.query(
      `select count(*)::int n from task_submissions ts join teams t on t.id = ts.team_id where t.team_code = $1`,
      [rawCode(teamCode)],
    )
  ).rows[0].n;
  assert.equal(rows, 10);

  // the limit is per player: a teammate can still submit
  const r = await submit(inv[0], t1.id, t1.correct_answer);
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, true);
});

test('11th join attempt per IP per minute returns 429; hour cap and pruning use join_attempts', async () => {
  const ip = randomIp();
  usedIps.push(ip);
  for (let i = 0; i < 10; i++) {
    const r = await rawPost(ip, { team_code: 'ZZZ-ZZZ', display_name: 'Spam' });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const eleventh = await rawPost(ip, { team_code: 'ZZZ-ZZZ', display_name: 'Spam' });
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.headers.get('retry-after'), '60');
  // still blocked even with valid credentials
  const withValid = await rawPost(ip, {
    case_code: c.caseCode,
    case_password: c.password,
    display_name: 'Head',
    idempotency_key: randomUUID(),
  });
  assert.equal(withValid.status, 429);

  // other IPs are unaffected
  const other = randomIp();
  usedIps.push(other);
  assert.equal((await rawPost(other, { team_code: 'ZZZ-ZZZ', display_name: 'Spam' })).status, 401);

  // hour cap: 30 older attempts (outside the minute window) block the next one
  const hourIp = randomIp();
  usedIps.push(hourIp);
  await pool.query(
    "insert into join_attempts (ip_hash, created_at) select $1, now() - interval '5 minutes' from generate_series(1, 30)",
    [ipHash(hourIp)],
  );
  const hr = await rawPost(hourIp, { team_code: 'ZZZ-ZZZ', display_name: 'Spam' });
  assert.equal(hr.status, 429);
  assert.equal(hr.headers.get('retry-after'), '3600');

  // rows older than an hour are deleted on insert; raw IPs are never stored
  const oldIp = randomIp();
  usedIps.push(oldIp);
  await pool.query("insert into join_attempts (ip_hash, created_at) values ($1, now() - interval '2 hours')", [ipHash(oldIp)]);
  await rawPost(randomIp(), { team_code: 'ZZZ-ZZZ', display_name: 'Prune' });
  const left = (await pool.query("select count(*)::int n from join_attempts where created_at < now() - interval '1 hour'")).rows[0].n;
  assert.equal(left, 0);
  const raw = (await pool.query('select count(*)::int n from join_attempts where ip_hash = $1', [ip])).rows[0].n;
  assert.equal(raw, 0, 'IP is stored hashed, not raw');
});

test('credentials and case ids never appear in any API response, cookie or error', async () => {
  // Drive a full flow plus assorted error paths so there are plenty of responses to scan.
  const { head, inv } = await makeTeam(c, 1);
  await head.post('/api/start');
  for (const t of c.byPhase(1)) await submit(head, t.id, t.correct_answer);
  await head.get('/api/state');
  await inv[0].get('/api/state');
  await head.post('/api/submit-task', { task_id: c.byPhase(3)[0].id, value: 'x' });
  await head.post('/api/submit-task', { task_id: 'not-a-uuid', value: 'x' });
  await head.post('/api/assign-task', {});
  await new Client().post('/api/join', { case_code: c.caseCode, case_password: 'wrong', display_name: 'X', idempotency_key: randomUUID() });
  await new Client().post('/api/join', { case_code: c.caseCode, display_name: 'X' });
  await new Client().post('/api/join', { bogus: true });
  await new Client().get('/api/state');

  const secrets = [c.caseCode, formatCode(c.caseCode), c.password, c.caseId];
  assert.ok(allResponses.length > 50);
  for (const r of allResponses) {
    for (const s of secrets) {
      assert.ok(!r.text.includes(s), `${r.path} ${r.status} response contains a secret`);
      assert.ok(!(r.setCookie ?? '').includes(s), `${r.path} cookie contains a secret`);
    }
    if (r.setCookie) {
      // the signed token carries no case id either
      const payload = Buffer.from(r.setCookie.split('=')[1].split(';')[0].split('.')[1], 'base64url').toString();
      assert.ok(!payload.includes(c.caseId));
      assert.ok(!('case_id' in JSON.parse(payload)));
    }
  }
});
