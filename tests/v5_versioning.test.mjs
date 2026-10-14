// Case versions, the publication lifecycle, version pinning and the seeding guarantees (PRD Addendum 1, sections 2, 5, 6, 7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { db, makeGame, defByCode, Client, AdminClient, makeTeam, startedTeam, submit, answerValue, rawCode } from './helpers.mjs';
import { PACKS } from '../scripts/cases/index.mjs';
import { applySeed, planSeed } from '../scripts/lib/seeder.mjs';
import { removeCaseFully, installCase } from '../scripts/cases/engine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pool = db();
const admin = new AdminClient();
const HASH = 'a'.repeat(64);
const hashOf = (n) => n.toString(16).padStart(64, '0');
const cleanups = [];
before(async () => {
  assert.equal((await admin.login()).status, 200);
});
after(async () => {
  for (const f of cleanups.reverse()) await f().catch(() => {});
  await pool.end();
});

const nodeScript = (args) => spawnSync('node', args, { cwd: root, encoding: 'utf8', env: { ...process.env, SLC_ENV_FILE: '.env.localdb', PGSSLMODE: 'disable' } });
const status = async (id) => (await pool.query('select status from cases where id = $1', [id])).rows[0].status;
const transition = (id, to, record = {}) => pool.query('select transition_case_status($1, $2, $3, $4::jsonb)', [id, to, 'test', JSON.stringify(record)]);

// a pack-managed (hash-carrying) case version
async function managed(code, version, { status = 'draft', hash = hashOf(version), def = defByCode('SQL01') } = {}) {
  const slug = `v${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const c = await pool.connect();
  let info;
  try {
    info = await installCase(c, def, { slug, caseCode: code, version, status, contentHash: hash, bcryptCost: 4, password: `pw-${code}-${version}`, title: `V${version} ${def.title}` });
  } finally {
    c.release();
  }
  cleanups.push(async () => {
    const cc = await pool.connect();
    try {
      await removeCaseFully(cc, info.caseId);
    } finally {
      cc.release();
    }
  });
  return { ...info, hash };
}

test('migration 010 is applied: versions are unique per code, one version can be published per code, and the lifecycle has five states', async () => {
  const idx = (await pool.query("select indexname from pg_indexes where tablename = 'cases'")).rows.map((r) => r.indexname);
  assert.ok(idx.includes('cases_one_published_per_code'));
  assert.ok((await pool.query("select 1 from pg_constraint where conname = 'cases_code_version_key'")).rowCount === 1);
  assert.ok((await pool.query("select 1 from pg_constraint where conname = 'cases_case_code_key'")).rowCount === 0, 'the old unique(case_code) is gone');
  const def = (await pool.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'cases_status_check'")).rows[0].d;
  for (const s of ['draft', 'review', 'tested', 'published', 'disabled']) assert.ok(def.includes(s), s);
  const m = (await pool.query("select name from schema_migrations where name like '010%'")).rows;
  assert.equal(m.length, 1);
});

test('content that a live team is pinned to is frozen: no edit of its questions, hints, threads, unlocks, options, story, roster or case row', async () => {
  const g = await makeGame(pool, defByCode('SQL03'));
  cleanups.push(() => g.cleanup());
  const t = await startedTeam(g, 0);
  const id = g.caseId;
  const frozen = [
    ['update tasks set prompt_text = \'x\' where case_id = $1', 'tasks'],
    ['update task_hints set hint_text = \'x\' where task_id in (select id from tasks where case_id = $1)', 'task_hints'],
    ['delete from tasks where case_id = $1', 'tasks'],
    ['update investigation_threads set title = \'x\' where case_id = $1', 'investigation_threads'],
    ['update thread_evidence_tables set unlock_condition = \'complete\' where thread_id in (select id from investigation_threads where case_id = $1)', 'thread_evidence_tables'],
    ['update final_options set label = \'x\' where case_id = $1', 'final_options'],
    ['update case_phases set clue_text = \'x\' where case_id = $1', 'case_phases'],
    ['update characters set name = \'x\' where case_id = $1', 'characters'],
    ['update story_events set body = \'x\' where case_id = $1', 'story_events'],
    ['update cases set title = \'x\' where id = $1', 'live teams'],
    ['update cases set solution_motive = \'x\' where id = $1', 'live teams'],
    ['update cases set final_points_culprit = 99 where id = $1', 'live teams'],
  ];
  for (const [sql, what] of frozen) await assert.rejects(pool.query(sql, [id]), /pinned by live teams/, `${what}: ${sql}`);
  await assert.rejects(pool.query("insert into final_options (case_id, component, position, label, is_correct) values ($1, 'mechanism', 99, 'a new option', false)", [id]), /pinned by live teams/);
  // operational columns stay editable: status and the password hash are not content
  await pool.query("update cases set password_hash = password_hash where id = $1", [id]);
  await pool.query("update cases set status = 'disabled' where id = $1", [id]);
  assert.equal(await status(id), 'disabled');
  // and the team is untouched
  const st = (await t.head.get('/api/state')).data;
  assert.equal(st.state, 'PHASE_1');
});

test('a team records the content version it started on and can never be moved to another case once started', async () => {
  const a = await makeGame(pool, defByCode('SQL03'));
  const b = await makeGame(pool, defByCode('SQL04'));
  cleanups.push(() => a.cleanup(), () => b.cleanup());
  const t = await makeTeam(a, 0); // joined, still in the lobby
  const team = (await pool.query('select id, pinned_case_code, pinned_content_version from teams where team_code = $1', [rawCode(t.teamCode)])).rows[0];
  assert.equal(team.pinned_case_code, a.caseCode);
  assert.equal(team.pinned_content_version, (await pool.query('select content_version from cases where case_code = $1 order by content_version desc limit 1', [a.caseCode])).rows[0].content_version);
  // in the lobby the organizer may reassign (the assign route does exactly this) ...
  await pool.query('update teams set case_id = $2 where id = $1', [team.id, b.caseId]);
  assert.equal((await pool.query('select pinned_case_code from teams where id = $1', [team.id])).rows[0].pinned_case_code, b.caseCode, 'the pin follows an allowed reassignment');
  await pool.query('update teams set case_id = $2 where id = $1', [team.id, a.caseId]);
  // ... but once started the version is fixed
  assert.equal((await t.head.post('/api/start')).status, 200);
  await assert.rejects(pool.query('update teams set case_id = $2 where id = $1', [team.id, b.caseId]), /pinned to its content version/);
});

test('publishing a new content version never disturbs a live team: it keeps its questions, its answers and its ability to rejoin', async () => {
  const code = `TV${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const v2 = await makeGame(pool, defByCode('SQL04'), { caseCode: code, status: 'published', contentHash: hashOf(1) });
  cleanups.push(() => v2.cleanup());
  await pool.query('update cases set validated_hash = content_hash, tested_hash = content_hash where id = $1', [v2.caseId]);
  const live = await startedTeam(v2, 1);
  const q = v2.tasks[0];
  assert.equal((await submit(live.head, q.id, answerValue(q))).status, 200);

  // v3: the same code, new content (different title and evidence), validated and tested, then published
  const def3 = structuredClone(defByCode('SQL04'));
  def3.title = `${def3.title}, revised`;
  const v3 = await managed(code, 3, { status: 'draft', hash: hashOf(3), def: def3 });
  await pool.query('update cases set validated_hash = content_hash where id = $1', [v3.caseId]);
  await transition(v3.caseId, 'review');
  await transition(v3.caseId, 'tested', { reviewer: 'Test Reviewer', blind_playtest: 'completed' });
  await transition(v3.caseId, 'published');

  assert.equal(await status(v3.caseId), 'published');
  assert.equal(await status(v2.caseId), 'disabled', 'the previous version stops taking NEW assignments');
  // the live team: same content, can still answer, and everyone can rejoin
  const st = (await live.head.get('/api/state')).data;
  assert.equal(st.case.title, (await pool.query('select title from cases where id = $1', [v2.caseId])).rows[0].title);
  assert.ok(!st.case.title.includes('revised'));
  const second = v2.tasks[1];
  const r = await submit(live.head, second.id, answerValue(second));
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, true);
  const rejoin = await new Client().headJoin(v2, live.reg, 'Head');
  assert.equal(rejoin.status, 200, 'the head rejoins a team pinned to a now-disabled version');
  assert.equal(rejoin.data.replay, true);
  const member = await new Client().joinTeam(live.teamCode, 'Inv1');
  assert.equal(member.status, 200, 'an investigator rejoins too');

  // a registration still unstarted on the disabled version cannot start a NEW team on it
  const waiting = await v2.register({ size: 2 });
  assert.equal((await new Client().headJoin(v2, waiting)).status, 401);
  // new assignments go to the newly published version
  const reg = (await admin.post('/api/admin/registrations', { registrations: [{ team_ref: `Versions ${randomUUID().slice(0, 5)}`, team_size: 2 }] })).data.registrations[0];
  const regRow = { id: reg.id };
  cleanups.push(() => pool.query('delete from registrations where id = $1', [regRow.id]));
  const as = await admin.post('/api/admin/assign-case', { registration_id: regRow.id, case_code: code });
  assert.equal(as.status, 200);
  assert.equal((await pool.query('select case_id from team_case_assignments where registration_id = $1', [regRow.id])).rows[0].case_id, v3.caseId);
  const audit = (await pool.query("select details from admin_audit where registration_id = $1 and action = 'case_assigned'", [regRow.id])).rows[0];
  assert.equal(audit.details.content_version, 3, 'the audit entry records the exact version');
});

test('the lifecycle only moves along its gates: draft, review, tested, published; disabled stops new assignments', async () => {
  const code = `LC${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const c = await managed(code, 5, { status: 'draft', hash: hashOf(5) });
  // cannot skip a gate
  await assert.rejects(transition(c.caseId, 'published'), /illegal case status transition/);
  await assert.rejects(transition(c.caseId, 'tested'), /illegal case status transition/);
  // review needs the automated gate to have passed for THIS content hash
  await assert.rejects(transition(c.caseId, 'review'), /automated validation has not passed/);
  await pool.query('update cases set validated_hash = $2 where id = $1', [c.caseId, hashOf(999)]);
  await assert.rejects(transition(c.caseId, 'review'), /automated validation has not passed/, 'a validation of other content does not count');
  await pool.query('update cases set validated_hash = content_hash where id = $1', [c.caseId]);
  await transition(c.caseId, 'review');
  // tested needs a named human reviewer and a completed blind playtest
  await assert.rejects(transition(c.caseId, 'tested'), /named human reviewer and a completed blind playtest/);
  await assert.rejects(transition(c.caseId, 'tested', { reviewer: 'Someone' }), /blind playtest/);
  await assert.rejects(transition(c.caseId, 'tested', { blind_playtest: 'completed' }), /named human reviewer/);
  await assert.rejects(transition(c.caseId, 'published'), /illegal case status transition/);
  await transition(c.caseId, 'tested', { reviewer: 'Test Reviewer', blind_playtest: 'completed', playtest_participants: 3 });
  const row = (await pool.query('select tested_hash, content_hash, review_record from cases where id = $1', [c.caseId])).rows[0];
  assert.equal(row.tested_hash, row.content_hash);
  assert.equal(row.review_record.reviewer, 'Test Reviewer');
  // published needs the SAME hash to be validated and tested
  await pool.query('update cases set tested_hash = $2 where id = $1', [c.caseId, hashOf(998)]);
  await assert.rejects(transition(c.caseId, 'published'), /exact version that was validated and tested/);
  await pool.query('update cases set tested_hash = content_hash where id = $1', [c.caseId]);
  await transition(c.caseId, 'published');
  assert.equal(await status(c.caseId), 'published');
  assert.ok((await pool.query('select published_at from cases where id = $1', [c.caseId])).rows[0].published_at);
  await assert.rejects(transition(c.caseId, 'draft'), /illegal case status transition/);
  await assert.rejects(transition(c.caseId, 'review'), /illegal case status transition/);
  await transition(c.caseId, 'disabled');
  await transition(c.caseId, 'review'); // a disabled version can be sent back for review, never straight to published
  await assert.rejects(transition(c.caseId, 'published'), /illegal case status transition/);
  // two published versions of one code cannot coexist
  const other = await managed(code, 6, { status: 'published', hash: hashOf(6) });
  await assert.rejects(pool.query("update cases set status = 'published' where id = $1", [c.caseId]), /cases_one_published_per_code/);
  void other;
  const log = (await pool.query("select details from admin_audit where case_id = $1 and action = 'case_status_changed' order by id", [c.caseId])).rows.map((r) => `${r.details.from}>${r.details.to}`);
  assert.deepEqual(log, ['draft>review', 'review>tested', 'tested>published', 'published>disabled', 'disabled>review']);
});

test('the organizer can publish only a tested version and disable any version, through the admin API, with an audit trail', async () => {
  const code = `AD${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const c = await managed(code, 7, { status: 'draft', hash: hashOf(7) });
  const call = (body) => admin.post('/api/admin/case-status', { case_code: code, content_version: 7, ...body });
  assert.equal((await new Client().post('/api/admin/case-status', { case_code: code, content_version: 7, status: 'published' })).status, 401, 'players cannot');
  assert.equal((await call({ status: 'tested' })).status, 400, 'tested is not settable through the API');
  assert.equal((await call({ status: 'published' })).status, 409, 'a draft cannot be published');
  assert.equal((await admin.post('/api/admin/case-status', { case_code: code, content_version: 99, status: 'published' })).status, 404);
  assert.equal((await admin.post('/api/admin/case-status', { case_code: '!!', content_version: 7, status: 'published' })).status, 400);
  assert.equal((await admin.post('/api/admin/case-status', { case_code: code, content_version: 'x', status: 'published' })).status, 400);
  await pool.query('update cases set validated_hash = content_hash where id = $1', [c.caseId]);
  await transition(c.caseId, 'review');
  const refused = await call({ status: 'published' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /illegal case status transition/);
  await transition(c.caseId, 'tested', { reviewer: 'Rev', blind_playtest: 'completed' });
  const ok = await call({ status: 'published' });
  assert.equal(ok.status, 200);
  assert.equal(await status(c.caseId), 'published');
  const list = (await admin.get('/api/admin/cases')).data.cases.find((x) => x.case_code === code);
  assert.equal(list.status, 'published');
  assert.equal(list.content_version, 7);
  assert.equal(list.validated, true);
  assert.equal(list.tested, true);
  assert.ok(!JSON.stringify(list).match(/password|answer|correct/i), 'the catalogue exposes no secret');
  assert.equal((await call({ status: 'disabled' })).status, 200);
  assert.equal(await status(c.caseId), 'disabled');
});

test('draft, review, tested and disabled versions cannot be assigned as if they were published', async () => {
  for (const s of ['draft', 'review', 'tested', 'disabled']) {
    const g = await makeGame(pool, defByCode('SQL05'), { status: s });
    cleanups.push(() => g.cleanup());
    const reg = await g.register({ assign: false });
    const r = await admin.post('/api/admin/assign-case', { registration_id: reg.id, case_code: g.caseCode });
    assert.equal(r.status, 409, s);
    assert.match(r.data.error, new RegExp(`${s}; only published`));
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Seeding
// ------------------------------------------------------------------------------------------------------------------
test('seeding is idempotent: a second run reports every case unchanged and changes no row, key or team', async () => {
  const snapshot = async () => ({
    cases: (await pool.query("select id, status, content_hash, password_hash from cases where case_code ~ '^(SQL|LOG)0[1-6]$' order by case_code")).rows,
    tasks: (await pool.query("select count(*)::int n from tasks where case_id in (select id from cases where case_code ~ '^(SQL|LOG)0[1-6]$')")).rows[0].n,
    hints: (await pool.query('select count(*)::int n from task_hints')).rows[0].n,
    threads: (await pool.query("select count(*)::int n from investigation_threads where case_id in (select id from cases where case_code ~ '^(SQL|LOG)0[1-6]$')")).rows[0].n,
    keys: (await pool.query("select table_name, key from case_table_keys where case_id in (select id from cases where case_code ~ '^(SQL|LOG)0[1-6]$') order by case_id, table_name")).rows,
  });
  const a = await snapshot();
  const dry = nodeScript(['scripts/seed-cases.mjs', '--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal((dry.stdout.match(/UNCHANGED/g) ?? []).length, 12);
  const run = nodeScript(['scripts/seed-cases.mjs']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal((run.stdout.match(/UNCHANGED/g) ?? []).length, 12);
  assert.deepEqual(await snapshot(), a, 'nothing changed: not a case, a password hash, a question, a hint, a thread or a gate key');
});

test('seeding output and logs never reveal passwords, hashes, keys or answers', async () => {
  const out = nodeScript(['scripts/seed-cases.mjs', '--dry-run']);
  const text = out.stdout + out.stderr;
  assert.ok(!/password|\$2[aby]\$|case_table_keys|correct_answer/i.test(text));
  for (const p of PACKS) {
    assert.ok(!text.includes(p.def.culpritName), `the dry run does not print ${p.manifest.case_code}'s culprit`);
    for (const th of p.def.threads) for (const q of th.questions) if (q.answer.length > 5) assert.ok(!text.includes(q.answer), 'no answer is printed');
  }
  assert.match(text, /10 tables|tables, \d+ evidence rows/);
});

test('seeding a live version is refused when its content changed (bump the version), and never touches the team on it', async () => {
  const base = PACKS.find((p) => p.manifest.case_code === 'SQL01');
  const code = 'SQL01';
  const version = 98;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const clone = (hash) => {
    const p = { ...base, manifest: { ...base.manifest, content_version: version }, hash, def: structuredClone(base.def) };
    p.def.slug = `sql01_v${version}`;
    p.def.version = version;
    return p;
  };
  let caseId;
  try {
    // install v98 from the pack
    await client.query('begin');
    let plan = await planSeed(client, clone(hashOf(1)));
    assert.equal(plan.action, 'install');
    const r1 = await applySeed(client, clone(hashOf(1)), plan);
    await client.query('commit');
    caseId = r1.caseId;
    assert.equal(r1.failed.length, 0);
    assert.equal(await status(caseId), 'review', 'a pack that passes the automated gate waits in review');
    assert.ok((await pool.query('select password_hash from cases where id = $1', [caseId])).rows[0].password_hash, 'an unrecoverable password exists until an organizer issues one');
    // same content again: unchanged
    plan = await planSeed(client, clone(hashOf(1)));
    assert.equal(plan.action, 'unchanged');
    // changed content, nobody on it yet, still in review: replaced in place, same id
    plan = await planSeed(client, clone(hashOf(2)));
    assert.equal(plan.action, 'replace');
    await client.query('begin');
    const r2 = await applySeed(client, clone(hashOf(2)), plan);
    await client.query('commit');
    assert.equal(r2.caseId, caseId);
    assert.equal((await pool.query('select content_hash from cases where id = $1', [caseId])).rows[0].content_hash, hashOf(2));
    // a team starts on it: now a content change is refused outright
    const teamId = randomUUID();
    const ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const code6 = Array.from({ length: 6 }, () => ABC[Math.floor(Math.random() * ABC.length)]).join('');
    await pool.query("insert into teams (id, case_id, team_code, team_name) values ($1, $2, $3, 'Pinned')", [teamId, caseId, code6]);
    await pool.query('insert into team_progress (team_id) values ($1)', [teamId]);
    await pool.query('insert into team_scores (team_id, total_pts) values ($1, 37)', [teamId]);
    plan = await planSeed(client, clone(hashOf(3)));
    assert.equal(plan.action, 'blocked');
    assert.equal(plan.teams, 1);
    await assert.rejects(applySeed(client, clone(hashOf(3)), plan), /pinned by live teams/);
    // and the team's score is exactly as it was
    assert.equal((await pool.query('select total_pts from team_scores where team_id = $1', [teamId])).rows[0].total_pts, 37);
    // a tested version is blocked even with no team
    await pool.query('delete from team_scores where team_id = $1', [teamId]);
    await pool.query('delete from team_progress where team_id = $1', [teamId]);
    await pool.query('delete from teams where id = $1', [teamId]);
    await pool.query("update cases set status = 'tested', tested_hash = content_hash where id = $1", [caseId]);
    plan = await planSeed(client, clone(hashOf(4)));
    assert.equal(plan.action, 'blocked');
  } finally {
    if (caseId) {
      const cc = await pool.connect();
      try {
        await removeCaseFully(cc, caseId);
      } finally {
        cc.release();
      }
    }
    await client.end();
  }
  assert.equal(code, 'SQL01');
});

test('case-lifecycle refuses tested without a recorded human review and blind playtest for this exact content', () => {
  const st = nodeScript(['scripts/case-lifecycle.mjs', 'SQL01', '2', 'status']);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /SQL01 v2: status review; validated true; tested false; pack matches database true/);
  const tested = nodeScript(['scripts/case-lifecycle.mjs', 'SQL01', '2', 'tested']);
  assert.notEqual(tested.status, 0);
  assert.match(tested.stderr, /REFUSED: review\.json has no completed human review/);
  const pub = nodeScript(['scripts/case-lifecycle.mjs', 'SQL01', '2', 'published']);
  assert.notEqual(pub.status, 0);
  assert.match(pub.stderr, /illegal case status transition review -> published/);
});

test('retiring legacy cases disables them for new assignments and deletes nothing: live teams keep playing', async () => {
  const legacy = await makeGame(pool, defByCode('LOG01'), { caseCode: 'LOG99', status: 'published' });
  const stub = await makeGame(pool, defByCode('SQL01'), { caseCode: 'SH3R10CK', status: 'published' });
  cleanups.push(() => legacy.cleanup(), () => stub.cleanup());
  const team = await startedTeam(legacy, 1);
  const waiting = await stub.register();
  const dry = nodeScript(['scripts/retire-legacy-cases.mjs']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would retire/);
  assert.equal(await status(legacy.caseId), 'published', 'a dry run changes nothing');
  const run = nodeScript(['scripts/retire-legacy-cases.mjs', '--apply']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await status(legacy.caseId), 'disabled');
  assert.equal(await status(stub.caseId), 'disabled');
  assert.equal((await pool.query("select count(*)::int n from cases where case_code ~ '^(SQL|LOG)0[1-6]$' and status = 'disabled'")).rows[0].n, 0, 'catalogue cases are not retired');
  // the live team on the retired case is untouched and keeps playing
  const q = legacy.tasks[0];
  const r = await submit(team.head, q.id, answerValue(q));
  assert.equal(r.status, 200);
  assert.equal(r.data.correct, true);
  assert.equal((await new Client().headJoin(legacy, team.reg, 'Head')).status, 200);
  assert.equal((await new Client().joinTeam(team.teamCode, 'Late')).status, 200);
  // an unstarted registration assigned to the stub can no longer start
  assert.equal((await new Client().headJoin(stub, waiting)).status, 401);
  // and nothing new can be assigned to a retired case
  const reg2 = await legacy.register({ assign: false });
  assert.equal((await admin.post('/api/admin/assign-case', { registration_id: reg2.id, case_code: 'LOG99' })).status, 409);
  const audit = (await pool.query("select count(*)::int n from admin_audit where action = 'case_retired' and case_id = any($1)", [[legacy.caseId, stub.caseId]])).rows[0].n;
  assert.equal(audit, 2);
});
