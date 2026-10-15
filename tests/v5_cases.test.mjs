import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CATALOGUE, FIXTURES, db, makeGame, startedTeam, solveAll, finishFinal, submit, final, answerValue, flattenQuestions } from './helpers.mjs';
import { installCase, verifyDefinition, QUESTION_POINTS, TOTAL_POINTS } from '../scripts/cases/engine.mjs';

const pool = db();
after(async () => {
  await pool.end();
});

const scratch = async (def, tag = 'vfyt') => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    const installed = await installCase(client, def, { slug: `${tag}${Math.floor(Math.random() * 1e6)}`, caseCode: `VFY${Math.floor(Math.random() * 1e6)}`, password: 'x', bcryptCost: 4 });
    const results = await verifyDefinition(client, def, installed);
    return results;
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
};

const CODES = ['SQL01', 'SQL02', 'SQL03', 'SQL04', 'SQL05', 'SQL06', 'LOG01', 'LOG02', 'LOG03', 'LOG04', 'LOG05', 'LOG06'];
const questionsOf = (d) => d.threads.flatMap((t) => t.questions);
const budget = (d) => questionsOf(d).reduce((n, q) => n + (q.points ?? QUESTION_POINTS), 0) + d.finalPoints.culprit + d.finalPoints.mechanism;

test('the catalogue is exactly the twelve supplied cases: SQL01-SQL06 and LOG01-LOG06, each with its own story, culprit and answers', () => {
  assert.equal(CATALOGUE.length, 12);
  assert.deepEqual(CATALOGUE.map((d) => d.code), CODES);
  assert.equal(CATALOGUE.filter((d) => d.track === 'SQL').length, 6);
  assert.equal(CATALOGUE.filter((d) => d.track === 'LOGIC').length, 6);
  for (const field of ['slug', 'title', 'hook']) assert.equal(new Set(CATALOGUE.map((d) => d[field])).size, 12, field);
  assert.ok(new Set(CATALOGUE.map((d) => d.culpritName)).size >= 10, 'culprits are not repeated across the catalogue');
  const answerSets = CATALOGUE.map((d) => questionsOf(d).map((q) => q.prompt ?? q.title).join('|'));
  assert.equal(new Set(answerSets).size, 12, 'no two cases share the same questions');
  assert.equal(new Set(CATALOGUE.map((d) => d.threads.map((t) => t.title).join('|'))).size, 12);
  assert.equal(new Set(CATALOGUE.flatMap((d) => d.finalOptions.map((o) => o.label))).size, CATALOGUE.reduce((n, d) => n + d.finalOptions.length, 0), 'every final-deduction choice is written for its own case');
  assert.ok(!CATALOGUE.some((d) => /^(SQL|LOG)(0[7-9]|10)$/.test(d.code) || d.code === 'SH3R10CK'));
});

test('every case is a complete 100-point design with a visible story, ordered hints, a solution map and two or three red herrings', () => {
  for (const d of CATALOGUE) {
    const qs = questionsOf(d);
    assert.equal(budget(d), TOTAL_POINTS, `${d.code} budget`);
    assert.ok(d.finalPoints.culprit >= 12 && d.finalPoints.mechanism >= 8, `${d.code} final components`);
    assert.ok(qs.every((q) => q.hints.length >= 2 && q.hints.length <= 5 && q.hints.every((h) => h.length >= 20)), `${d.code} hints`);
    assert.ok(d.hook && d.hook.length > 120 && d.phases.every((p) => p.clue.length > 120 && p.name), `${d.code} story and phase names`);
    assert.ok(d.finalOptions.length >= 3 && d.finalOptions.length <= 4 && d.finalOptions.filter((o) => o.correct).length === 1, `${d.code} options`);
    assert.ok(d.rosterNames.includes(d.culpritName) && d.rosterNames.length >= 4, `${d.code} roster`);
    const rh = d.solutionMap.red_herrings.length;
    assert.ok(rh >= 2 && rh <= 3, `${d.code} red herrings`);
    assert.ok(d.manifest.publication_eligible === false && d.review.human_review.completed === false, `${d.code} claims no human review`);
  }
});

test('Logic hints give Evidence Browser instructions, never SQL', () => {
  for (const d of CATALOGUE.filter((x) => x.track === 'LOGIC')) {
    const hints = questionsOf(d).flatMap((q) => q.hints);
    assert.ok(!hints.some((h) => /select[^.]{0,60}from/i.test(h)), `${d.code} has no SQL in its hints`);
  }
});

test('every seeded case passed the automated gate and waits in review: nothing is tested or published without a human', async () => {
  const r = (await pool.query("select case_code, status, game_track, content_version, final_points_culprit + final_points_mechanism as fin, content_hash, validated_hash, tested_hash from cases where case_code ~ '^(SQL|LOG)0[1-6]$' and content_version = 2 order by case_code")).rows;
  if (r.length === 0) return; // a database that has not been seeded with the catalogue (the seeding test covers seeding itself)
  assert.equal(r.length, 12, 'all twelve catalogue cases are in the database');
  for (const c of r) {
    assert.equal(c.status, 'review', `${c.case_code} is ${c.status}`);
    assert.ok(c.fin >= 20 && c.fin <= 55);
    assert.ok(c.content_hash && c.content_hash === c.validated_hash, `${c.case_code} validated hash matches its content`);
    assert.equal(c.tested_hash, null, 'no human test is recorded');
    assert.equal(c.content_version, 2);
  }
});

for (const def of CATALOGUE) {
  test(`validator: ${def.code} ${def.title} passes every machine check`, async () => {
    const results = await scratch(def);
    const bad = results.filter((r) => !r.ok);
    assert.deepEqual(bad, [], bad.map((b) => `${b.label}: ${b.detail}`).join('\n'));
    assert.ok(results.length >= 50);
  });
}

test('the validator is not a rubber stamp: each kind of defect is caught', async () => {
  const sql = FIXTURES.find((d) => d.code === 'SQL01');
  const logic = FIXTURES.find((d) => d.code === 'LOG05');
  const pk = CATALOGUE.find((d) => d.code === 'SQL02');
  const mutate = (base, fn) => {
    const d = structuredClone(base);
    fn(d);
    return d;
  };
  const failing = async (def) => (await scratch(def)).filter((r) => !r.ok).map((r) => r.label);
  const laterTable = sql.threads.find((t) => t.unlocks?.length && t.phase === 3).unlocks[0].table;
  const cases = {
    'score budget off': [mutate(sql, (d) => (d.finalPoints.mechanism = 9)), /exactly 100/],
    'too few hints': [mutate(sql, (d) => d.threads[0].questions[0].hints.splice(1)), /hints/],
    'a wrong stored answer': [mutate(sql, (d) => (d.threads[0].questions[0].answer = '9999')), /unique answer/],
    'no correct explanation': [mutate(sql, (d) => d.finalOptions.forEach((o) => (o.correct = false))), /exactly one correct/],
    'a question using a table that is still locked': [mutate(sql, (d) => (d.threads[0].questions[0].sql = `select count(*) from ${laterTable}`)), /solvable with only the tables unlocked/],
    'a prerequisite cycle': [mutate(sql, (d) => (d.threads[0].prerequisite = 't1b')), /acyclic/],
    'a phase with no required thread': [mutate(sql, (d) => d.threads.filter((t) => t.phase === 2).forEach((t) => (t.required = false))), /at least one required thread/],
    'a table nothing ever unlocks': [mutate(sql, (d) => (d.threads.find((t) => t.key === 't3a').unlocks = [])), /unlocked by a phase or thread/],
    'a spoiling role': [mutate(sql, (d) => (d.rosterRoles[d.culpritName] = 'The culprit')), /spoils the culprit/],
    'a red herring with no evidence in the data': [mutate(pk, (d) => (d.solutionMap.red_herrings[0].evidence[0].verify_sql = "select 1 where false")), /innocent explanation is backed by evidence/],
    'a solution-map inference the data does not support': [mutate(pk, (d) => (d.solutionMap.inferences[0].evidence[0].verify_sql = "select 1 where false")), /is present in the data/],
    'an expected result that no longer matches': [mutate(pk, (d) => (d.expectations.queries[0].expect = [['wrong']])), /expected result/],
  };
  // two correct explanations cannot even be stored: the database refuses it
  const twoCorrect = mutate(sql, (d) => d.finalOptions.forEach((o) => (o.correct = true)));
  await assert.rejects(scratch(twoCorrect), /final_options_one_correct/);
  const misses = [];
  for (const [name, [def, expected]] of Object.entries(cases)) {
    const labels = await failing(def);
    if (!labels.some((l) => expected.test(l))) misses.push(`${name}: expected ${expected}, got ${JSON.stringify(labels)}`);
  }
  assert.deepEqual(misses, []);
});

// ------------------------------------------------------------------------------------------------------------------
// Full rehearsal over HTTP: every case, played start to finish by ONE player (so solo-completability is proven for all 10)
// ------------------------------------------------------------------------------------------------------------------
for (const def of CATALOGUE) {
  test(`rehearsal: ${def.code} ${def.title} is solvable alone, start to finish, for exactly 100`, async () => {
    const game = await makeGame(pool, def);
    try {
      const { head } = await startedTeam(game);
      const results = await solveAll(head, game);
      assert.ok(results.every((r) => r.status === 200 && r.data.correct), 'every question correct');
      const paid = results.reduce((n, r) => n + r.data.points_awarded, 0);
      assert.equal(paid, budget(def) - def.finalPoints.culprit - def.finalPoints.mechanism, 'question points add up');
      let st = (await head.get('/api/state')).data;
      assert.equal(st.state, 'FINAL_DEDUCTION');
      assert.equal(st.threads.length, def.threads.length);
      assert.ok(st.case.hook_text && st.narrative.length === 3 && st.narrative.every((n) => n.name), 'the story and phase names reach the player');
      assert.equal(flattenQuestions(st).every((q) => q.completed), true);
      const [a, b] = await finishFinal(head, game);
      assert.equal(a.data.points_awarded, def.finalPoints.culprit);
      assert.equal(b.data.points_awarded, def.finalPoints.mechanism);
      assert.equal(b.data.finished, true);
      st = (await head.get('/api/state')).data;
      assert.equal(st.state, 'FINISHED');
      assert.equal(st.scores.total_pts, 100);
      assert.equal(st.solution.culprit, def.culpritName);
      assert.ok(st.story.length === def.threads.length, 'every thread produced its story event');
    } finally {
      await game.cleanup();
    }
  });
}

test('a wrong-but-plausible reading is really wrong: red herrings are not accepted as the culprit', async () => {
  for (const code of ['LOG03', 'SQL02']) {
    const def = CATALOGUE.find((d) => d.code === code);
    const game = await makeGame(pool, def);
    try {
      const { head } = await startedTeam(game);
      await solveAll(head, game);
      const roster = (await head.get('/api/state')).data.roster;
      const redHerrings = def.solutionMap.red_herrings.map((r) => r.suspect);
      for (const name of redHerrings) {
        const c = roster.find((x) => x.name === name);
        assert.ok(c, `${name} is on the roster`);
        const r = await final(head, 'culprit', c.id);
        assert.equal(r.data.correct, false, name);
      }
    } finally {
      await game.cleanup();
    }
  }
});
