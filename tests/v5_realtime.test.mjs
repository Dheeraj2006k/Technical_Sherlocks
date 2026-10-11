// Realtime pings (Supabase Realtime). These need a real Supabase project (a local Postgres has no Realtime service), so
// they are SKIPPED in `npm test` and only run with `npm run test:remote` against a configured environment. The browser
// would subscribe with the anon key; here the same client code subscribes with the service key (same protocol).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeTeamChannel } from '../lib/realtime-client.mjs';
import { db, makeGame, defByCode, makeTeam, submit, answerValue, Client, rawCode } from './helpers.mjs';

const pool = db();
let G;

const host = new URL(process.env.DATABASE_URL).hostname;
const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1];
const RT_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || (ref ? `https://${ref}.supabase.co` : null);
const RT_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const skip = !RT_URL || !RT_KEY ? 'realtime is not configured in this environment (local Postgres has no Realtime service)' : false;

before(async () => {
  G = await makeGame(pool, defByCode('SQL01'));
});
after(async () => {
  await G.cleanup();
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
  const t = await makeTeam(G, n);
  const token = (await t.head.get('/api/state')).data.realtime_channel;
  return { ...t, token, all: [t.head, ...t.inv] };
}

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
  const lb = JSON.stringify((await new Client().get('/api/leaderboard?track=SQL')).data);
  assert.ok(!lb.includes(a.token) && !lb.includes(b.token));
});

test('a teammate answers a question: the others are pinged within ~1s and refetch the right state', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const [b, c] = [listener(t.token), listener(t.token)];
  try {
    await until(() => b.connected && c.connected);
    const task = G.tasks[0];
    const sentAt = Date.now();
    assert.equal((await submit(t.head, task.id, answerValue(task))).data.correct, true);
    await until(() => b.pings.length > 0 && c.pings.length > 0, 3000);
    assert.ok(b.pings[0] - sentAt < 1500 && c.pings[0] - sentAt < 1500, 'within ~1s');
    for (const cl of t.inv) {
      const st = (await cl.get('/api/state')).data;
      assert.equal(st.threads.flatMap((x) => x.questions).find((x) => x.id === task.id).completed, true);
    }
  } finally {
    b.sub.close();
    c.sub.close();
  }
});

test('hints, thread completion and the phase change all ping every teammate', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const ls = [listener(t.token), listener(t.token), listener(t.token)];
  try {
    await until(() => ls.every((l) => l.connected));
    const before = ls.map((l) => l.pings.length);
    assert.equal((await t.head.post('/api/hint', { task_id: G.tasks[0].id })).status, 200);
    await until(() => ls.every((l, i) => l.pings.length > before[i]), 3000);
    for (const task of G.tasksIn('t1a')) await submit(t.inv[0], task.id, answerValue(task));
    await until(() => ls.every((l, i) => l.pings.length >= before[i] + 3), 3000);
    const states = await Promise.all(t.all.map(async (c) => (await c.get('/api/state')).data));
    assert.ok(states.every((s) => s.state === 'PHASE_2'));
    assert.equal(new Set(states.map((s) => JSON.stringify(s.narrative))).size, 1, 'same narrative for everyone');
  } finally {
    ls.forEach((l) => l.sub.close());
  }
});

test('socket killed mid-game: the client reconnects by itself and the state is correct, not stale or duplicated', { skip }, async () => {
  const t = await team(2);
  await t.head.post('/api/start');
  const mirror = { done: new Set(), refetches: 0, state: null };
  const refetch = async () => {
    mirror.refetches++;
    const st = (await t.inv[0].get('/api/state')).data;
    mirror.done = new Set(st.threads.flatMap((x) => x.questions).filter((x) => x.completed).map((x) => x.id));
    mirror.state = st.state;
  };
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
    await until(() => connects >= 1);
    const [q1, q2] = G.tasksIn('t1a');
    await submit(t.head, q1.id, answerValue(q1));
    await until(() => mirror.done.has(q1.id));
    app._drop();
    await submit(t.head, q2.id, answerValue(q2)); // the dropped client misses this ping
    await until(() => connects >= 2 && mirror.state === 'PHASE_2', 12000);
    const id = (await pool.query('select id from teams where team_code = $1', [rawCode(t.teamCode)])).rows[0].id;
    assert.equal((await pool.query('select count(*)::int n from team_task_completions where team_id = $1', [id])).rows[0].n, 2);
    assert.equal((await t.head.get('/api/state')).data.scores.total_pts, 20);
  } finally {
    app.close();
  }
});

test('pings carry no data, and another team is never pinged', { skip }, async () => {
  const a = await team(1);
  const other = await team(1);
  await a.head.post('/api/start');
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
    const task = G.tasks[0];
    await submit(a.head, task.id, answerValue(task));
    await until(() => frames.some((f) => f.event === 'broadcast'), 3000);
    const b = frames.find((f) => f.event === 'broadcast');
    assert.deepEqual(b.payload.payload, {}, 'the ping carries no data');
    const text = JSON.stringify(b);
    for (const secret of [task.correct_answer, G.caseCode, G.password, a.teamCode, rawCode(a.teamCode)]) assert.ok(!text.includes(secret));
    await sleep(1500);
    assert.equal(otherListener.pings.length, 0, 'the other team heard nothing');
  } finally {
    ws.close();
    otherListener.sub.close();
  }
});
