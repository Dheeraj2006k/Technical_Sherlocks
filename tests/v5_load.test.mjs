import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, makeGame, FIXTURES, Client, makeTeam, answerValue, finishFinal, query, evidence, hint, submit, flattenQuestions } from './helpers.mjs';

// Event-day load: ~35 players across 12 teams on both tracks, all active at once, then every team finishes.
const pool = db();
const games = [];

before(async () => {
  // six SQL and six Logic cases, each its own throwaway copy
  for (const code of ['SQL01', 'SQL02', 'SQL03', 'SQL04', 'SQL05', 'SQL06', 'LOG01', 'LOG02', 'LOG03', 'LOG04', 'LOG05', 'LOG06']) {
    games.push(await makeGame(pool, FIXTURES.find((d) => d.code === code)));
  }
});
after(async () => {
  for (const g of games) await g.cleanup();
  await pool.end();
});

const timings = [];
async function timed(p) {
  const t0 = performance.now();
  const r = await p;
  timings.push(performance.now() - t0);
  return r;
}
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

test('35 players on 12 teams (SQL and Logic) play at the same time; everyone finishes with 100 and nothing 5xx', async () => {
  // team sizes sum to 35
  const sizes = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2];
  assert.equal(sizes.reduce((a, b) => a + b), 35);
  const statuses = [];
  const note = (r) => {
    statuses.push(r.status);
    return r;
  };

  const teams = await Promise.all(games.map(async (g, i) => {
    const t = await makeTeam(g, sizes[i] - 1);
    return { g, players: [t.head, ...t.inv], ...t };
  }));
  assert.equal(teams.reduce((n, t) => n + t.players.length, 0), 35);
  await Promise.all(teams.map((t) => t.head.post('/api/start')));

  // every team plays its own case: players split the questions, poll state, use the console / browser and take hints
  const play = async (t) => {
    const logic = t.g.track === 'LOGIC';
    const P = t.players;
    // background polling and reading while the team works
    const readers = P.map(async (p, i) => {
      for (let k = 0; k < 3; k++) {
        note(await timed(p.get('/api/state')));
        if (logic) note(await timed(evidence(p, { table: t.g.def.tables[1].name, page_size: 10 })));
        else note(await timed(query(p, `select count(*) from ${t.g.def.phases[0].tables[0]}`)));
        if (i === 0) note(await timed(p.get('/api/schema')));
      }
    });
    // questions in order; each answered by a rotating teammate (assignment is only a convenience)
    let n = 0;
    for (const task of t.g.tasks) {
      const p = P[n++ % P.length];
      if (n === 3) note(await timed(hint(p, task.id)));
      const r = note(await timed(submit(p, task.id, answerValue(task))));
      assert.equal(r.status, 200, `${t.g.def.code} ${r.text}`);
      assert.equal(r.data.correct, true);
    }
    await Promise.all(readers);
    const fin = await finishFinal(P[0], t.g);
    fin.forEach(note);
    return (await P[0].get('/api/state')).data;
  };

  const results = await Promise.all(teams.map(play));
  assert.ok(statuses.every((s) => s < 500), `5xx seen: ${statuses.filter((s) => s >= 500).length}`);
  for (const [i, st] of results.entries()) {
    assert.equal(st.state, 'FINISHED', games[i].def.code);
    assert.equal(st.scores.total_pts, 98, `${games[i].def.code}: 100 minus one hint (10 -> 8)`);
  }

  // database consistency: exactly one completion per (team, question), points add up, no stray attempts
  for (const t of teams) {
    const id = (await pool.query('select id from teams where registration_id = $1', [t.reg.id])).rows[0].id;
    const comp = (await pool.query('select count(*)::int n, sum(points_awarded)::int pts from team_task_completions where team_id = $1', [id])).rows[0];
    assert.equal(comp.n, 8);
    assert.equal(comp.pts, 78);
    const fin = (await pool.query('select sum(points_awarded)::int pts from team_final_completions where team_id = $1', [id])).rows[0].pts;
    assert.equal(comp.pts + fin, 98);
    assert.equal((await pool.query('select total_pts from team_scores where team_id = $1', [id])).rows[0].total_pts, 98);
  }

  const p50 = pct(timings, 50);
  const p95 = pct(timings, 95);
  console.log(`# load: ${timings.length} timed requests, p50 ${p50.toFixed(0)}ms, p95 ${p95.toFixed(0)}ms, max ${Math.max(...timings).toFixed(0)}ms`);
  assert.ok(p95 < 5000, `p95 ${p95.toFixed(0)}ms`);

  // the leaderboards list every team under its own track
  const sql = (await new Client().get('/api/leaderboard?track=SQL')).data.teams;
  const logic = (await new Client().get('/api/leaderboard?track=LOGIC')).data.teams;
  for (const t of teams) {
    const board = t.g.track === 'SQL' ? sql : logic;
    assert.ok(board.some((x) => x.team_name === t.reg.teamRef && x.total_pts === 98 && x.finished), `${t.g.def.code} on its board`);
  }
});

test('a burst of simultaneous joins, polls and answers does not deadlock or double-score', async () => {
  const g = games[0];
  const teams = await Promise.all(Array.from({ length: 8 }, () => makeTeam(g, 2)));
  await Promise.all(teams.map((t) => t.head.post('/api/start')));
  const q = g.tasks[0];
  const reqs = teams.flatMap((t) => [t.head, ...t.inv].flatMap((p) => [p.get('/api/state'), submit(p, q.id, answerValue(q)), p.get('/api/state')]));
  const rs = await Promise.all(reqs);
  assert.ok(rs.every((r) => r.status < 500));
  for (const t of teams) {
    const st = (await t.head.get('/api/state')).data;
    assert.equal(st.scores.total_pts, 10, 'each team scored the question exactly once');
    assert.equal(flattenQuestions(st).filter((x) => x.completed).length, 1);
  }
});
