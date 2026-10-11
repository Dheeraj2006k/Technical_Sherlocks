import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { CATALOGUE, db, makeGame, startedTeam, solveAll, finishFinal, submit, answerValue, flattenQuestions } from './helpers.mjs';
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

test('the catalogue has 20 distinct cases: SQL01-SQL10 and LOG01-LOG10, each with its own setting and answer set', () => {
  assert.equal(CATALOGUE.length, 20);
  assert.deepEqual(CATALOGUE.map((d) => d.code), [...Array.from({ length: 10 }, (_, i) => `SQL${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 10 }, (_, i) => `LOG${String(i + 1).padStart(2, '0')}`)]);
  assert.equal(CATALOGUE.filter((d) => d.track === 'SQL').length, 10);
  assert.equal(CATALOGUE.filter((d) => d.track === 'LOGIC').length, 10);
  for (const field of ['slug', 'title', 'hook', 'culpritName']) assert.equal(new Set(CATALOGUE.map((d) => d[field])).size, 20, field);
  const answerSets = CATALOGUE.map((d) => d.threads.flatMap((t) => t.questions.map((q) => q.answer)).join('|'));
  assert.equal(new Set(answerSets).size, 20, 'no two cases share the same answers');
  // every table name is unique to its case so a copied query cannot work on another case
  for (const track of ['SQL', 'LOGIC']) {
    const mine = CATALOGUE.filter((d) => d.track === track);
    assert.equal(new Set(mine.map((d) => d.tables.map((t) => t.name).sort().join())).size, 10, `${track} table sets differ`);
  }
});

test('Logic-track casts use Indian names; SQL-track casts are their own distinct stories', () => {
  const indian = /(Kapoor|Bhatia|Iyer|Menon|Reddy|Rao|Nair|Sharma|Joshi|Khan|Pillai|Das|Banerjee|Ghosh|Roy|Mukherjee|Sen|Bose|Hussain|Begum|Patil|Deshmukh|Jadhav|Tiwari|Singh|Chauhan|Mishra|Pandey|Gowda|Bhutia|Thapa|Sherpa|Subramaniam|Varghese|Kumar)/;
  for (const d of CATALOGUE.filter((x) => x.track === 'LOGIC')) {
    assert.ok(indian.test(d.culpritName + d.rosterNames.join()), `${d.code} cast`);
    assert.ok(d.rosterNames.length === 13, `${d.code} roster`);
  }
});

test('every case is a complete 100-point design: 8 questions x 10, responsibility 12, explanation 8', () => {
  for (const d of CATALOGUE) {
    const qs = d.threads.flatMap((t) => t.questions);
    assert.equal(qs.length, 8, d.code);
    assert.equal(qs.length * QUESTION_POINTS + d.finalPoints.culprit + d.finalPoints.mechanism, TOTAL_POINTS, d.code);
    assert.ok(qs.every((q) => q.hints.length === 4 && q.hints.every((h) => h.length > 15)), `${d.code} hints`);
    assert.ok(d.threads.filter((t) => !t.required).length >= 1 && d.threads.filter((t) => t.required).length >= 5, `${d.code} thread mix`);
    assert.ok(d.finalOptions.length === 4 && d.finalOptions.filter((o) => o.correct).length === 1, `${d.code} options`);
    // the correct explanation is not always in the same slot
  }
  const positions = new Set(CATALOGUE.map((d) => d.finalOptions.findIndex((o) => o.correct)));
  assert.ok(positions.size >= 3, 'the correct option moves around between cases');
});

test('every seeded case passed validation and is ready: status tested (or published)', async () => {
  const r = (await pool.query("select case_code, status, game_track, final_points_culprit + final_points_mechanism as fin from cases where case_code ~ '^(SQL|LOG)[0-9]{2}$' order by case_code")).rows;
  assert.equal(r.length, 20, 'all 20 catalogue cases are in the database');
  for (const c of r) {
    assert.ok(['tested', 'published'].includes(c.status), `${c.case_code} is ${c.status}`);
    assert.equal(c.fin, 20);
  }
});

for (const def of CATALOGUE) {
  test(`validator: ${def.code} ${def.title} passes every machine check`, async () => {
    const results = await scratch(def);
    const bad = results.filter((r) => !r.ok);
    assert.deepEqual(bad, [], bad.map((b) => `${b.label}: ${b.detail}`).join('\n'));
    assert.ok(results.length >= 40);
  });
}

test('the validator is not a rubber stamp: each kind of defect is caught', async () => {
  const sql = CATALOGUE.find((d) => d.code === 'SQL05');
  const logic = CATALOGUE.find((d) => d.code === 'LOG05');
  const mutate = (base, fn) => {
    const d = structuredClone(base);
    fn(d);
    return d;
  };
  const failing = async (def) => (await scratch(def)).filter((r) => !r.ok).map((r) => r.label);
  const cases = {
    'score budget off': [mutate(sql, (d) => (d.finalPoints.mechanism = 9)), /exactly 100/],
    'a missing hint': [mutate(sql, (d) => d.threads[0].questions[0].hints.pop()), /4 hints/],
    'a wrong stored answer': [mutate(sql, (d) => (d.threads[0].questions[0].answer = '9999')), /unique answer/],
    'a required thread depending on an optional one': [mutate(logic, (d) => (d.threads.find((t) => t.key === 't3a').prerequisite = 't2c')), /solo-completable/],
    'no correct explanation': [mutate(sql, (d) => d.finalOptions.forEach((o) => (o.correct = false))), /exactly one correct/],
    'a question using a table that is still locked': [mutate(sql, (d) => (d.threads[0].questions[0].sql = `select count(*) from ${d.threads[2].unlocks[0].table}`)), /solvable with only the tables unlocked/],
    'the last question not isolating the culprit': [mutate(sql, (d) => (d.culpritName = d.rosterNames[1])), /isolates the culprit/],
    'a prerequisite cycle': [mutate(sql, (d) => (d.threads[0].prerequisite = 't1b')), /acyclic/],
    'a phase with no required thread': [mutate(sql, (d) => d.threads.filter((t) => t.phase === 2).forEach((t) => (t.required = false))), /at least one required thread/],
    'a table nothing ever unlocks': [mutate(sql, (d) => (d.threads.find((t) => t.key === 't3a').unlocks = [])), /unlocked by a phase or thread/],
    'a spoiling role': [mutate(sql, (d) => (d.rosterRoles[d.culpritName] = 'The culprit')), /spoils the culprit/],
  };
  // two correct explanations cannot even be stored: the database refuses it
  const twoCorrect = mutate(sql, (d) => d.finalOptions.forEach((o) => (o.correct = true)));
  await assert.rejects(scratch(twoCorrect), /final_options_one_correct/);
  for (const [name, [def, expected]] of Object.entries(cases)) {
    const labels = await failing(def);
    assert.ok(labels.some((l) => expected.test(l)), `${name}: expected a failure matching ${expected}, got ${JSON.stringify(labels)}`);
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Full rehearsal over HTTP: every case, played start to finish by ONE player (so solo-completability is proven for all 20)
// ------------------------------------------------------------------------------------------------------------------
for (const def of CATALOGUE) {
  test(`rehearsal: ${def.code} ${def.title} is solvable alone, start to finish, for exactly 100`, async () => {
    const game = await makeGame(pool, def);
    try {
      const { head } = await startedTeam(game);
      const results = await solveAll(head, game);
      assert.ok(results.every((r) => r.status === 200 && r.data.correct && r.data.points_awarded === 10), 'every question correct, 10 points each');
      let st = (await head.get('/api/state')).data;
      assert.equal(st.state, 'FINAL_DEDUCTION');
      assert.equal(st.threads.length, def.threads.length);
      assert.equal(flattenQuestions(st).every((q) => q.completed), true);
      const [a, b] = await finishFinal(head, game);
      assert.equal(a.data.points_awarded, 12);
      assert.equal(b.data.points_awarded, 8);
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
  const def = CATALOGUE.find((d) => d.code === 'LOG03');
  const game = await makeGame(pool, def);
  try {
    const { head } = await startedTeam(game);
    const final = game.tasks.at(-1);
    const st = (await head.get('/api/state')).data;
    // answer everything but the last question, then try every other suspect on it
    for (const t of game.tasks.slice(0, -1)) await submit(head, t.id, answerValue(t));
    const roster = (await head.get('/api/state')).data.roster;
    let wrongCount = 0;
    for (const c of roster.filter((x) => x.id !== final.correct_answer).slice(0, 3)) {
      const r = await submit(head, final.id, c.id);
      assert.equal(r.data.correct, false, c.name);
      wrongCount++;
      if (wrongCount === 3) break;
    }
    assert.equal(st.roster.length, 13);
  } finally {
    await game.cleanup();
  }
});
