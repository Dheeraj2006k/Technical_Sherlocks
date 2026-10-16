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
import { CATALOGUE_CODES, CANONICAL_TITLES, CANONICAL_VERSION } from './cases/pack.mjs';

// Same rule as lib/caseEligibility.ts: a published version that carries a content hash needs a human test for that exact hash.
const assignability = (r) => ({ ok: r.status === 'published' && !(r.hashed && !r.tested) });

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
  const a = new pg.Client({ connectionString: E.DATABASE_URL });
  a.on('error', () => {});
  try {
    await a.connect();
    await a.query('select 1');
    add(true, 'DATABASE_URL connects and answers a query');
    const mig = await a.query("select count(*)::int n from schema_migrations").catch(() => null);
    add(Boolean(mig) && mig.rows[0].n >= 12, 'all migrations are applied (12 or more)', 'run: npm run db:migrate (010 adds content versions, the lifecycle and the guided-tour state)');
    // Version-aware release checks (the legacy catalogue is intentionally still present until it is retired).
    const rows = (await a.query(`select c.id, c.case_code, c.title, c.content_version, c.status, (c.content_hash is not null) as hashed,
        (c.content_hash is not null and c.tested_hash = c.content_hash) as tested,
        (select count(*)::int from team_case_assignments x where x.case_id = c.id and x.status in ('assigned', 'started')) as open_assignments,
        (select count(*)::int from teams t left join team_progress tp on tp.team_id = t.id where t.case_id = c.id and coalesce(tp.state, 'WAITING') <> 'FINISHED') as live_teams
        from cases c`)).rows;
    const canon = rows.filter((r) => r.content_version === CANONICAL_VERSION && CATALOGUE_CODES.includes(r.case_code));
    add(CATALOGUE_CODES.every((c) => canon.filter((r) => r.case_code === c).length === 1) && canon.length === 12, `all twelve canonical v${CANONICAL_VERSION} cases exist exactly once (${canon.length} found)`, 'run: npm run db:seed');
    const badTitles = canon.filter((r) => r.title !== CANONICAL_TITLES[r.case_code]).map((r) => r.case_code);
    add(badTitles.length === 0, 'every canonical v2 title matches the supplied roster', badTitles.join(', '));
    const dupPublished = [...new Set(rows.filter((r) => r.status === 'published').map((r) => r.case_code))].filter((c) => rows.filter((r) => r.case_code === c && r.status === 'published').length > 1);
    add(dupPublished.length === 0, 'no case code has two published versions', dupPublished.join(', '));
    const ineligible = rows.filter((r) => r.status === 'published' && !assignability(r).ok).map((r) => `${r.case_code} v${r.content_version}`);
    add(ineligible.length === 0, 'every published (assignable) version is eligible: published pack versions carry a recorded human test', ineligible.join(', '));
    const badOpen = rows.filter((r) => r.open_assignments > 0 && r.status !== 'published').map((r) => `${r.case_code} v${r.content_version} (${r.status})`);
    add(badOpen.length === 0, 'every open assignment points at a published version, so no registration is stuck', badOpen.join(', '));
    const stray = rows.filter((r) => r.status === 'published' && !(CATALOGUE_CODES.includes(r.case_code) && r.content_version >= CANONICAL_VERSION));
    const protectedStray = stray.filter((r) => r.open_assignments > 0 || r.live_teams > 0);
    const loose = stray.filter((r) => !(r.open_assignments > 0 || r.live_teams > 0));
    for (const r of protectedStray) console.log(`  NOTE  protected legacy exception: ${r.case_code} v${r.content_version} stays published (${r.open_assignments} open assignment(s), ${r.live_teams} unfinished team(s))`);
    add(loose.length === 0, `no unprotected legacy version is still published or assignable (${protectedStray.length} protected exception(s) reported above)`, `${loose.length} left: run node scripts/retire-legacy-cases.mjs (dry run) then --apply`);
    add(rows.some((r) => r.status === 'published'), 'at least one case version is published', 'publish a tested version from Admin -> Cases');
    const sample = (await a.query("select c.id, c.slug, k.key, k.table_name as tbl from cases c join case_table_keys k on k.case_id = c.id where c.case_code ~ '^(SQL|LOG)0[1-6]$' and k.table_name = (select tables_unlocked[1] from case_phases where case_id = c.id and phase_number = 1) order by (c.status = 'published') desc, c.content_version desc limit 1")).rows[0];

    const p = new pg.Client({ connectionString: E.DATABASE_URL_PLAYER });
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
          await p.query("select set_config('app.keys', $1, true)", [sample.key]);
          const cur = p.query(new Cursor(`select count(*)::int from ${p.escapeIdentifier(sample.tbl)}`, [], { rowMode: 'array' }));
          const rows = await cur.read(5).catch(() => null);
          await cur.close().catch(() => {});
          await p.query('rollback');
          if (i === 1) add(Boolean(rows) && rows[0][0] > 0, 'player query path works end to end (cursor, SET LOCAL, RLS gate, repeated)', 'check DATABASE_URL_PLAYER and that the case is seeded');
        }
        await p.query('begin read only');
        const nokey = await p.query(`select count(*)::int n from ${p.escapeIdentifier('case_' + sample.slug)}.${p.escapeIdentifier(sample.tbl)}`);
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
