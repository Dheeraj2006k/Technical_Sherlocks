import { randomUUID, randomInt } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnvLocal } from '../scripts/lib/env.mjs';
import { insertStubCase, deleteCase } from '../scripts/lib/stub-case.mjs';
import { installOpeningNight, removeCaseFully } from '../scripts/cases/opening-night.mjs';
import { installCase } from '../scripts/cases/engine.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

export const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3101';

export function db() {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    ssl: { rejectUnauthorized: false },
  });
}

// Creates a throwaway case (random ids) and returns a cleanup function.
export async function makeCase(pool, { status = 'live', bcryptCost = 4, caseCode } = {}) {
  const tag = `_${randomUUID().slice(0, 8)}`;
  const password = `pw-${randomUUID().slice(0, 8)}`;
  const c = await pool.connect();
  let info;
  try {
    info = await insertStubCase(c, { password, title: `TEST ${tag}`, tag, bcryptCost, status, caseCode });
  } finally {
    c.release();
  }
  // Throwaway test credentials are handed to tests/run.mjs, which asserts none of them ever
  // appear in the server log. (Random per run, belong to a case that is deleted afterwards.)
  if (process.env.TEST_SECRETS_FILE) {
    appendFileSync(process.env.TEST_SECRETS_FILE, [info.caseCode, info.password, info.caseId].join('\n') + '\n');
  }
  return {
    ...info,
    tag,
    byPhase: (p) => info.tasks.filter((t) => t.phase === p),
    cleanup: async () => {
      const cc = await pool.connect();
      try {
        await deleteCase(cc, info.caseId);
      } finally {
        cc.release();
      }
    },
  };
}

// Raw 6-char team code from the displayed XXX-XXX form.
export const rawCode = (display) => display.replace(/-/g, '');

export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

// Every response body is kept so tests can assert that secrets never appear in any of them.
export const allResponses = [];

// Minimal HTTP client with a cookie jar for the session cookie. Each client gets its own
// x-forwarded-for IP so the per-IP join rate limit doesn't couple unrelated tests.
export class Client {
  cookie = null;
  cookieName = 'slc_session';
  ip = randomIp();

  async req(method, path, body, { rawCookie, headers: extra } = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-forwarded-for': this.ip, ...extra };
    const ck = rawCookie ?? this.cookie;
    if (ck) headers.Cookie = ck;
    const r = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie().find((c) => c.startsWith(`${this.cookieName}=`));
    if (set) this.cookie = set.split(';')[0];
    const text = await r.text();
    allResponses.push({ path, status: r.status, text, setCookie: set });
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data, text, setCookie: set };
  }

  post(path, body, opts) {
    return this.req('POST', path, body ?? {}, opts);
  }
  get(path, opts) {
    return this.req('GET', path, undefined, opts);
  }

  async headJoin(c, name = 'Head') {
    const r = await this.post('/api/join', {
      case_code: c.caseCode,
      case_password: c.password,
      display_name: name,
      idempotency_key: randomUUID(),
    });
    return r;
  }

  joinTeam(teamCode, name) {
    return this.post('/api/join', { team_code: teamCode, display_name: name });
  }
}

// Head + n investigators on a fresh team. Returns clients and team code.
export async function makeTeam(c, investigators = 0) {
  const head = new Client();
  const r = await head.headJoin(c);
  if (r.status !== 200) throw new Error(`head join failed: ${r.status} ${r.text}`);
  const teamCode = r.data.team.team_code;
  const inv = [];
  for (let i = 0; i < investigators; i++) {
    const cl = new Client();
    const jr = await cl.joinTeam(teamCode, `Inv${i + 1}`);
    if (jr.status !== 200) throw new Error(`investigator join failed: ${jr.status} ${jr.text}`);
    inv.push(cl);
  }
  return { head, inv, teamCode };
}

export const submit = (client, taskId, value) => client.post('/api/submit-task', { task_id: taskId, value });

// A throwaway copy of the real Opening Night case (own random slug/schema, known password).
export async function makeRealCase(pool, { status = 'live' } = {}) {
  const password = `pw-${randomUUID().slice(0, 8)}`;
  const slug = `on${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const c = await pool.connect();
  let info;
  try {
    info = await installOpeningNight(c, { slug, password, status, bcryptCost: 4, title: `TEST ${slug}` });
  } finally {
    c.release();
  }
  if (process.env.TEST_SECRETS_FILE) {
    appendFileSync(process.env.TEST_SECRETS_FILE, [info.caseCode, info.password, info.caseId].join('\n') + '\n');
  }
  return {
    ...info,
    byPhase: (p) => info.tasks.filter((t) => t.phase === p),
    cleanup: async () => {
      const cc = await pool.connect();
      try {
        await removeCaseFully(cc, info.caseId);
      } finally {
        cc.release();
      }
    },
  };
}

export const query = (client, sql) => client.post('/api/query', { sql });

// Solves a phase through the real console: runs each task's reference SQL via /api/query as the team,
// maps the result to the right answer value, and submits it. Returns the submit responses.
export async function solvePhase(client, realCase, phase, roster) {
  const out = [];
  for (const task of realCase.byPhase(phase)) {
    const q = await query(client, task.sql);
    if (!q.data?.ok) throw new Error(`reference query failed for ${task.answer_type}: ${q.text}`);
    let value = String(q.data.rows[0][0]);
    if (task.answer_type === 'SINGLE_CHARACTER') value = roster.find((c) => c.name === value).id;
    out.push(await submit(client, task.id, value));
  }
  return out;
}

// Organizer client: signs in with ADMIN_PASSWORD (read from .env.local into this process only).
export class AdminClient extends Client {
  cookieName = 'slc_admin';
  async login(password = process.env.ADMIN_PASSWORD) {
    return this.post('/api/admin/login', { password });
  }
}

// A throwaway live copy of any case definition (random slug, known password), same shape as makeRealCase.
export async function makeCaseFromDefinition(pool, def, { status = 'live' } = {}) {
  const password = `pw-${randomUUID().slice(0, 8)}`;
  const slug = `x${randomUUID().replace(/-/g, '').slice(0, 11)}`;
  const c = await pool.connect();
  let info;
  try {
    info = await installCase(c, def, { slug, password, status, bcryptCost: 4, title: `TEST ${def.title}` });
  } finally {
    c.release();
  }
  if (process.env.TEST_SECRETS_FILE) {
    appendFileSync(process.env.TEST_SECRETS_FILE, [info.caseCode, info.password, info.caseId].join('\n') + '\n');
  }
  return {
    ...info,
    def,
    byPhase: (p) => info.tasks.filter((t) => t.phase === p),
    cleanup: async () => {
      const cc = await pool.connect();
      try {
        await removeCaseFully(cc, info.caseId);
      } finally {
        cc.release();
      }
    },
  };
}
