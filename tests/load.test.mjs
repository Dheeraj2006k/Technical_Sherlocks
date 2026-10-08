// Stage 7 load test: ~36 concurrent clients (12 teams x 3) on ONE Node instance, a pool of 2 DB
// connections per pool, and a remote database: the worst case for the event (Vercel adds instances).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, makeRealCase, Client, rawCode } from './helpers.mjs';

const pool = db();
let R;
const TEAMS = 12;

before(async () => {
  R = await makeRealCase(pool);
});
after(async () => {
  await R.cleanup();
  await pool.end();
});

const lat = { query: [], state: [], submit: [], assign: [], other: [] };
const statuses = {};
async function timed(kind, client, method, path, body) {
  const t0 = performance.now();
  const r = await client.req(method, path, body);
  lat[kind].push(performance.now() - t0);
  statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  return r;
}
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]) : 0;
};
const summary = () =>
  Object.entries(lat)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k}: n=${v.length} p50=${pct(v, 50)}ms p95=${pct(v, 95)}ms max=${pct(v, 100)}ms`)
    .join(' | ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERIES = [
  'select * from cast_crew',
  'select door, count(*) from access_log group by door order by 2 desc',
  "select cc.name, count(*) from access_log a join cast_crew cc on cc.badge_id = a.badge_id where a.door = 'PROP_ROOM' group by cc.name",
  "select * from access_log where direction = 'IN' and logged_at > '2025-03-14 20:00' order by logged_at",
  'select department, count(*) from cast_crew group by department',
  'select count(*) from access_log',
];

test('36 concurrent clients: console + submissions + state polling hold up', async () => {
  // --- set up 12 teams of 3
  const teams = [];
  await Promise.all(
    Array.from({ length: TEAMS }, async (_, i) => {
      const head = new Client();
      const r = await head.post('/api/join', { case_code: R.caseCode, case_password: R.password, display_name: 'Head', idempotency_key: randomUUID(), team_name: `Load-${i}` });
      assert.equal(r.status, 200, r.text);
      const inv = [new Client(), new Client()];
      for (const [k, c] of inv.entries()) assert.equal((await c.joinTeam(r.data.team.team_code, `Inv${k + 1}`)).status, 200);
      teams.push({ head, inv, code: r.data.team.team_code });
    }),
  );
  await Promise.all(teams.map(async (t) => assert.equal((await t.head.post('/api/start')).status, 200)));

  // --- the storm: every player queries, polls state, and solves a task
  const p1 = R.byPhase(1);
  const jonah = (await teams[0].head.get('/api/state')).data.roster.find((c) => c.name === 'Jonah Pike').id;
  const answers = [p1[0].correct_answer, p1[1].correct_answer, p1[2].correct_answer]; // 4, 21:03, Jonah(uuid per case)
  void jonah;
  let stop = false;
  const pollers = [];
  const players = teams.flatMap((t) => [t.head, ...t.inv].map((c, idx) => ({ c, idx, team: t })));

  for (const p of players) {
    pollers.push(
      (async () => {
        while (!stop) {
          const r = await timed('state', p.c, 'GET', '/api/state');
          assert.equal(r.status, 200);
          await sleep(3000); // same cadence as the UI
        }
      })(),
    );
  }

  const t0 = performance.now();
  await Promise.all(
    players.map(async ({ c, idx, team }) => {
      await sleep(Math.random() * 400);
      // head hands out the three tasks
      if (idx === 0) {
        const st = (await timed('other', c, 'GET', '/api/state')).data;
        for (const [k, t] of p1.entries()) {
          const target = st.players[k % st.players.length];
          const r = await timed('assign', c, 'POST', '/api/assign-task', { task_id: t.id, player_id: target.id });
          assert.equal(r.status, 200);
        }
      }
      for (let i = 0; i < 5; i++) {
        const r = await timed('query', c, 'POST', '/api/query', { sql: QUERIES[(i + idx) % QUERIES.length] });
        assert.equal(r.status, 200, `query status ${r.status} ${r.text.slice(0, 120)}`);
        assert.equal(r.data.ok, true, r.text.slice(0, 200));
        await sleep(100 + Math.random() * 300);
      }
      // everyone submits the task they were handed (k = their index in the team)
      const task = p1[idx];
      const r = await timed('submit', c, 'POST', '/api/submit-task', { task_id: task.id, value: answers[idx] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.correct, true);
      void team;
    }),
  );
  const wall = Math.round(performance.now() - t0);
  stop = true;
  await Promise.all(pollers);

  console.log(`# LOAD ${players.length} clients, ${wall}ms wall | ${summary()} | statuses ${JSON.stringify(statuses)}`);

  // --- outcomes
  assert.ok(!Object.keys(statuses).some((s) => Number(s) >= 500), `no 5xx: ${JSON.stringify(statuses)}`);
  for (const t of teams) {
    const st = (await t.head.get('/api/state')).data;
    assert.equal(st.state, 'PHASE_2', 'every team cleared phase 1');
    assert.equal(st.scores.total_pts, 20, 'exactly +20 per team');
  }
  const queries = (await pool.query('select count(*)::int n, count(*) filter (where success)::int ok, count(*) filter (where error_type = $2)::int pending from query_logs l join teams t on t.id = l.team_id where t.case_id = $1', [R.caseId, 'pending'])).rows[0];
  assert.equal(queries.n, TEAMS * 3 * 5);
  assert.equal(queries.ok, queries.n);
  assert.equal(queries.pending, 0);
  assert.ok(pct(lat.query, 95) < 10000, `query p95 ${pct(lat.query, 95)}ms`);
  assert.ok(pct(lat.state, 95) < 6000, `state p95 ${pct(lat.state, 95)}ms`);
  assert.ok(pct(lat.submit, 95) < 10000, `submit p95 ${pct(lat.submit, 95)}ms`);
});

test('under load: one player hammering gets rate limited (exactly 30 ok) without hurting teammates', async () => {
  const head = new Client();
  const r = await head.post('/api/join', { case_code: R.caseCode, case_password: R.password, display_name: 'Hammer', idempotency_key: randomUUID() });
  const mate = new Client();
  await mate.joinTeam(r.data.team.team_code, 'Mate');
  await head.post('/api/start');
  const flood = Array.from({ length: 50 }, () => head.post('/api/query', { sql: 'select 1' }));
  const mateRuns = Array.from({ length: 5 }, () => mate.post('/api/query', { sql: 'select count(*) from cast_crew' }));
  const [floodRes, mateRes] = await Promise.all([Promise.all(flood), Promise.all(mateRuns)]);
  assert.equal(floodRes.filter((x) => x.status === 200).length, 30);
  assert.equal(floodRes.filter((x) => x.status === 429).length, 20);
  assert.ok(mateRes.every((x) => x.status === 200 && x.data.ok), 'teammate unaffected');
  const n = (await pool.query('select count(*)::int n from query_logs l join teams t on t.id = l.team_id where t.team_code = $1', [rawCode(r.data.team.team_code)])).rows[0].n;
  assert.equal(n, 35);
});

test('under load: statement_timeout kills slow queries cleanly and other teams still get answers', async () => {
  const mk = async (name) => {
    const c = new Client();
    const r = await c.post('/api/join', { case_code: R.caseCode, case_password: R.password, display_name: name, idempotency_key: randomUUID() });
    assert.equal(r.status, 200);
    await c.post('/api/start');
    return c;
  };
  const attackers = await Promise.all([mk('A1'), mk('A2'), mk('A3'), mk('A4')]);
  const victims = await Promise.all([mk('V1'), mk('V2'), mk('V3')]);
  const slow = 'select count(*) from generate_series(1,5000) a, generate_series(1,5000) b, generate_series(1,50) c';
  const t0 = performance.now();
  const slowRuns = attackers.map((c) => c.post('/api/query', { sql: slow }));
  await sleep(300);
  const quick = victims.map(async (c) => {
    const s = performance.now();
    const r = await c.post('/api/query', { sql: 'select count(*) from cast_crew' });
    return { r, ms: performance.now() - s };
  });
  const [slowRes, quickRes] = await Promise.all([Promise.all(slowRuns), Promise.all(quick)]);
  const wall = performance.now() - t0;
  assert.ok(slowRes.every((x) => x.data.error_type === 'timeout'), JSON.stringify(slowRes.map((x) => x.data.error_type)));
  assert.ok(quickRes.every((x) => x.r.status === 200 && x.r.data.ok), 'victims still served');
  console.log(`# SLOW-QUERY STORM: 4 slow x 3s on a pool of 2; victim latencies ms = ${quickRes.map((x) => Math.round(x.ms)).join(', ')}; total ${Math.round(wall)}ms`);
  assert.ok(wall < 20000, `storm resolved in ${Math.round(wall)}ms`);
  // and the console is healthy afterwards
  assert.equal((await victims[0].post('/api/query', { sql: 'select 2' })).data.rows[0][0], 2);
});
