import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { db, makeRealCase, submit, query, solvePhase, Client, rawCode } from './helpers.mjs';

const pool = db();
let A; // real case copy A
let B; // real case copy B (for cross-case isolation)

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
  const r = await head.post('/api/join', {
    case_code: c.caseCode,
    case_password: c.password,
    display_name: 'Head',
    idempotency_key: crypto.randomUUID(),
  });
  assert.equal(r.status, 200, r.text);
  const inv = [];
  for (let i = 0; i < n; i++) {
    const x = new Client();
    assert.equal((await x.joinTeam(r.data.team.team_code, `Inv${i + 1}`)).status, 200);
    inv.push(x);
  }
  return { head, inv, teamCode: r.data.team.team_code };
}
const started = async (c, n = 0) => {
  const t = await team(c, n);
  assert.equal((await t.head.post('/api/start')).status, 200);
  return t;
};
const roster = (st) => st.data.roster;
// Solves phases through the real console until the team reaches `target` (PHASE_n).
const advanceTo = async (head, c, target) => {
  for (;;) {
    const st = await head.get('/api/state');
    const cur = Number(/^PHASE_(\d)$/.exec(st.data.state)?.[1] ?? 99);
    if (cur >= target) return;
    const rs = await solvePhase(head, c, cur, roster(st));
    assert.ok(rs.at(-1).data.phase_cleared, `phase ${cur} cleared`);
  }
};

test('console is refused before the investigation starts', async () => {
  const t = await team(A);
  const r = await query(t.head, 'select 1');
  assert.equal(r.status, 409);
});

test('precheck: must be a single SELECT/WITH statement; trailing semicolon tolerated', async () => {
  const { head } = await started(A);
  for (const bad of ['', '   ', 'insert into cast_crew values (1)', 'drop table cast_crew', 'select 1; select 2', 'update cast_crew set name=1', 'delete from cast_crew']) {
    const r = await query(head, bad);
    assert.equal(r.status, 400, `"${bad}" -> ${r.status}`);
  }
  assert.equal((await query(head, 12345)).status, 400);
  assert.equal((await query(head, 'x'.repeat(5000))).status, 400);
  const ok = await query(head, 'select 1 as one;');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.rows, [[1]]);
  assert.equal((await query(head, 'with x as (select 2 as two) select * from x')).data.rows[0][0], 2);
});

test('phase gating: unlocked tables return rows, locked tables return nothing, additive across phases', async () => {
  const { head } = await started(A);
  const count = async (tbl) => (await query(head, `select count(*) from ${tbl}`)).data.rows[0][0];

  assert.equal(await count('cast_crew'), '14');
  assert.ok(Number(await count('access_log')) > 40);
  assert.equal(await count('prop_handling_log'), '0'); // locked in phase 1
  assert.equal(await count('text_messages'), '0');
  const hinted = await query(head, 'select * from prop_handling_log');
  assert.match(hinted.data.notice ?? '', /prop_handling_log.*isn't unlocked/);
  // fully qualified names don't get around it
  assert.equal((await query(head, `select count(*) from ${A.schema}.prop_handling_log`)).data.rows[0][0], '0');

  await advanceTo(head, A, 2);
  assert.equal(await count('prop_handling_log'), '14');
  assert.equal(await count('cast_crew'), '14'); // additive
  assert.equal(await count('text_messages'), '0');

  await advanceTo(head, A, 3);
  assert.equal(await count('text_messages'), '14');
  assert.equal(await count('prop_handling_log'), '14');
});

test('state and schema endpoints expose only unlocked tables/columns', async () => {
  const { head } = await started(A);
  const st = (await head.get('/api/state')).data;
  assert.deepEqual(st.unlocked_tables, ['access_log', 'cast_crew']);
  const sc = (await head.get('/api/schema')).data;
  assert.deepEqual(sc.tables.map((t) => t.name).sort(), ['access_log', 'cast_crew']);
  assert.ok(sc.tables.find((t) => t.name === 'cast_crew').columns.some((c) => c.name === 'badge_id'));
  const text = JSON.stringify([st, sc]);
  assert.ok(!text.includes('prop_handling_log') && !text.includes('text_messages'));
});

test('another case\'s tables are invisible even when the schema name is guessed', async () => {
  const a = await started(A);
  const b = await started(B);
  // A's team names B's schema directly: RLS key mismatch -> no rows
  const r = await query(a.head, `select count(*) from ${B.schema}.cast_crew`);
  assert.equal(r.data.rows[0][0], '0');
  const r2 = await query(a.head, `select count(*) from ${B.schema}.access_log`);
  assert.equal(r2.data.rows[0][0], '0');
  // and the reverse, plus own data still fine
  assert.equal((await query(b.head, `select count(*) from ${A.schema}.cast_crew`)).data.rows[0][0], '0');
  assert.equal((await query(a.head, `select count(*) from ${A.schema}.cast_crew`)).data.rows[0][0], '14');
  // even a later-phase key of its own case can't be conjured: set_config with a guess changes nothing
  const forged = await query(a.head, `select set_config('app.key', 'guess', true), (select count(*) from ${A.schema}.prop_handling_log)`);
  assert.equal(forged.data.ok, true);
  assert.equal(forged.data.rows[0][1], '0');
});

test('core tables, keys and answers are not reachable from player SQL', async () => {
  const { head } = await started(A);
  for (const tbl of ['public.tasks', 'public.cases', 'public.case_query_keys', 'public.teams', 'public.players', 'public.task_submissions', 'public.query_logs', 'pg_authid']) {
    const r = await query(head, `select * from ${tbl}`);
    assert.equal(r.data.ok, false, tbl);
    assert.equal(r.data.error_type, 'permission', tbl);
    assert.ok(!/correct_answer|case_code|password/i.test(r.text), tbl);
  }
  // policy text is readable but contains only hashes, never the keys
  const keys = (await pool.query('select key from case_query_keys where case_id = $1', [A.caseId])).rows.map((r) => r.key);
  const pol = await query(head, `select qual from pg_policies where schemaname = '${A.schema}'`);
  assert.equal(pol.data.ok, true);
  for (const k of keys) assert.ok(!pol.text.includes(k), 'policy must not contain a raw key');
  // function-based escapes
  for (const sql of [
    "select set_config('role','postgres',true), (select count(*) from cast_crew)",
    "select set_config('role','postgres',true), query_to_xml('select * from public.tasks', true, false, '')",
    "select pg_read_file('/etc/passwd')",
    "select dblink('host=localhost','select 1')",
  ]) {
    const r = await query(head, sql);
    assert.equal(r.data.ok, false, sql);
  }
});

test('writes and DDL are impossible even when the precheck is satisfied', async () => {
  const { head } = await started(A);
  const attempts = [
    'with d as (delete from cast_crew returning *) select * from d',
    "with i as (insert into cast_crew values (99,'x','x','x','x') returning *) select * from i",
    "with u as (update cast_crew set name='x' returning *) select * from u",
    'select * into newtab from cast_crew',
    'select * from cast_crew for update',
    "select pg_terminate_backend(pg_backend_pid())",
  ];
  for (const sql of attempts) {
    const r = await query(head, sql);
    assert.equal(r.data.ok, false, sql);
  }
  assert.equal((await pool.query(`select count(*)::int n from ${A.schema}.cast_crew`)).rows[0].n, 14);
  assert.equal((await pool.query("select count(*)::int n from pg_tables where tablename = 'newtab'")).rows[0].n, 0);
  assert.equal((await query(head, 'select count(*) from cast_crew')).data.rows[0][0], '14'); // still works
});

test('expensive query is killed by statement_timeout; the pool is not wedged', async () => {
  const { head, inv } = await started(A, 2);
  const slow = 'select count(*) from generate_series(1,5000) a, generate_series(1,5000) b, generate_series(1,50) c';
  const t0 = Date.now();
  const r = await query(head, slow);
  const took = Date.now() - t0;
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error_type, 'timeout');
  assert.ok(took < 6000, `took ${took}ms`);
  assert.equal((await query(head, 'select 1')).data.ok, true);

  // three at once on a pool of 2 connections: all end cleanly, then the console still works
  const rs = await Promise.all([head, inv[0], inv[1]].map((c) => query(c, slow)));
  assert.ok(rs.every((x) => x.data.error_type === 'timeout'));
  assert.equal((await query(head, 'select 2')).data.rows[0][0], 2);
  // a statement that tries to switch the timeout off is still bounded
  const sneaky = await query(head, "select set_config('statement_timeout','0',true), pg_sleep(8)");
  assert.equal(sneaky.data.error_type, 'timeout');
});

test('row cap: at most 200 rows with truncated flag; wrapper-escape tricks cannot lift it', async () => {
  const { head } = await started(A);
  const r = await query(head, 'select * from generate_series(1, 1000) as n');
  assert.equal(r.data.rows.length, 200);
  assert.equal(r.data.truncated, true);
  const exact = await query(head, 'select * from generate_series(1, 200) as n');
  assert.equal(exact.data.truncated, false);
  const trick = await query(head, 'select 1) as a union all select * from generate_series(1, 100000) x union all select * from (select 1');
  assert.ok(trick.data.ok === false || trick.data.rows.length <= 200);
  // A function scan is materialized in full by Postgres before any row is returned, so a giant series is
  // stopped by the 3s timeout rather than the row cap; either way it is bounded and cheap for us.
  const huge = await query(head, 'select * from generate_series(1, 50000000)');
  assert.ok(
    (huge.data.ok === true && huge.data.rows.length === 200 && huge.data.truncated) || (huge.data.ok === false && huge.data.error_type === 'timeout'),
  );
  assert.equal((await query(head, 'select 1')).data.ok, true);
});

test('result types: timestamps keep their text, errors are friendly', async () => {
  const { head } = await started(A);
  const r = await query(head, "select logged_at, badge_id from access_log order by log_id limit 1");
  assert.match(r.data.rows[0][0], /^2025-03-14 16:30:00/);
  assert.deepEqual(r.data.columns, ['logged_at', 'badge_id']);
  const syn = await query(head, 'select from from');
  assert.equal(syn.data.ok, false);
  assert.equal(syn.data.error_type, 'sql');
  const nope = await query(head, 'select * from no_such_table');
  assert.equal(nope.data.ok, false);
  assert.match(nope.data.error, /doesn't exist/i);
  const dup = await query(head, 'select 1 as a, 2 as a');
  assert.deepEqual(dup.data.rows, [[1, 2]]);
});

test('per-player rate limit: 31st query in a minute -> 429 + Retry-After; teammates unaffected; not logged', async () => {
  const { head, inv, teamCode } = await started(A, 1);
  for (let i = 0; i < 30; i++) {
    const r = await query(head, 'select 1');
    assert.equal(r.status, 200, `query ${i + 1}`);
  }
  const over = await fetch(`${process.env.TEST_BASE_URL ?? 'http://localhost:3101'}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: head.cookie },
    body: JSON.stringify({ sql: 'select 1' }),
  });
  assert.equal(over.status, 429);
  const retry = Number(over.headers.get('retry-after'));
  assert.ok(retry >= 1 && retry <= 60);
  assert.equal((await query(inv[0], 'select 1')).status, 200);
  const n = (
    await pool.query(
      `select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1`,
      [rawCode(teamCode)],
    )
  ).rows[0].n;
  assert.equal(n, 31); // 30 head + 1 teammate; the refused one isn't logged
});

test('concurrent bursts from one player cannot overshoot the rate limit', async () => {
  const { head, teamCode } = await started(A);
  const rs = await Promise.all(Array.from({ length: 45 }, () => query(head, 'select 1')));
  const ok = rs.filter((r) => r.status === 200).length;
  const limited = rs.filter((r) => r.status === 429).length;
  assert.equal(ok, 30);
  assert.equal(limited, 15);
  const n = (await pool.query(`select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1`, [rawCode(teamCode)])).rows[0].n;
  assert.equal(n, 30);
});

test('query_logs has what is needed to debug a stuck console (and no SQL text)', async () => {
  const { head, teamCode } = await started(A);
  await query(head, 'select * from cast_crew');
  await query(head, 'select * from nope');
  await query(head, 'select * from generate_series(1,300) n');
  const rows = (
    await pool.query(
      `select l.*, p.display_name from query_logs l join teams t on t.id = l.team_id join players p on p.id = l.player_id
        where t.team_code = $1 order by l.created_at`,
      [rawCode(teamCode)],
    )
  ).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].row_count, 14);
  assert.ok(rows[0].execution_time_ms >= 0);
  assert.match(rows[0].query_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].display_name, 'Head');
  assert.equal(rows[1].success, false);
  assert.equal(rows[1].error_type, 'unknown_table');
  assert.equal(rows[2].row_count, 200);
  assert.ok(!('query_text' in rows[0]) && !('sql' in rows[0]));
  assert.ok(rows.every((r) => r.error_type !== 'pending'));
});

test('END TO END: the real case is solvable using only the console; scores and states advance', async () => {
  const { head } = await started(A);
  const ros = (await head.get('/api/state')).data.roster;
  assert.equal(ros.length, 13);
  assert.ok(!ros.some((c) => c.name === 'Leonard Voss'), 'victim is not in the roster');

  for (let p = 1; p <= 3; p++) {
    const before = (await head.get('/api/state')).data;
    assert.equal(before.state, `PHASE_${p}`);
    const rs = await solvePhase(head, A, p, ros);
    assert.deepEqual(rs.map((r) => r.data.correct), [true, true, true], `phase ${p}`);
    assert.equal(rs.at(-1).data.phase_cleared, true);
  }
  const st = (await head.get('/api/state')).data;
  assert.equal(st.state, 'FINAL_DEDUCTION');
  assert.equal(st.scores.total_pts, 60);
  assert.deepEqual(st.unlocked_tables, ['access_log', 'cast_crew', 'prop_handling_log', 'text_messages']);
});

test('answers differ from what a wrong-but-plausible reading gives (red herrings are real)', async () => {
  const { head } = await started(A);
  // Priya entered the prop room in the interval but is cleared: not the "other department" person
  const r = await query(head, "select count(distinct badge_id) from access_log where door='PROP_ROOM' and direction='IN' and logged_at between '2025-03-14 20:45' and '2025-03-14 21:05'");
  assert.equal(r.data.rows[0][0], '4');
  // a wrong submission for the hard task (a red herring) is rejected
  const ros = (await head.get('/api/state')).data.roster;
  const diana = ros.find((c) => c.name === 'Diana Frost');
  const hard = A.byPhase(1).find((t) => t.difficulty === 'hard');
  assert.equal((await submit(head, hard.id, diana.id)).data.correct, false);
});

test('player_exec at the DB level: every gate holds with the real connection', async () => {
  const p = new pg.Client({ connectionString: process.env.DATABASE_URL_PLAYER, ssl: { rejectUnauthorized: false } });
  await p.connect();
  try {
    const me = (await p.query("select current_user, current_setting('statement_timeout') st, current_setting('default_transaction_read_only') ro")).rows[0];
    assert.deepEqual(me, { current_user: 'player_exec', st: '3s', ro: 'on' });
    const keys = Object.fromEntries((await pool.query('select phase, key from case_query_keys where case_id = $1', [A.caseId])).rows.map((r) => [r.phase, r.key]));
    const count = async (key, tbl) => {
      await p.query('begin read only');
      await p.query('select set_config($1, $2, true)', ['app.key', key]);
      const r = await p.query(`select count(*)::int n from ${A.schema}.${tbl}`);
      await p.query('rollback');
      return r.rows[0].n;
    };
    assert.equal(await count('', 'cast_crew'), 0);
    assert.equal(await count(keys[1], 'cast_crew'), 14);
    assert.equal(await count(keys[1], 'prop_handling_log'), 0);
    assert.equal(await count(keys[2], 'prop_handling_log'), 14);
    assert.equal(await count(keys[2], 'text_messages'), 0);
    assert.equal(await count(keys[3], 'text_messages'), 14);
    // the other case's key (all phases) opens nothing here
    const otherKeys = (await pool.query('select key from case_query_keys where case_id = $1', [B.caseId])).rows;
    for (const k of otherKeys) assert.equal(await count(k.key, 'cast_crew'), 0);
    // writes
    await p.query('begin');
    await assert.rejects(p.query(`insert into ${A.schema}.cast_crew values (99,'x','x','x','x')`));
    await p.query('rollback');
    await assert.rejects(p.query('create table public.evil (id int)'));
    await assert.rejects(p.query('select * from public.tasks'));
  } finally {
    await p.end();
  }
});

test('/api/query without a session is refused; a tampered session is refused', async () => {
  const x = new Client();
  assert.equal((await query(x, 'select 1')).status, 401);
  const { head } = await started(A);
  const bad = head.cookie.slice(0, -3) + 'AAA';
  assert.equal((await x.post('/api/query', { sql: 'select 1' }, { rawCookie: bad })).status, 401);
});
