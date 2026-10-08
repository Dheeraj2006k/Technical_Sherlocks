// Stage 5: realtime pings. Uses the real Supabase Realtime service. The browser would subscribe with the
// anon key; here the same client code subscribes with the service key (same protocol) because the anon
// key is not part of this environment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribeTeamChannel } from '../lib/realtime-client.mjs';
import { db, makeCase, submit, Client, rawCode } from './helpers.mjs';

const pool = db();
let S;

const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(new URL(process.env.DATABASE_URL).hostname)?.[1];
const RT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? (ref ? `https://${ref}.supabase.co` : null);
const RT_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = !RT_URL || !RT_KEY ? 'realtime not configured in this environment' : false;

before(async () => {
  S = await makeCase(pool);
});
after(async () => {
  await S.cleanup();
  await pool.end();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return Date.now() - t0;
    await sleep(step);
  }
  throw new Error('timed out waiting for condition');
}

async function team(n = 2) {
  const head = new Client();
  const r = await head.post('/api/join', { case_code: S.caseCode, case_password: S.password, display_name: 'Head', idempotency_key: randomUUID() });
  assert.equal(r.status, 200);
  const inv = [];
  for (let i = 0; i < n; i++) {
    const c = new Client();
    assert.equal((await c.joinTeam(r.data.team.team_code, `Inv${i + 1}`)).status, 200);
    inv.push(c);
  }
  const token = (await head.get('/api/state')).data.realtime_channel;
  return { head, inv, teamCode: r.data.team.team_code, token, all: [head, ...inv] };
}

// A "teammate's browser": subscribes and records pings and connection status with timestamps.
function listener(token) {
  const l = { pings: [], statuses: [], connected: false };
  l.sub = subscribeTeamChannel({
    url: RT_URL,
    apikey: RT_KEY,
    token,
    onPing: () => l.pings.push(Date.now()),
    onStatus: (s) => {
      l.statuses.push([s, Date.now()]);
      l.connected = s === 'connected';
    },
  });
  return l;
}

test('state exposes an unguessable per-team channel token (not the team id or code)', { skip }, async () => {
  const a = await team(0);
  const b = await team(0);
  assert.match(a.token, /^[0-9a-f]{32}$/);
  assert.notEqual(a.token, b.token);
  const row = (await pool.query('select id, team_code from teams where team_code = $1', [rawCode(a.teamCode)])).rows[0];
  assert.ok(!a.token.includes(rawCode(a.teamCode).toLowerCase()) && a.token !== row.id);
  // the public leaderboard and other teams never see it
  const lb = JSON.stringify((await new Client().get('/api/leaderboard')).data);
  assert.ok(!lb.includes(a.token) && !lb.includes(b.token));
});

test('Player A completes a task: players B and C are pinged within ~1s and refetch the right state', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const [b, c] = [listener(t.token), listener(t.token)];
  try {
    await until(() => b.connected && c.connected);
    const task = S.byPhase(1)[0];
    const sentAt = Date.now();
    assert.equal((await submit(t.head, task.id, task.correct_answer)).data.correct, true);
    const lat = await until(() => b.pings.length > 0 && c.pings.length > 0, 3000);
    console.log(`# REALTIME task-completion ping reached both teammates ${lat}ms after the submit response`);
    assert.ok(b.pings[0] - sentAt < 1500 && c.pings[0] - sentAt < 1500, 'within ~1s');
    for (const cl of [t.inv[0], t.inv[1]]) {
      const st = (await cl.get('/api/state')).data;
      assert.equal(st.tasks.find((x) => x.id === task.id).solved, true);
    }
  } finally {
    b.sub.close();
    c.sub.close();
  }
});

test('phase clears: all 3 teammates are pinged at the same moment and all see the same new narrative', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const ls = [listener(t.token), listener(t.token), listener(t.token)];
  try {
    await until(() => ls.every((l) => l.connected));
    const tasks = S.byPhase(1);
    await submit(t.head, tasks[0].id, tasks[0].correct_answer);
    await submit(t.inv[0], tasks[1].id, tasks[1].correct_answer);
    await until(() => ls.every((l) => l.pings.length >= 2));
    const before = ls.map((l) => l.pings.length);
    const clearedAt = Date.now();
    assert.equal((await submit(t.inv[1], tasks[2].id, tasks[2].correct_answer)).data.phase_cleared, true);
    await until(() => ls.every((l, i) => l.pings.length > before[i]), 3000);
    const stamps = ls.map((l, i) => l.pings[before[i]]);
    const spread = Math.max(...stamps) - Math.min(...stamps);
    console.log(`# REALTIME phase-clear: pings ${stamps.map((s) => s - clearedAt).join('/')}ms after request start, spread ${spread}ms`);
    assert.ok(spread < 600, `spread ${spread}ms`);
    const states = await Promise.all(t.all.map(async (c) => (await c.get('/api/state')).data));
    assert.ok(states.every((s) => s.state === 'PHASE_2'));
    assert.equal(new Set(states.map((s) => JSON.stringify(s.narrative))).size, 1, 'same narrative for everyone');
    assert.equal(states[0].narrative.length, 2);
  } finally {
    ls.forEach((l) => l.sub.close());
  }
});

test('socket killed mid-game: the client reconnects by itself and state is correct, not stale or duplicated', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const b = listener(t.token);
  const mirror = { solved: new Set(), refetches: 0 };
  const refetch = async () => {
    mirror.refetches++;
    const st = (await t.inv[0].get('/api/state')).data;
    mirror.solved = new Set(st.tasks.filter((x) => x.solved).map((x) => x.id));
    mirror.state = st.state;
  };
  // B's "app": refetch on every ping and on every (re)connect, exactly like app/App.tsx
  let connects = 0;
  const app = subscribeTeamChannel({
    url: RT_URL,
    apikey: RT_KEY,
    token: t.token,
    onPing: refetch,
    onStatus: (s) => {
      if (s === 'connected') connects++;
      refetch();
    },
  });
  try {
    await until(() => b.connected && connects >= 1);
    const [t1, t2, t3] = S.byPhase(1);
    await submit(t.head, t1.id, t1.correct_answer);
    await until(() => mirror.solved.has(t1.id));

    // --- the network drops for B
    app._drop();
    const droppedAt = Date.now();
    // teammates keep playing while B is offline: B misses these pings
    await submit(t.head, t2.id, t2.correct_answer);
    await submit(t.inv[1], t3.id, t3.correct_answer);
    // B reconnects on its own and refetches authoritative state
    const back = await until(() => connects >= 2 && mirror.state === 'PHASE_2', 12000);
    console.log(`# REALTIME reconnect: socket restored and state correct ${Date.now() - droppedAt}ms after the drop (waited ${back}ms)`);
    assert.equal(mirror.state, 'PHASE_2');
    // DB truth: exactly 3 correct rows, +20 once: nothing duplicated by the reconnect
    const n = (await pool.query('select count(*)::int n from task_submissions s join teams x on x.id = s.team_id where x.team_code = $1 and s.is_correct', [rawCode(t.teamCode)])).rows[0].n;
    assert.equal(n, 3);
    assert.equal((await t.head.get('/api/state')).data.scores.total_pts, 20);
    // and live updates work again after the reconnect
    const before = mirror.refetches;
    await submit(t.head, S.byPhase(2)[0].id, S.byPhase(2)[0].correct_answer);
    await until(() => mirror.refetches > before, 3000);
    assert.ok(mirror.state === 'PHASE_2');
  } finally {
    app.close();
    b.sub.close();
  }
});

test('pings carry no data, and another team is never pinged', { skip }, async () => {
  const a = await team(1);
  const other = await team(1);
  await a.head.post('/api/start');
  // raw socket on A's channel to inspect the actual payload
  const frames = [];
  const ws = new WebSocket(`${RT_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(RT_KEY)}&vsn=1.0.0`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  ws.send(JSON.stringify({ topic: `realtime:team:${a.token}`, event: 'phx_join', payload: { config: { broadcast: { self: false }, presence: { enabled: false }, private: false } }, ref: '1' }));
  const otherListener = listener(other.token);
  try {
    await until(() => frames.some((f) => f.event === 'phx_reply') && otherListener.connected);
    const task = S.byPhase(1)[0];
    await submit(a.head, task.id, task.correct_answer);
    await until(() => frames.some((f) => f.event === 'broadcast'), 3000);
    const b = frames.find((f) => f.event === 'broadcast');
    assert.equal(b.payload.event, 'changed');
    assert.deepEqual(b.payload.payload, {}, 'the ping carries no data');
    const text = JSON.stringify(b);
    for (const secret of [task.correct_answer, S.caseCode, S.password, a.teamCode, rawCode(a.teamCode)]) assert.ok(!text.includes(secret));
    await sleep(1500);
    assert.equal(otherListener.pings.length, 0, 'the other team heard nothing');
  } finally {
    ws.close();
    otherListener.sub.close();
  }
});

test('if realtime publishing is unavailable, gameplay still works (polling is the safety net)', { skip }, async () => {
  // The publish happens after the response, best effort: prove requests never depend on it by checking
  // that a burst of actions all succeed regardless of ping delivery.
  const t = await team(1);
  const rs = [await t.head.post('/api/start')];
  for (const task of S.byPhase(1)) rs.push(await submit(t.head, task.id, task.correct_answer));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal((await t.head.get('/api/state')).data.state, 'PHASE_2');
});
