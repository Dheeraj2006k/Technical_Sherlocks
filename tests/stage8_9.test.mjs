// Stage 8 (all 10 cases) and Stage 9 (event rehearsal, automated stand-in): every case is installed, then
// 10 teams, one per case, play CONCURRENTLY through the real console while the organizer watches the
// dashboard, pauses and resumes the whole game, and resets an abandoned team. Humans still have to do the
// "someone who doesn't know the answer plays it" validation and the real multi-machine rehearsal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { db, makeCaseFromDefinition, Client, AdminClient, query, submit, rawCode } from './helpers.mjs';
import { DEFINITIONS } from '../scripts/cases/index.mjs';
import { verifyDefinition } from '../scripts/cases/engine.mjs';

const pool = db();
const cases = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  for (const def of DEFINITIONS) cases.push(await makeCaseFromDefinition(pool, def));
});
after(async () => {
  for (const c of cases) await c.cleanup();
  await pool.end();
});

test('Stage 8: there are exactly 10 distinct cases with distinct settings, codes and answer sets', () => {
  assert.equal(DEFINITIONS.length, 10);
  assert.equal(new Set(DEFINITIONS.map((d) => d.slug)).size, 10);
  assert.equal(new Set(DEFINITIONS.map((d) => d.title)).size, 10);
  assert.equal(new Set(DEFINITIONS.map((d) => d.culpritName)).size, 10, 'a different culprit in every case');
  assert.equal(new Set(DEFINITIONS.map((d) => d.victimName)).size, 10);
  const vectors = DEFINITIONS.map((d) => d.tasks.map((t) => t.answer).join('|'));
  assert.equal(new Set(vectors).size, 10, 'no two cases share a full answer sheet');
  // per task slot, most answers differ (teams on different cases cannot copy each other)
  for (let slot = 0; slot < 9; slot++) {
    const answers = DEFINITIONS.map((d) => d.tasks[slot].answer);
    assert.ok(new Set(answers).size >= 3, `task slot ${slot} has only ${new Set(answers).size} distinct answers`);
  }
  assert.equal(new Set(cases.map((c) => c.caseCode)).size, 10);
});

test('Stage 8: every case passes the machine-checkable validation checklist', async () => {
  const bad = [];
  for (const c of cases) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const results = await verifyDefinition(client, c.def, c);
      for (const r of results) if (!r.ok) bad.push(`${c.def.title}: ${r.label} (${r.detail})`);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }
  assert.deepEqual(bad, []);
});

test('Stage 8/9: all 10 cases play concurrently end to end, with pause, reset and live dashboard', async () => {
  const admin = new AdminClient();
  assert.equal((await admin.login()).status, 200);

  const retry = async (fn) => {
    for (let i = 0; i < 80; i++) {
      const r = await fn();
      if (r.status !== 423) return r;
      await sleep(250);
    }
    throw new Error('stayed paused');
  };

  // --- build the 10 teams (head + investigator each)
  const teams = await Promise.all(
    cases.map(async (c, i) => {
      const head = new Client();
      const r = await head.post('/api/join', { case_code: c.caseCode, case_password: c.password, display_name: 'Head', idempotency_key: randomUUID(), team_name: `Rehearsal-${i + 1}` });
      assert.equal(r.status, 200, r.text);
      const inv = new Client();
      assert.equal((await inv.joinTeam(r.data.team.team_code, 'Inv')).status, 200);
      return { c, i, head, inv, code: r.data.team.team_code };
    }),
  );

  const abandoned = teams[8];
  let abandonedReset = false;
  const events = { paused: false, resumed: false };

  async function play(t, { stopAfterPhase1 = false } = {}) {
    const { c, head, inv } = t;
    assert.equal((await retry(() => head.post('/api/start'))).status, 200);
    const roster = (await head.get('/api/state')).data.roster;
    for (const phase of [1, 2, 3]) {
      for (const task of c.byPhase(phase)) {
        const q = await retry(() => query(head, task.sql));
        assert.equal(q.data?.ok, true, `${c.def.title} p${phase}: ${q.text.slice(0, 200)}`);
        let value = String(q.data.rows[0][0]);
        if (task.answer_type === 'SINGLE_CHARACTER') value = roster.find((x) => x.name === value).id;
        const s = await retry(() => submit(head, task.id, value));
        assert.equal(s.status, 200, s.text);
        assert.equal(s.data.correct, true, `${c.def.title} ${task.answer_type} answer rejected`);
      }
      if (stopAfterPhase1 && phase === 1) return;
    }
    // cross-case isolation, probed by the investigator (own rate-limit bucket) while everyone else plays
    for (const other of cases) {
      if (other === c) continue;
      const tbl = other.def.tables[0].name;
      const probe = await retry(() => query(inv, `select count(*) from ${other.schema}.${tbl}`));
      assert.ok(probe.data.ok === false || probe.data.rows[0][0] === '0', `${c.def.title} must not see ${other.def.title}`);
    }
    const done = await retry(() => head.post('/api/submit-culprit', { character_id: c.culpritId }));
    assert.equal(done.status, 200, done.text);
    assert.equal(done.data.correct, true);
    assert.equal(done.data.total_pts, 100);
  }

  // organizer: watches the dashboard, pauses everything mid-game, resumes, resets the abandoned team
  let sawAll = false;
  const organizer = (async () => {
    await sleep(2500);
    const seen = (await admin.get('/api/admin/dashboard')).data.teams.filter((t) => t.team_name.startsWith('Rehearsal-'));
    sawAll = seen.length === 10;
    assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: true })).status, 200);
    events.paused = true;
    await sleep(2500);
    const during = (await admin.get('/api/admin/dashboard')).data;
    assert.equal(during.game_paused, true);
    assert.ok(during.teams.filter((t) => t.team_name.startsWith('Rehearsal-')).every((t) => t.status === 'paused' || t.status === 'finished'));
    assert.equal((await admin.post('/api/admin/pause', { scope: 'global', paused: false })).status, 200);
    events.resumed = true;
    // reset the abandoned team once it has gone quiet after phase 1
    for (let i = 0; i < 60; i++) {
      const row = (await admin.get('/api/admin/dashboard')).data.teams.find((t) => t.team_code === abandoned.code);
      if (row && row.state === 'PHASE_2') break;
      await sleep(500);
    }
    const others = await Promise.all(teams.filter((t) => t !== abandoned).map(async (t) => (await t.head.get('/api/state')).data.scores.total_pts));
    assert.equal((await admin.post('/api/admin/reset-team', { team_code: abandoned.code })).status, 200);
    const after = await Promise.all(teams.filter((t) => t !== abandoned).map(async (t) => (await t.head.get('/api/state')).data.scores.total_pts));
    assert.ok(after.every((pts, i) => pts >= others[i]), 'no other team lost points to the reset');
    const st = (await abandoned.head.get('/api/state')).data;
    assert.equal(st.state, 'WAITING');
    assert.equal(st.scores.total_pts, 0);
    abandonedReset = true;
  })();

  const t0 = Date.now();
  await Promise.all([
    ...teams.filter((t) => t !== abandoned).map((t) => play(t)),
    (async () => {
      await play(abandoned, { stopAfterPhase1: true });
      while (!abandonedReset) await sleep(300);
      await play(abandoned); // a clean second run after the admin reset
    })(),
    organizer,
  ]);
  const wall = Math.round((Date.now() - t0) / 1000);
  console.log(`# REHEARSAL 10 cases x 2 players, ${wall}s wall, including a 2.5s global pause and one admin reset`);

  assert.ok(sawAll, 'the dashboard listed all 10 teams while they played');
  assert.ok(events.paused && events.resumed);

  // --- results: everyone finished with 100, leaderboard sorted with the correct tie-break
  const lb = (await new Client().get('/api/leaderboard')).data.teams.filter((t) => t.team_name.startsWith('Rehearsal-'));
  assert.equal(lb.length, 10);
  assert.ok(lb.every((t) => t.total_pts === 100 && t.finished && t.phases_cleared === 3));
  const order = lb.map((t) => t.team_name);
  const dbOrder = (
    await pool.query(
      `select t.team_name from teams t join culprit_submission cs on cs.team_id = t.id
        where t.team_name like 'Rehearsal-%' and t.case_id = any($1)
        order by cs.submitted_at asc`,
      [cases.map((c) => c.caseId)],
    )
  ).rows.map((r) => r.team_name);
  assert.deepEqual(order, dbOrder, 'with identical points the earliest correct culprit submission ranks first');

  // timers: paused time is excluded, nothing finished in negative or absurd time
  assert.ok(lb.every((t) => t.elapsed_s >= 0 && t.elapsed_s < 600));
  const dash = (await admin.get('/api/admin/dashboard')).data.teams.filter((t) => t.team_name.startsWith('Rehearsal-'));
  assert.ok(dash.every((t) => t.status === 'finished' && t.recent_errors >= 0));

  // --- query_logs: complete, none stuck, and discardable after the event
  const ids = teams.map((t) => t.code);
  const stats = (
    await pool.query(
      `select count(*)::int n, count(*) filter (where success)::int ok, count(*) filter (where error_type = 'pending')::int pending
         from query_logs l join teams t on t.id = l.team_id where t.team_code = any($1)`,
      [ids.map(rawCode)],
    )
  ).rows[0];
  assert.ok(stats.n >= 10 * 9 + 10 * 9, `query_logs captured ${stats.n} queries`);
  assert.equal(stats.pending, 0);
  assert.equal(stats.ok, stats.n, 'every logged query completed successfully');
  const del = await pool.query('delete from query_logs where team_id in (select id from teams where team_code = any($1))', [ids.map(rawCode)]);
  assert.equal(del.rowCount, stats.n);
  assert.equal((await pool.query('select count(*)::int n from teams where team_code = any($1)', [ids.map(rawCode)])).rows[0].n, 10, 'discarding logs leaves teams and scores intact');
  const sc = (await pool.query('select min(total_pts)::int m from team_scores where team_id in (select id from teams where team_code = any($1))', [ids.map(rawCode)])).rows[0].m;
  assert.equal(sc, 100);
});

test('post-event cleanup script: dry run changes nothing and reports counts', () => {
  const r = spawnSync('node', ['scripts/discard-query-logs.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /query_logs: \d+ rows/);
  assert.match(r.stdout, /dry run: nothing deleted/);
});
