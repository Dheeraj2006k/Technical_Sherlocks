import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describeDatabase } from '../scripts/lib/env.mjs';
import { insertStubCase } from '../scripts/lib/stub-case.mjs';
import { installCase, verifyDefinition } from '../scripts/cases/engine.mjs';
import { FIXTURES } from './helpers.mjs';

// Upgrade path: a database that already holds v4 data (migrations 001-008, a live case, a team mid-game) takes migration
// 009 in place without losing anything. Runs only against the LOCAL database, in a throwaway database of its own.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = describeDatabase(process.env.DATABASE_URL).local;
const name = `slc_up_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const withDb = (url, dbname) => {
  const u = new URL(url);
  u.pathname = `/${dbname}`;
  return u.toString();
};
const scratchUrl = local ? withDb(process.env.DATABASE_URL, name) : '';

const migrate = (args = []) => spawnSync('node', ['scripts/migrate.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DATABASE_URL: scratchUrl, PGSSLMODE: 'disable' } });

after(async () => {
  if (!local) return;
  const admin = new pg.Client({ connectionString: withDb(process.env.DATABASE_URL, 'postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
});

test('a populated v4 database upgrades in place to v5: nothing is lost, the new engine works beside the old data', { skip: !local && 'only runs against the local database' }, async () => {
  const admin = new pg.Client({ connectionString: withDb(process.env.DATABASE_URL, 'postgres') });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  // 1. the v4 schema (migrations 001-008)
  const v4 = migrate(['--upto', '008']);
  assert.equal(v4.status, 0, v4.stdout + v4.stderr);
  assert.ok(!v4.stdout.includes('009'));

  // 2. v4 data: a live case, a team mid-game with a solved task and a culprit submission
  const c = new pg.Client({ connectionString: scratchUrl });
  await c.connect();
  const old = await insertStubCase(c, { password: 'old-pass', status: 'live', title: 'Legacy v4 case' });
  const teamId = randomUUID();
  const playerId = randomUUID();
  await c.query("insert into teams (id, case_id, team_code, team_name) values ($1, $2, 'ABC234', 'Legacy Team')", [teamId, old.caseId]);
  await c.query("insert into players (id, team_id, display_name, role) values ($1, $2, 'Legacy Head', 'head')", [playerId, teamId]);
  await c.query("insert into team_progress (team_id, state, current_phase) values ($1, 'PHASE_2', 2)", [teamId]);
  await c.query('insert into team_scores (team_id, phase1_pts, total_pts) values ($1, 20, 20)', [teamId]);
  await c.query('insert into task_submissions (task_id, team_id, player_id, submitted_value, is_correct) values ($1, $2, $3, $4, true)', [old.tasks[0].id, teamId, playerId, 'x']);
  const before = {};
  for (const t of ['cases', 'case_phases', 'tasks', 'characters', 'teams', 'players', 'team_progress', 'team_scores', 'task_submissions']) {
    before[t] = (await c.query(`select count(*)::int n from ${t}`)).rows[0].n;
  }
  await c.end();

  // 3. migration 009
  const up = migrate();
  assert.equal(up.status, 0, up.stdout + up.stderr);
  assert.match(up.stdout, /apply\s+009_v5_engine\.sql/);
  const again = migrate();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /skip\s+009_v5_engine\.sql/, 'idempotent: a second run applies nothing');

  const after = new pg.Client({ connectionString: scratchUrl });
  await after.connect();
  try {
    for (const [t, n] of Object.entries(before)) assert.equal((await after.query(`select count(*)::int n from ${t}`)).rows[0].n, n, `${t} rows preserved`);
    const legacy = (await after.query('select status, game_track, final_points_culprit, final_points_mechanism, case_code from cases where id = $1', [old.caseId])).rows[0];
    assert.equal(legacy.status, 'published', "'live' became 'published'");
    assert.equal(legacy.game_track, 'SQL');
    assert.equal(legacy.final_points_culprit + legacy.final_points_mechanism, 20);
    assert.ok(/^[A-Z0-9][A-Z0-9-]{2,15}$/.test(legacy.case_code), 'the old random code satisfies the new format');
    assert.equal((await after.query('select state, current_phase from team_progress where team_id = $1', [teamId])).rows[0].state, 'PHASE_2');
    assert.equal((await after.query('select count(*)::int n from task_submissions')).rows[0].n, 1, 'v4 history is kept');

    // the new engine's tables exist and every public table is RLS-protected
    for (const t of ['registrations', 'team_case_assignments', 'investigation_threads', 'thread_evidence_tables', 'task_hints', 'team_hint_usage', 'task_attempts', 'team_task_completions', 'final_options', 'final_attempts', 'team_final_completions', 'story_events', 'admin_audit', 'case_table_keys']) {
      assert.equal((await after.query('select to_regclass($1) as r', [`public.${t}`])).rows[0].r, t, t);
    }
    assert.deepEqual((await after.query("select tablename from pg_tables where schemaname = 'public' and not rowsecurity")).rows, []);

    // a v5 catalogue case installs and validates beside the legacy data
    await after.query('begin');
    const def = FIXTURES.find((d) => d.code === 'LOG02');
    const installed = await installCase(after, def, { slug: 'upgrade_check', password: 'x', bcryptCost: 4 });
    const bad = (await verifyDefinition(after, def, installed)).filter((r) => !r.ok);
    assert.deepEqual(bad, []);
    await after.query('commit');
    // a legacy team has no thread progress and the v5 state query still works for it (new rows simply start empty)
    assert.equal((await after.query('select count(*)::int n from team_thread_progress where team_id = $1', [teamId])).rows[0].n, 0);
  } finally {
    await after.end();
  }
});
