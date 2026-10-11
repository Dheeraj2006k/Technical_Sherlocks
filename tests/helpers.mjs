import { randomUUID, randomInt } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnvLocal } from '../scripts/lib/env.mjs';
import { installCase, removeCaseFully } from '../scripts/cases/engine.mjs';
import { CODE_ALPHABET } from '../scripts/lib/codes.mjs';
import { DEFINITIONS } from '../scripts/cases/index.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

export const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3101';

// The generated catalogue (SQL01-SQL10, LOG01-LOG10); tests install throwaway copies of these.
export const CATALOGUE = DEFINITIONS;
export const defByCode = (code) => DEFINITIONS.find((d) => d.code === code);

export function db() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

const record = (...parts) => {
  // Throwaway credentials are handed to tests/run.mjs, which asserts none of them ever appear in the server log.
  if (process.env.TEST_SECRETS_FILE) appendFileSync(process.env.TEST_SECRETS_FILE, parts.join('\n') + '\n');
};

const randomRef = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

// A throwaway published copy of a case definition: random slug, a TST-prefixed case code and a known password.
export async function makeGame(pool, def, { status = 'published', caseCode } = {}) {
  const password = `pw-${randomUUID().slice(0, 8)}`;
  const slug = `x${randomUUID().replace(/-/g, '').slice(0, 11)}`;
  const code = caseCode ?? `TST${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;
  const c = await pool.connect();
  let info;
  try {
    info = await installCase(c, def, { slug, password, status, caseCode: code, bcryptCost: 4, title: `TEST ${def.title}` });
  } finally {
    c.release();
  }
  record(info.caseCode, info.password, info.caseId);
  const registrations = [];
  const game = {
    ...info,
    def,
    track: def.track,
    registrations,
    tasksIn: (threadKey) => info.tasks.filter((t) => t.thread === threadKey),
    // a registered, assigned team ready for its head to join
    async register({ teamRef = `Team ${randomUUID().slice(0, 6)}`, size = 3, assign = true } = {}) {
      const ref = randomRef();
      const r = await pool.query('insert into registrations (registration_ref, team_ref, team_size) values ($1, $2, $3) returning id', [ref, teamRef, size]);
      if (assign) {
        await pool.query("insert into team_case_assignments (registration_id, case_id, assigned_by) values ($1, $2, 'test')", [r.rows[0].id, info.caseId]);
      }
      registrations.push(r.rows[0].id);
      record(ref);
      return { id: r.rows[0].id, ref, teamRef, size };
    },
    async cleanup() {
      const cc = await pool.connect();
      try {
        await removeCaseFully(cc, info.caseId);
        if (registrations.length) await cc.query('delete from registrations where id = any($1)', [registrations]);
      } finally {
        cc.release();
      }
    },
  };
  return game;
}

// Raw 6-char team code from the displayed XXX-XXX form.
export const rawCode = (display) => display.replace(/-/g, '');

export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

// Every response body is kept so tests can assert that secrets never appear in any of them.
export const allResponses = [];

// Minimal HTTP client with a cookie jar for the session cookie. Each client gets its own x-forwarded-for IP so the
// per-IP join rate limit doesn't couple unrelated tests.
export class Client {
  cookie = null;
  cookieName = 'slc_session';
  ip = randomIp();

  async req(method, path, body, { rawCookie, headers: extra } = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': this.ip, ...extra };
    const ck = rawCookie ?? this.cookie;
    if (ck) headers.Cookie = ck;
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.getSetCookie().find((c) => c.startsWith(`${this.cookieName}=`));
    if (set) this.cookie = set.split(';')[0];
    const text = await r.text();
    allResponses.push({ path, status: r.status, text, setCookie: set });
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data, text, setCookie: set, headers: r.headers };
  }

  post(path, body, opts) {
    return this.req('POST', path, body ?? {}, opts);
  }
  get(path, opts) {
    return this.req('GET', path, undefined, opts);
  }

  headJoin(game, reg, name = 'Head', extra = {}) {
    return this.post('/api/join', {
      registration_ref: reg.ref,
      case_code: game.caseCode,
      case_password: game.password,
      display_name: name,
      idempotency_key: randomUUID(),
      ...extra,
    });
  }

  joinTeam(teamCode, name) {
    return this.post('/api/join', { team_code: teamCode, display_name: name });
  }
}

// Registered + assigned team: head and n investigators joined. Returns clients, team code and the registration.
export async function makeTeam(game, investigators = 0, { size = 3 } = {}) {
  const reg = await game.register({ size });
  const head = new Client();
  const r = await head.headJoin(game, reg);
  if (r.status !== 200) throw new Error(`head join failed: ${r.status} ${r.text}`);
  const teamCode = r.data.team.team_code;
  const inv = [];
  for (let i = 0; i < investigators; i++) {
    const cl = new Client();
    const jr = await cl.joinTeam(teamCode, `Inv${i + 1}`);
    if (jr.status !== 200) throw new Error(`investigator join failed: ${jr.status} ${jr.text}`);
    inv.push(cl);
  }
  return { head, inv, teamCode, reg };
}

export async function startedTeam(game, investigators = 0) {
  const t = await makeTeam(game, investigators);
  const s = await t.head.post('/api/start');
  if (s.status !== 200) throw new Error(`start failed: ${s.status} ${s.text}`);
  return t;
}

export const submit = (client, taskId, value, key = randomUUID()) => client.post('/api/submit-task', { task_id: taskId, value, idempotency_key: key });
export const hint = (client, taskId) => client.post('/api/hint', { task_id: taskId });
export const final = (client, component, value, key = randomUUID()) => client.post('/api/submit-final', { component, value, idempotency_key: key });
export const query = (client, sql) => client.post('/api/query', { sql });
export const evidence = (client, body) => client.post('/api/evidence', body ?? {});

// The value a player would type for an installed task (character answers are submitted by character id).
export const answerValue = (task) => (task.answer_type === 'SINGLE_CHARACTER' ? task.correct_answer : task.answer_text);

// Answers every question of the case in thread order using the true answers, as one player. Returns the responses.
export async function solveAll(client, game, { only } = {}) {
  const out = [];
  for (const task of game.tasks) {
    if (only && !only(task)) continue;
    out.push(await submit(client, task.id, answerValue(task)));
  }
  return out;
}

// Solves exactly the questions of one phase (all threads).
export const solvePhase = (client, game, phase) => solveAll(client, game, { only: (t) => t.phase === phase });

// Both parts of the final deduction.
export async function finishFinal(client, game) {
  const a = await final(client, 'culprit', game.culpritId);
  const correctOption = game.options.find((o) => o.correct);
  const b = await final(client, 'mechanism', correctOption.id);
  return [a, b];
}

// Organizer client: signs in with ADMIN_PASSWORD (read from the env file into this process only).
export class AdminClient extends Client {
  cookieName = 'slc_admin';
  async login(password = process.env.ADMIN_PASSWORD) {
    return this.post('/api/admin/login', { password });
  }
}

export const flattenQuestions = (state) => state.threads.flatMap((t) => t.questions);
