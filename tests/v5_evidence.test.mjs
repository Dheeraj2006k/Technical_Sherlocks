import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { db, makeGame, defByCode, Client, startedTeam, makeTeam, submit, query, evidence, answerValue, solvePhase, rawCode, BASE } from './helpers.mjs';

const pool = db();
let A; // SQL01 (Opening Night)
let B; // second SQL case (cross-case isolation)
let L; // LOG01 (Logic track)

before(async () => {
  A = await makeGame(pool, defByCode('SQL01'));
  B = await makeGame(pool, defByCode('SQL02'));
  L = await makeGame(pool, defByCode('LOG01'));
});
after(async () => {
  await A.cleanup();
  await B.cleanup();
  await L.cleanup();
  await pool.end();
});

const count = async (c, tbl) => (await query(c, `select count(*) from ${tbl}`)).data.rows[0][0];
const state = async (c) => (await c.get('/api/state')).data;
const tablesOf = (g, key) => g.def.threads.find((t) => t.key === key).unlocks.map((u) => u.table);

test('console is refused before the investigation starts and without a session', async () => {
  const t = await makeTeam(A);
  assert.equal((await query(t.head, 'select 1')).status, 409);
  assert.equal((await evidence(t.head, {})).status, 409);
  const anon = new Client();
  assert.equal((await query(anon, 'select 1')).status, 401);
  assert.equal((await evidence(anon, {})).status, 401);
  const { head } = await startedTeam(A);
  const bad = head.cookie.slice(0, -3) + 'AAA';
  assert.equal((await anon.post('/api/query', { sql: 'select 1' }, { rawCookie: bad })).status, 401);
});

test('precheck: must be a single SELECT/WITH statement; trailing semicolon tolerated', async () => {
  const { head } = await startedTeam(A);
  for (const bad of ['', '   ', 'insert into cast_crew values (1)', 'drop table cast_crew', 'select 1; select 2', 'update cast_crew set name=1', 'delete from cast_crew']) {
    assert.equal((await query(head, bad)).status, 400, `"${bad}"`);
  }
  assert.equal((await query(head, 12345)).status, 400);
  assert.equal((await query(head, 'x'.repeat(5000))).status, 400);
  const ok = await query(head, 'select 1 as one;');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.rows, [[1]]);
  assert.equal((await query(head, 'with x as (select 2 as two) select * from x')).data.rows[0][0], 2);
});

test('catalog and metadata probes are refused with a friendly message', async () => {
  const { head } = await startedTeam(A);
  for (const sql of [
    'select * from information_schema.tables',
    'select tablename from pg_tables',
    'select * from pg_catalog.pg_class',
    "select to_regclass('public.cases')",
    'select current_schemas(true), pg_get_userbyid(1)',
    "select /* pg_tables */ 1 from pg_roles",
  ]) {
    const r = await query(head, sql);
    assert.equal(r.status, 400, sql);
    assert.match(r.data.error, /System tables and metadata/i, sql);
  }
  // a catalog word inside a string literal or comment is just text
  assert.equal((await query(head, "select 'pg_tables is a view' as note")).status, 200);
});

test('evidence unlocks by phase AND by thread: tables open when their thread becomes available', async () => {
  const { head } = await startedTeam(A);
  const custody = tablesOf(A, 't2a')[0];
  const messages = tablesOf(A, 't3a')[0];
  const [roster, access] = A.def.phases[0].tables;
  assert.equal(await count(head, roster), '14');
  assert.ok(Number(await count(head, access)) > 40);
  assert.equal(await count(head, custody), '0', 'locked in phase 1');
  assert.equal(await count(head, messages), '0');
  const hinted = await query(head, `select * from ${custody}`);
  assert.match(hinted.data.notice ?? '', new RegExp(`${custody}.*isn't unlocked`));
  assert.equal((await query(head, `select count(*) from ${A.schema}.${custody}`)).data.rows[0][0], '0', 'a qualified name does not get around it');
  let st = await state(head);
  assert.deepEqual(st.unlocked_tables, [access, roster].sort());

  await solvePhase(head, A, 1);
  st = await state(head);
  assert.equal(st.state, 'PHASE_2');
  assert.ok(Number(await count(head, custody)) > 5, 'the custody log opened with its thread');
  assert.equal(await count(head, roster), '14', 'still additive');
  assert.equal(await count(head, messages), '0', 'the phase-3 thread has not been reached');
  assert.deepEqual(st.unlocked_tables, [access, custody, roster].sort());

  await solvePhase(head, A, 2);
  assert.ok(Number(await count(head, messages)) > 5);
  assert.deepEqual((await state(head)).unlocked_tables, [access, custody, messages, roster].sort());
});

test('a table can be unlocked by COMPLETING a thread instead of reaching it', async () => {
  const g = await makeGame(pool, defByCode('SQL03'));
  try {
    const msgs = tablesOf(g, 't3a')[0];
    const t1a = (await pool.query("select id from investigation_threads where case_id = $1 and title = $2", [g.caseId, g.def.threads.find((t) => t.key === 't1a').title])).rows[0].id;
    await pool.query("insert into thread_evidence_tables (thread_id, table_name, unlock_condition) values ($1, $2, 'complete')", [t1a, msgs]);
    const { head } = await startedTeam(g);
    assert.equal(await count(head, msgs), '0', 'not before the thread is complete');
    const first = g.tasksIn('t1a')[0];
    await submit(head, first.id, answerValue(first));
    assert.equal(await count(head, msgs), '0', 'a half-finished thread unlocks nothing');
    const second = g.tasksIn('t1a')[1];
    await submit(head, second.id, answerValue(second));
    assert.ok(Number(await count(head, msgs)) > 5, 'completing the thread opened the table, long before phase 3');
  } finally {
    await g.cleanup();
  }
});

test('the schema endpoint exposes only unlocked tables and their columns', async () => {
  const { head } = await startedTeam(A);
  const custody = tablesOf(A, 't2a')[0];
  const sc = (await head.get('/api/schema')).data;
  assert.deepEqual(sc.tables.map((t) => t.name).sort(), [...A.def.phases[0].tables].sort());
  assert.ok(sc.tables.find((t) => t.name === A.def.phases[0].tables[0]).columns.some((c) => c.name === 'badge_id'));
  assert.ok(!JSON.stringify([sc, await state(head)]).includes(custody));
});

test("another case's tables are invisible even when the schema name is guessed or a key is forged", async () => {
  const a = await startedTeam(A);
  const b = await startedTeam(B);
  const aTable = A.def.phases[0].tables[0];
  const bTable = B.def.phases[0].tables[0];
  assert.equal((await query(a.head, `select count(*) from ${B.schema}.${bTable}`)).data.rows[0][0], '0');
  assert.equal((await query(b.head, `select count(*) from ${A.schema}.${aTable}`)).data.rows[0][0], '0');
  assert.equal((await query(a.head, `select count(*) from ${A.schema}.${aTable}`)).data.rows[0][0], '14');
  const locked = tablesOf(A, 't2a')[0];
  // setting the key variable from inside a SELECT, with every guess a player could make, opens nothing
  for (const guess of ["'guess'", "''", "'a,b,c'", `'${aTable}'`, `'${locked}'`]) {
    const r = await query(a.head, `select set_config('app.keys', ${guess}, true), (select count(*) from ${A.schema}.${locked})`);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.rows[0][1], '0', guess);
  }
  // reading the policy text shows only hashes, never a raw key
  const keys = (await pool.query('select key from case_table_keys where case_id = $1', [A.caseId])).rows.map((r) => r.key);
  const pol = await query(a.head, `select qual from pg_policies where schemaname = '${A.schema}'`);
  void pol; // pg_policies is a catalog view: refused by the pre-check, and the DB-level test below reads policies directly
  const policies = (await pool.query('select qual from pg_policies where schemaname = $1', [A.schema])).rows.map((r) => r.qual).join('\n');
  for (const k of keys) assert.ok(!policies.includes(k), 'no policy contains a raw key');
});

test('core tables, keys and answers are not reachable from player SQL', async () => {
  const { head } = await startedTeam(A);
  for (const tbl of ['public.tasks', 'public.cases', 'public.case_table_keys', 'public.teams', 'public.players', 'public.task_attempts', 'public.final_options', 'public.team_scores', 'public.registrations', 'public.query_logs', 'public.task_hints']) {
    const r = await query(head, `select * from ${tbl}`);
    assert.equal(r.data.ok, false, tbl);
    assert.equal(r.data.error_type, 'permission', tbl);
    assert.ok(!/correct_answer|case_code|password|is_correct/i.test(r.text), tbl);
  }
  for (const sql of [
    "select set_config('role','postgres',true), (select count(*) from cast_crew)",
    "select set_config('role','postgres',true), query_to_xml('select * from public.tasks', true, false, '')",
    "select pg_read_file('/etc/passwd')",
    "select dblink('host=localhost','select 1')",
    "select query_to_xml('select * from public.cases', true, false, '')",
  ]) {
    const r = await query(head, sql);
    assert.ok(r.status === 400 || r.data.ok === false, sql); // refused by the pre-check or by the database
  }
});

test('writes, locks and DDL are impossible even when the pre-check is satisfied', async () => {
  const { head } = await startedTeam(A);
  const tbl = A.def.phases[0].tables[0];
  for (const sql of [
    `with d as (delete from ${tbl} returning *) select * from d`,
    `with u as (update ${tbl} set name='x' returning *) select * from u`,
    `select * into newtab from ${tbl}`,
    `select * from ${tbl} for update`,
    'select pg_terminate_backend(pg_backend_pid())',
  ]) {
    const r = await query(head, sql);
    assert.ok(r.status === 400 || r.data.ok === false, sql); // refused by the pre-check (pg_* functions) or by the database
  }
  assert.equal((await pool.query(`select count(*)::int n from ${A.schema}.${tbl}`)).rows[0].n, 14);
  assert.equal((await pool.query("select count(*)::int n from pg_tables where tablename = 'newtab'")).rows[0].n, 0);
  assert.equal(await count(head, tbl), '14', 'the console still works after all of that');
});

test('an expensive query is killed by the statement timeout and the pool is not wedged', async () => {
  const { head, inv } = await (async () => {
    const t = await makeTeam(A, 2);
    await t.head.post('/api/start');
    return t;
  })();
  const slow = 'select count(*) from generate_series(1,5000) a, generate_series(1,5000) b, generate_series(1,50) c';
  const t0 = Date.now();
  const r = await query(head, slow);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.error_type, 'timeout');
  assert.ok(Date.now() - t0 < 6000);
  assert.equal((await query(head, 'select 1')).data.ok, true);
  const rs = await Promise.all([head, inv[0], inv[1]].map((c) => query(c, slow)));
  assert.ok(rs.every((x) => x.data.error_type === 'timeout'));
  assert.equal((await query(head, 'select 2')).data.rows[0][0], 2);
  // a statement that tries to switch the timeout off is still bounded
  assert.equal((await query(head, `select set_config('statement_timeout','0',true), (${slow})`)).data.error_type, 'timeout');
});

test('row cap: at most 200 rows with a truncated flag; wrapper-escape tricks cannot lift it', async () => {
  const { head } = await startedTeam(A);
  const r = await query(head, 'select * from generate_series(1, 1000) as n');
  assert.equal(r.data.rows.length, 200);
  assert.equal(r.data.truncated, true);
  assert.equal((await query(head, 'select * from generate_series(1, 200) as n')).data.truncated, false);
  const trick = await query(head, 'select 1) as a union all select * from generate_series(1, 100000) x union all select * from (select 1');
  assert.ok(trick.data.ok === false || trick.data.rows.length <= 200);
  assert.equal((await query(head, 'select 1')).data.ok, true);
});

test('result types: timestamps keep their text, errors are friendly', async () => {
  const { head } = await startedTeam(A);
  const r = await query(head, 'select logged_at, badge_id from access_log order by log_id limit 1');
  assert.match(r.data.rows[0][0], /^2025-03-14 16:30:00/);
  assert.deepEqual(r.data.columns, ['logged_at', 'badge_id']);
  const syn = await query(head, 'select from from');
  assert.equal(syn.data.error_type, 'sql');
  assert.match((await query(head, 'select * from no_such_table')).data.error, /doesn't exist/i);
});

test('per-player rate limit: the 31st query in a minute -> 429 + Retry-After; teammates unaffected; refused ones not logged', async () => {
  const { head, inv, teamCode } = await (async () => {
    const t = await makeTeam(A, 1);
    await t.head.post('/api/start');
    return t;
  })();
  for (let i = 0; i < 30; i++) assert.equal((await query(head, 'select 1')).status, 200, `query ${i + 1}`);
  const over = await query(head, 'select 1');
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal((await query(inv[0], 'select 1')).status, 200);
  const n = (await pool.query('select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1', [rawCode(teamCode)])).rows[0].n;
  assert.equal(n, 31);
});

test('concurrent bursts from one player cannot overshoot the rate limit', async () => {
  const { head } = await startedTeam(A);
  const rs = await Promise.all(Array.from({ length: 45 }, () => query(head, 'select 1')));
  assert.equal(rs.filter((r) => r.status === 200).length, 30);
  assert.equal(rs.filter((r) => r.status === 429).length, 15);
});

test('query_logs records what is needed to debug a stuck console (and never the SQL text)', async () => {
  const { head, teamCode } = await startedTeam(A);
  await query(head, 'select * from cast_crew');
  await query(head, 'select * from nope');
  await query(head, 'select * from generate_series(1,300) n');
  const rows = (await pool.query('select l.*, p.display_name from query_logs l join teams t on t.id = l.team_id join players p on p.id = l.player_id where t.team_code = $1 order by l.created_at', [rawCode(teamCode)])).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].row_count, 14);
  assert.match(rows[0].query_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[1].error_type, 'unknown_table');
  assert.equal(rows[2].row_count, 200);
  assert.ok(!('query_text' in rows[0]) && !('sql' in rows[0]));
  assert.ok(rows.every((r) => r.error_type !== 'pending'));
});

test('player_exec at the DB level: every gate holds with the real connection', async () => {
  const p = new pg.Client({ connectionString: process.env.DATABASE_URL_PLAYER });
  await p.connect();
  try {
    const me = (await p.query("select current_user, current_setting('statement_timeout') st, current_setting('default_transaction_read_only') ro")).rows[0];
    assert.deepEqual(me, { current_user: 'player_exec', st: '3s', ro: 'on' });
    const keys = Object.fromEntries((await pool.query('select table_name, key from case_table_keys where case_id = $1', [A.caseId])).rows.map((r) => [r.table_name, r.key]));
    const otherKeys = (await pool.query('select key from case_table_keys where case_id = $1', [B.caseId])).rows.map((r) => r.key);
    const count = async (keyList, tbl) => {
      await p.query('begin read only');
      await p.query('select set_config($1, $2, true)', ['app.keys', keyList.join(',')]);
      const r = await p.query(`select count(*)::int n from ${A.schema}.${tbl}`);
      await p.query('rollback');
      return r.rows[0].n;
    };
    const [t1, t2] = A.def.phases[0].tables;
    const custody = tablesOf(A, 't2a')[0];
    assert.equal(await count([], t1), 0, 'no keys, no rows');
    assert.equal(await count([keys[t1]], t1), 14);
    assert.equal(await count([keys[t1]], t2), 0, "one table's key opens only that table");
    assert.equal(await count([keys[t1], keys[t2]], t2) > 0, true);
    assert.equal(await count([keys[t1], keys[t2]], custody), 0);
    assert.equal(await count([keys[custody]], custody) > 0, true);
    assert.equal(await count(otherKeys, t1), 0, "another case's keys open nothing here");
    assert.equal(await count(['', ',,', ' '], t1), 0);
    await p.query('begin');
    await assert.rejects(p.query(`insert into ${A.schema}.${t1} values (99,'x','x','x','x')`));
    await p.query('rollback');
    await assert.rejects(p.query('create table public.evil (id int)'));
    await assert.rejects(p.query('select * from public.tasks'));
    await assert.rejects(p.query('select * from public.case_table_keys'));
  } finally {
    await p.end();
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Evidence Browser (Logic track)
// ------------------------------------------------------------------------------------------------------------------
const browse = (c, body) => evidence(c, body);
const sightings = () => L.def.tables.find((t) => t.name.endsWith('_sightings')).name;
const statements = () => L.def.tables.find((t) => t.name.endsWith('_statements')).name;
const people = () => L.def.tables.find((t) => t.name.endsWith('_people')).name;

test('Evidence Browser: lists only unlocked tables, and unlocks follow the thread rules', async () => {
  const { head } = await startedTeam(L);
  let cat = (await browse(head, {})).data;
  assert.deepEqual(cat.tables.map((t) => t.name).sort(), [people(), sightings()].sort());
  assert.equal((await browse(head, { table: statements() })).status, 404, 'the statements are locked behind a thread');
  // finish the first thread: the statements thread becomes available and opens the table
  for (const q of L.tasksIn('t1a')) await submit(head, q.id, answerValue(q));
  cat = (await browse(head, {})).data;
  assert.ok(cat.tables.some((t) => t.name === statements()));
  const rows = await browse(head, { table: statements() });
  assert.equal(rows.status, 200);
  assert.ok(rows.data.total > 5);
});

test('Evidence Browser: search, filters, sort and pagination work and agree with the SQL console', async () => {
  const { head } = await startedTeam(L);
  const table = sightings();
  const all = (await browse(head, { table, page_size: 100 })).data;
  assert.equal(all.ok, true);
  assert.deepEqual(all.columns, ['sighting_id', 'person_id', 'place', 'seen_at', 'source']);
  assert.equal(all.total, Number((await query(head, `select count(*) from ${table}`)).data.rows[0][0]));
  assert.equal(all.rows.length, Math.min(100, all.total));

  const area = L.def.meta.area.toUpperCase().replaceAll(' ', '_');
  const f = await browse(head, { table, filters: [{ column: 'place', op: 'eq', value: area }, { column: 'source', op: 'eq', value: 'cctv' }], page_size: 100 });
  assert.equal(f.status, 200, f.text);
  assert.ok(f.data.rows.length > 0 && f.data.rows.every((r) => r[2] === area && r[4] === 'CCTV'));
  const viaSql = Number((await query(head, `select count(*) from ${table} where place = '${area}' and source = 'CCTV'`)).data.rows[0][0]);
  assert.equal(f.data.total, viaSql);

  const s = await browse(head, { table, search: area.slice(0, 6).toLowerCase(), page_size: 100 });
  assert.ok(s.data.total > 0 && s.data.rows.every((r) => r.join(' ').toLowerCase().includes(area.slice(0, 6).toLowerCase())));

  const asc = (await browse(head, { table, sort: { column: 'seen_at', dir: 'asc' }, page_size: 100 })).data.rows.map((r) => r[3]);
  const desc = (await browse(head, { table, sort: { column: 'seen_at', dir: 'desc' }, page_size: 100 })).data.rows.map((r) => r[3]);
  assert.deepEqual(asc, [...asc].sort());
  assert.deepEqual(desc, [...asc].reverse());

  const gt = await browse(head, { table, filters: [{ column: 'person_id', op: 'gt', value: '10' }], page_size: 100 });
  assert.ok(gt.data.rows.length > 0 && gt.data.rows.every((r) => r[1] > 10));
  const win = L.def.tables.find((t) => t.name === sightings()).rows[0][2].slice(0, 10);
  const before = await browse(head, { table, filters: [{ column: 'seen_at', op: 'lt', value: `${win} 12:00:00` }], page_size: 100 });
  assert.equal(before.status, 200, 'temporal comparison');

  // pagination: pages are disjoint and cover everything
  const p1 = (await browse(head, { table, page: 1, page_size: 10, sort: { column: 'seen_at', dir: 'asc' } })).data;
  const p2 = (await browse(head, { table, page: 2, page_size: 10, sort: { column: 'seen_at', dir: 'asc' } })).data;
  assert.equal(p1.rows.length, 10);
  assert.equal(p1.pages, Math.ceil(p1.total / 10));
  assert.deepEqual([...p1.rows, ...p2.rows], (await browse(head, { table, page: 1, page_size: 20, sort: { column: 'seen_at', dir: 'asc' } })).data.rows);
  assert.equal((await browse(head, { table, page_size: 5000 })).data.page_size, 100, 'page size is capped');
});

test('Evidence Browser: names and values are allow-listed and parameterized; injection attempts are inert', async () => {
  const { head } = await startedTeam(L);
  const table = sightings();
  const before = (await browse(head, { table })).data.total;
  const bad = [
    { table: `${table}"; drop table ${table}; --` },
    { table: `${L.schema}.${table}` },
    { table: 'public.tasks' },
    { table: 'tasks' },
    { table: ['a'] },
    { table, sort: { column: 'seen_at; drop table x', dir: 'asc' } },
    { table, sort: { column: 'password_hash', dir: 'asc' } },
    { table, filters: [{ column: '1=1 or place', op: 'eq', value: 'x' }] },
    { table, filters: [{ column: 'place', op: 'eq; drop', value: 'x' }] },
    { table, filters: 'place=1' },
    { table, filters: Array.from({ length: 9 }, () => ({ column: 'place', op: 'eq', value: 'x' })) },
    { table, filters: [{ column: 'place', op: 'eq', value: 5 }] },
    { table, search: 'x'.repeat(500) },
  ];
  for (const b of bad) {
    const r = await browse(head, b);
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(b).slice(0, 80)} -> ${r.status}`);
  }
  // hostile VALUES are just text: they match nothing and never error or escape
  // LIKE wildcards are escaped: '_' matches a literal underscore only (some place names contain one), '%' matches nothing
  const withUnderscore = Number((await query(head, `select count(*) from ${table} where position('_' in place) > 0`)).data.rows[0][0]);
  assert.ok(withUnderscore > 0 && withUnderscore <= before);
  const area0 = L.def.meta.area.toUpperCase().replaceAll(' ', '_');
  const probe = area0.slice(0, 1) + '_' + area0.slice(2);
  assert.equal((await browse(head, { table, filters: [{ column: 'place', op: 'contains', value: probe }] })).data.total, 0, 'an underscore never acts as a one-character wildcard');
  const us = await browse(head, { table, filters: [{ column: 'place', op: 'contains', value: '_' }] });
  assert.equal(us.data.total, withUnderscore, 'underscore is literal, not a wildcard');
  const pct = await browse(head, { table, filters: [{ column: 'place', op: 'contains', value: '%' }] });
  assert.equal(pct.data.total, 0, 'percent is literal, not a wildcard');
  for (const value of [`' or 1=1 --`, `x'; drop table ${table}; --`, '\\', '\u0000']) {
    const r = await browse(head, { table, filters: [{ column: 'place', op: 'contains', value }] });
    assert.ok(r.status === 200 || r.status === 400, `${value} -> ${r.status}`);
    if (r.status === 200) assert.equal(r.data.total, 0, `value ${JSON.stringify(value)} must not match everything`);
    const s = await browse(head, { table, search: value });
    if (s.status === 200) assert.equal(s.data.total, 0);
  }
  assert.equal((await browse(head, { table })).data.total, before, 'nothing was dropped or changed');
  // a value that does not fit the column type is a clean 400, never a 500
  assert.equal((await browse(head, { table, filters: [{ column: 'person_id', op: 'gt', value: 'abc' }] })).status, 400);
  assert.equal((await browse(head, { table, filters: [{ column: 'seen_at', op: 'gt', value: 'not a date' }] })).status, 400);
});

test('Evidence Browser: another case, a locked table and an unstarted game give nothing', async () => {
  const t = await makeTeam(L);
  assert.equal((await browse(t.head, { table: sightings() })).status, 409, 'before the start');
  await t.head.post('/api/start');
  assert.equal((await browse(t.head, { table: L.def.tables.find((x) => x.name.endsWith('_handling')).name })).status, 404, 'a locked table');
  const a = await startedTeam(A);
  assert.equal((await browse(a.head, { table: sightings() })).status, 404, "a table of another case's schema");
});

test('Evidence Browser: the optional SQL console is available from the start on the Logic track, with the same gates', async () => {
  const { head } = await startedTeam(L);
  assert.ok(Number((await query(head, `select count(*) from ${sightings()}`)).data.rows[0][0]) > 20);
  assert.equal((await query(head, `select count(*) from ${statements()}`)).data.rows[0][0], '0', 'locked tables return nothing in the console either');
});

test('Evidence Browser has its own per-player limit', async () => {
  const { head } = await startedTeam(L);
  let limited = false;
  for (let i = 0; i < 100 && !limited; i++) limited = (await browse(head, { table: sightings(), page_size: 1 })).status === 429;
  assert.ok(limited, 'excessive browsing is throttled');
  void BASE;
});
