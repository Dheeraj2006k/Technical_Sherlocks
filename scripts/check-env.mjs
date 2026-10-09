// Preflight for the environment in .env.local (or the shell): catches the misconfigurations that only show up
// in production, WITHOUT printing any secret. Run it before the event:   npm run check:env
//
// It checks shapes (pooled vs direct, role, host match), then really connects with both URLs and replays the
// exact query sequence the app uses (read-only tx, SET LOCAL, extended-protocol cursor, RLS gate).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { loadEnvLocal } from './lib/env.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const E = process.env;
const results = [];
const add = (ok, label, hint = '') => results.push({ ok, label, hint });
const parse = (k) => {
  try {
    return new URL(E[k]);
  } catch {
    return null;
  }
};

for (const k of ['DATABASE_URL', 'DATABASE_URL_PLAYER', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'ADMIN_PASSWORD']) {
  add(Boolean(E[k]), `${k} is set`, 'set it in .env.local / Vercel');
}
add((E.SESSION_SECRET ?? '').length >= 32, 'SESSION_SECRET is at least 32 characters', 'use a long random value');
add((E.ADMIN_PASSWORD ?? '').length >= 10, 'ADMIN_PASSWORD is at least 10 characters');
add(Boolean(E.NEXT_PUBLIC_SUPABASE_URL && E.NEXT_PUBLIC_SUPABASE_ANON_KEY), 'realtime variables NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY are set', 'without them the UI polls every 3 s instead of going Live');
add(Boolean(E.JOIN_RATE_PER_MINUTE && E.JOIN_RATE_PER_HOUR), 'JOIN_RATE_PER_MINUTE / JOIN_RATE_PER_HOUR are set', 'defaults (10 and 30) will lock out a venue that shares one public IP');

const main = parse('DATABASE_URL');
const player = parse('DATABASE_URL_PLAYER');
const isPooler = (u) => u && /pooler\.supabase\.com$/.test(u.hostname);
if (main && player) {
  add(isPooler(main) && main.port === '6543', 'DATABASE_URL is the transaction-mode pooler (port 6543)', 'Vercel cannot reach the direct host; use the pooled URL');
  add(isPooler(player) && player.port === '6543', 'DATABASE_URL_PLAYER is the transaction-mode pooler (port 6543)', 'run: node scripts/setup-player-role.mjs --pooled, then copy it to Vercel');
  add(player.username.startsWith('player_exec'), 'DATABASE_URL_PLAYER logs in as player_exec (not postgres)', 'a privileged login would defeat the SQL sandbox');
  add(main.hostname === player.hostname, 'both URLs use the same host');
  add(!main.username.startsWith('player_exec'), 'DATABASE_URL is the application login, not player_exec');
}

async function live() {
  if (!main || !player) return;
  const a = new pg.Client({ connectionString: E.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  a.on('error', () => {});
  try {
    await a.connect();
    await a.query('select 1');
    add(true, 'DATABASE_URL connects and answers a query');
    const mig = await a.query("select count(*)::int n from schema_migrations").catch(() => null);
    add(Boolean(mig) && mig.rows[0].n >= 8, 'all migrations are applied (8 or more)', 'run: npm run db:migrate');
    const cases = (await a.query("select count(*)::int total, count(*) filter (where status = 'live')::int live from cases")).rows[0];
    add(cases.total >= 10, `cases installed (${cases.total} found, ${cases.live} live)`, 'run: node scripts/seed-cases.mjs');
    const sample = (await a.query("select c.id, c.slug, k.key from cases c join case_query_keys k on k.case_id = c.id and k.phase = 1 where c.slug <> 'stub' limit 1")).rows[0];

    const p = new pg.Client({ connectionString: E.DATABASE_URL_PLAYER, ssl: { rejectUnauthorized: false } });
    p.on('error', () => {});
    try {
      await p.connect();
      const me = (await p.query("select current_user, current_setting('statement_timeout') st, current_setting('default_transaction_read_only') ro")).rows[0];
      add(me.current_user === 'player_exec' && me.st === '3s' && me.ro === 'on', 'player connection is player_exec with a 3 s timeout, read-only');
      if (sample) {
        for (let i = 0; i < 2; i++) {
          await p.query('begin read only');
          await p.query("set local statement_timeout = '3000ms'");
          await p.query(`set local search_path = ${p.escapeIdentifier('case_' + sample.slug)}`);
          await p.query("select set_config('app.key', $1, true)", [sample.key]);
          const cur = p.query(new Cursor('select count(*)::int from cast_crew', [], { rowMode: 'array' }));
          const rows = await cur.read(5).catch(() => null);
          await cur.close().catch(() => {});
          await p.query('rollback');
          if (i === 1) add(Boolean(rows) && rows[0][0] > 0, 'player query path works end to end (cursor, SET LOCAL, RLS gate, repeated)', 'check DATABASE_URL_PLAYER and that the case is seeded');
        }
        await p.query('begin read only');
        const nokey = await p.query(`select count(*)::int n from ${p.escapeIdentifier('case_' + sample.slug)}.cast_crew`);
        await p.query('rollback');
        add(nokey.rows[0].n === 0, 'without the phase key the evidence tables return nothing (RLS gate holds)');
        let denied = false;
        try {
          await p.query('select * from public.tasks');
        } catch {
          denied = true;
        }
        add(denied, 'player_exec cannot read the answer table');
      } else {
        add(false, 'a seeded case exists to test the player path', 'run: node scripts/seed-cases.mjs');
      }
    } catch (e) {
      add(false, 'DATABASE_URL_PLAYER connects and runs the player query sequence', `${e.code ?? 'error'}: ${String(e.message).slice(0, 120)}`);
    } finally {
      await p.end().catch(() => {});
    }
  } catch (e) {
    add(false, 'DATABASE_URL connects', `${e.code ?? 'error'}: ${String(e.message).slice(0, 120)}`);
  } finally {
    await a.end().catch(() => {});
  }
}

await live();
let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${!r.ok && r.hint ? `\n       -> ${r.hint}` : ''}`);
  if (!r.ok) bad++;
}
console.log(bad ? `\n${bad} problem(s) found` : '\nenvironment looks good');
process.exit(bad ? 1 : 0);
