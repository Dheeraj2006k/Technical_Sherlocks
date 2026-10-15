// Generic v5 case engine: installs any case definition on the shared investigation engine and mechanically verifies the
// machine-checkable parts of the case validation checklist (PRD 14): scoring budget, structure, solo-solvability, evidence
// unlock rules, unique answers and hints.
//
// A v5 definition is plain data:
//   { slug, code ('SQL01'..'SQL06', 'LOG01'..'LOG06'), track ('SQL'|'LOGIC'), title, hook, victimName, culpritName, rosterNames[], rosterRoles{},
//     solution{ motive, method, chain[] },
//     tables:[{ name, ddl, columns, rows }],                         // schema case_<slug>
//     phases:[{ clue, tables:[] } x3],                               // tables open for the whole phase
//     threads:[{ key, phase, position, title, subject (character name|null), intro, outcomeType, outcomeText, required,
//                prerequisite (thread key|null), unlocks:[{ table, when:'available'|'complete' }],
//                questions:[{ title, prompt, type, answer, concept, sql, kind, label, difficulty, hints[4] }] }],
//     story:[{ thread, title, body }],
//     finalOptions:[{ label, correct }] (3-4, exactly one correct),
//     finalPoints:{ culprit, mechanism } }
// A question's `sql` is a reference query returning exactly its answer, using only tables unlocked by then. Every question
// is worth 10 points (reward schedule 10/8/6/4/2 by hints used); questions + final components total exactly 100.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { provisionCase, schemaFor } from '../lib/provision.mjs';

const CHUNK = 150;
export const QUESTION_POINTS = 10;
export const REWARD_SCHEDULE = [10, 8, 6, 4, 2];
export const HINTS_PER_QUESTION = 4;
export const TOTAL_POINTS = 100;

export function allQuestions(def) {
  return def.threads.flatMap((t) => t.questions.map((q, i) => ({ ...q, thread: t, index: i })));
}

export async function installCase(
  client,
  def,
  { id = randomUUID(), slug = def.slug, caseCode = def.code, password, passwordHash, status = 'draft', title = def.title, bcryptCost = 10, version = def.version ?? 1, contentHash = null } = {},
) {
  const schema = schemaFor(slug);
  const q = (s) => client.escapeIdentifier(s);
  const pw = password ?? randomUUID(); // unrecoverable unless the caller supplies one: use gen-case-credentials
  const hash = passwordHash ?? (await bcrypt.hash(pw, bcryptCost));

  await client.query(`drop schema if exists ${q(schema)} cascade`);
  await client.query(`create schema ${q(schema)}`);
  for (const t of def.tables) {
    await client.query(`create table ${q(schema)}.${q(t.name)} (${t.ddl.replaceAll('{S}', q(schema))})`);
    for (let i = 0; i < t.rows.length; i += CHUNK) {
      const part = t.rows.slice(i, i + CHUNK);
      const params = [];
      const tuples = part.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
      const cols = t.columns ? `(${t.columns.map(q).join(', ')})` : '';
      await client.query(`insert into ${q(schema)}.${q(t.name)} ${cols} values ${tuples.join(', ')}`, params);
    }
  }

  const fp = def.finalPoints ?? { culprit: 12, mechanism: 8 };
  await client.query(
    `insert into cases (id, case_code, slug, password_hash, title, status, hook_text, solution_motive, solution_method, solution_chain,
                        game_track, target_duration_minutes, final_points_culprit, final_points_mechanism, content_version, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [id, caseCode, slug, hash, title, status, def.hook, def.solution?.motive ?? null, def.solution?.method ?? null, JSON.stringify(def.solution?.chain ?? []),
      def.track, def.targetMinutes ?? 18, fp.culprit, fp.mechanism, version, contentHash],
  );
  for (let p = 1; p <= 3; p++) {
    await client.query('insert into case_phases (case_id, phase_number, clue_text, tables_unlocked, phase_name) values ($1, $2, $3, $4, $5)', [
      id, p, def.phases[p - 1].clue, def.phases[p - 1].tables, def.phases[p - 1].name ?? null,
    ]);
  }
  const characters = [];
  for (const name of def.rosterNames) {
    const cid = randomUUID();
    await client.query('insert into characters (id, case_id, name, role_in_story, is_suspect, public_profile) values ($1, $2, $3, $4, $5, $6)', [cid, id, name, def.rosterRoles?.[name] ?? 'Person of interest', !(def.nonSuspects ?? []).includes(name), def.rosterProfiles?.[name] ?? null]);
    characters.push({ id: cid, name });
  }
  const charId = (n) => {
    const c = characters.find((x) => x.name === n);
    if (!c) throw new Error(`${def.slug}: unknown character ${n}`);
    return c.id;
  };

  // threads (two passes so prerequisites can point at any earlier thread)
  const threadIds = new Map();
  for (const th of def.threads) {
    const tid = randomUUID();
    threadIds.set(th.key, tid);
    await client.query(
      `insert into investigation_threads (id, case_id, phase_number, position, title, subject_character_id, intro_text, outcome_type, outcome_text, required)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tid, id, th.phase, th.position, th.title, th.subject ? charId(th.subject) : null, th.intro ?? null, th.outcomeType ?? 'COMPLETED', th.outcomeText ?? null, th.required],
    );
  }
  for (const th of def.threads) {
    if (th.prerequisite) await client.query('update investigation_threads set prerequisite_thread_id = $2 where id = $1', [threadIds.get(th.key), threadIds.get(th.prerequisite)]);
    for (const u of th.unlocks ?? []) {
      await client.query('insert into thread_evidence_tables (thread_id, table_name, unlock_condition) values ($1, $2, $3)', [threadIds.get(th.key), u.table, u.when]);
    }
  }

  const tasks = [];
  for (const th of def.threads) {
    for (const [i, qn] of th.questions.entries()) {
      const correct = qn.type === 'SINGLE_CHARACTER' ? charId(qn.answer) : qn.answer;
      const tid = randomUUID();
      await client.query(
        `insert into tasks (id, case_id, phase_number, difficulty, prompt_text, answer_type, correct_answer, sql_concept, title, evidence_kind, evidence_label,
                            thread_id, position, base_points, reward_schedule, alt_answers)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [tid, id, th.phase, qn.difficulty ?? null, qn.prompt, qn.type, correct, qn.concept ?? null, qn.title, qn.kind ?? null, qn.label ?? null,
          threadIds.get(th.key), i + 1, qn.points ?? QUESTION_POINTS, qn.reward ?? REWARD_SCHEDULE, qn.alt ?? []],
      );
      for (const [k, o] of (qn.options ?? []).entries()) {
        await client.query('insert into task_options (task_id, option_key, option_text, position) values ($1, $2, $3, $4)', [tid, o.key, o.text, k + 1]);
      }
      for (const [h, text] of qn.hints.entries()) {
        await client.query('insert into task_hints (task_id, position, hint_text) values ($1, $2, $3)', [tid, h + 1, text]);
      }
      tasks.push({ id: tid, thread: th.key, phase: th.phase, answer_type: qn.type, correct_answer: correct, answer_text: qn.answer, sql: qn.sql, hints: qn.hints, title: qn.title });
    }
  }
  for (const ev of def.story ?? []) {
    await client.query('insert into story_events (case_id, trigger_thread_id, title, body) values ($1, $2, $3, $4)', [id, threadIds.get(ev.thread), ev.title, ev.body]);
  }
  const options = [];
  for (const [i, o] of def.finalOptions.entries()) {
    const oid = randomUUID();
    await client.query("insert into final_options (id, case_id, component, position, label, is_correct) values ($1, $2, 'mechanism', $3, $4, $5)", [oid, id, i + 1, o.label, Boolean(o.correct)]);
    options.push({ id: oid, label: o.label, correct: Boolean(o.correct) });
  }
  const culpritId = charId(def.culpritName);
  await client.query('update cases set culprit_character_id = $2 where id = $1', [id, culpritId]);
  await provisionCase(client, id);
  return { caseId: id, slug, schema, caseCode, password: pw, passwordHash: hash, version, characters, tasks, culpritId, options, threadIds };
}

// Removes one case version's CONTENT (never a team). Refuses when any team references it: live content is immutable and a
// changed pack must be published as a new content version instead.
export async function deleteCaseContent(client, caseId) {
  const row = (await client.query('select slug from cases where id = $1', [caseId])).rows[0];
  if (!row) return;
  const teams = (await client.query('select count(*)::int n from teams where case_id = $1', [caseId])).rows[0].n;
  if (teams > 0) throw new Error(`refusing to replace content that ${teams} team(s) are pinned to; bump content_version instead`);
  const assigned = (await client.query('select count(*)::int n from team_case_assignments where case_id = $1', [caseId])).rows[0].n;
  if (assigned > 0) throw new Error(`refusing to replace content that ${assigned} assignment record(s) point at; bump content_version instead`);
  await client.query('delete from cases where id = $1', [caseId]);
  await client.query(`drop schema if exists ${client.escapeIdentifier(schemaFor(row.slug))} cascade`);
}

// Test-only helper: removes a throwaway case together with every team that played it.
export async function removeCaseFully(client, caseId) {
  const row = (await client.query('select slug from cases where id = $1', [caseId])).rows[0];
  await client.query('delete from teams where case_id = $1', [caseId]);
  await client.query('delete from team_case_assignments where case_id = $1', [caseId]);
  await client.query('delete from cases where id = $1', [caseId]);
  if (row) await client.query(`drop schema if exists ${client.escapeIdentifier(schemaFor(row.slug))} cascade`);
}

// Tables a question may rely on: the phase tables up to its phase, plus unlocks of its own thread and of every required
// thread of earlier phases and every prerequisite of its thread (those are guaranteed complete / available by then).
export function tablesAvailableFor(def, thread) {
  const set = new Set(def.phases.slice(0, thread.phase).flatMap((p) => p.tables));
  const byKey = new Map(def.threads.map((t) => [t.key, t]));
  const add = (t, complete) => {
    for (const u of t.unlocks ?? []) if (u.when === 'available' || complete) set.add(u.table);
  };
  add(thread, false);
  const walked = new Set([thread.key]);
  for (let p = byKey.get(thread.prerequisite); p && !walked.has(p.key); p = byKey.get(p.prerequisite)) {
    walked.add(p.key); // a cyclic definition is reported by the structure checks; never loop on it
    add(p, true);
  }
  for (const t of def.threads) if (t.required && t.phase < thread.phase) add(t, true);
  return set;
}

// --- machine-checkable parts of the case validation checklist ----------------------------------------------------
// Runs against an installed copy of the case (as the DB owner) and returns [{ ok, label, detail }].
export async function verifyDefinition(client, def, installed) {
  const out = [];
  const add = (ok, label, detail = '') => out.push({ ok, label, detail });
  const schema = schemaFor(installed.slug);
  const qs = allQuestions(def);

  // identity and registry
  add(/^(SQL|LOG)\d{2}$/.test(def.code) && (def.code.startsWith('SQL') ? def.track === 'SQL' : def.track === 'LOGIC'), 'case code matches its track', `${def.code}/${def.track}`);

  // scoring: every question 10 points; questions + both final components = exactly 100
  const questionTotal = qs.reduce((n, x) => n + (x.points ?? QUESTION_POINTS), 0);
  const fp = def.finalPoints ?? { culprit: 12, mechanism: 8 };
  add(questionTotal + fp.culprit + fp.mechanism === TOTAL_POINTS, 'maximum score is exactly 100', `${questionTotal} + ${fp.culprit} + ${fp.mechanism}`);
  add(qs.every((x) => x.hints?.length >= 2 && x.hints.length <= 5 && x.hints.every((h) => h && h.length > 10)), 'every question has 2-5 written hints');
  add(qs.every((x) => x.type !== 'CHOICE' || (x.options?.length >= 2 && x.options.length <= 6 && x.options.filter((o) => o.key === x.answer).length === 1 && new Set(x.options.map((o) => o.text)).size === x.options.length)), 'every multiple-choice question has distinct options and exactly one correct key');
  add(new Set(qs.map((x) => x.prompt)).size === qs.length, 'question prompts are distinct');

  // structure: every phase has a required thread; positions are sane; prerequisites point at earlier threads
  const byKey = new Map(def.threads.map((t) => [t.key, t]));
  add(byKey.size === def.threads.length, 'thread keys are unique');
  for (let p = 1; p <= 3; p++) {
    const ts = def.threads.filter((t) => t.phase === p);
    add(ts.some((t) => t.required), `phase ${p} has at least one required thread`, `${ts.length} threads`);
  }
  add(def.threads.every((t) => t.questions.length >= 1), 'every thread has at least one question');
  let acyclic = true;
  for (const t of def.threads) {
    const seen = new Set([t.key]);
    for (let p = t.prerequisite ? byKey.get(t.prerequisite) : null; p; p = p.prerequisite ? byKey.get(p.prerequisite) : null) {
      if (seen.has(p.key) || p.phase > t.phase) {
        acyclic = false;
        break;
      }
      seen.add(p.key);
    }
    if (t.prerequisite && !byKey.has(t.prerequisite)) acyclic = false;
  }
  add(acyclic, 'thread prerequisites are acyclic and never point at a later phase');
  // a required thread must not depend on an optional one (otherwise skipping the optional thread would trap a solo player)
  add(def.threads.every((t) => !t.required || !t.prerequisite || byKey.get(t.prerequisite).required), 'required threads never depend on optional threads (solo-completable)');
  add(def.threads.every((t) => (t.outcomeText ?? '').length > 10), 'every thread has outcome text');
  add((def.story ?? []).length >= 3 && def.story.every((s) => byKey.has(s.thread)), 'story events exist and point at real threads');

  // roster, culprit and spoilers
  add(def.rosterNames.includes(def.culpritName) && !def.rosterNames.includes(def.victimName), 'roster contains the culprit and excludes the victim');
  add(def.rosterNames.every((n) => def.rosterRoles?.[n]), 'every roster character has a public role');
  add(!def.rosterNames.some((n) => /culprit|killer|murderer|guilty/i.test(def.rosterRoles?.[n] ?? '')), 'no role text spoils the culprit');
  add((def.nonSuspects ?? []).every((n) => n !== def.culpritName) && def.rosterNames.filter((n) => !(def.nonSuspects ?? []).includes(n)).length >= 3, 'the culprit is in the final suspect list, which has at least three people');

  // final deduction
  const correct = def.finalOptions.filter((o) => o.correct);
  add(def.finalOptions.length >= 3 && def.finalOptions.length <= 4 && correct.length === 1, 'final explanation has 3-4 options and exactly one correct', `${def.finalOptions.length} options, ${correct.length} correct`);
  add(new Set(def.finalOptions.map((o) => o.label)).size === def.finalOptions.length && def.finalOptions.every((o) => o.label.length > 15), 'final options are distinct, written sentences');
  add(Boolean(def.solution?.motive && def.solution?.method && def.solution?.chain?.length >= 3), 'the case has a motive, method and evidence chain for the resolution screen');

  // evidence: every table is unlocked by a phase or a thread, has real data, and all unlock targets exist
  const existing = (await client.query('select tablename from pg_tables where schemaname = $1', [schema])).rows.map((r) => r.tablename);
  const unlockedBy = new Set([...def.phases.flatMap((p) => p.tables), ...def.threads.flatMap((t) => (t.unlocks ?? []).map((u) => u.table))]);
  add(def.tables.every((t) => unlockedBy.has(t.name)) && [...unlockedBy].every((n) => existing.includes(n)), 'every evidence table is unlocked by a phase or thread, and every unlock names a real table');
  add(def.tables.every((t) => t.rows.length >= 1) && def.tables.reduce((n, t) => n + t.rows.length, 0) >= 12, 'every evidence table has data and the dossier has at least 12 records');
  const keyed = (await client.query('select count(*)::int as n from case_table_keys where case_id = $1', [installed.caseId])).rows[0].n;
  add(keyed === def.tables.length, 'every evidence table has its own gate key', `${keyed}/${def.tables.length}`);

  // each question: reference SQL yields exactly the intended unique answer using only tables unlocked by then
  for (const qn of qs) {
    const label = `${qn.thread.key} Q${qn.index + 1} (${qn.type})`;
    const allowed = tablesAvailableFor(def, qn.thread);
    const queries = [].concat(qn.sql);
    const locked = def.tables.map((t) => t.name).filter((n) => !allowed.has(n) && queries.some((q) => new RegExp(`\\b${n}\\b`).test(q)));
    add(locked.length === 0, `${label}: solvable with only the tables unlocked by then`, locked.join(','));
    for (const [qi, sql] of queries.entries()) {
      try {
        await client.query('savepoint vfy');
        await client.query(`set local search_path = ${client.escapeIdentifier(schema)}`);
        const r = await client.query(sql);
        await client.query('rollback to savepoint vfy');
        if (qn.type === 'CHOICE') {
          add(r.rows.length >= 1, `${label}: evidence query ${qi + 1} runs and returns the records the answer rests on`, `${r.rows.length} rows`);
        } else {
          const vals = r.rows.map((row) => String(Object.values(row)[0]));
          const same = qn.type === 'NUMBER' ? vals.length === 1 && Number(vals[0]) === Number(qn.answer) : vals.length === 1 && vals[0] === qn.answer; // numbers compare numerically: 0.50 is 0.5
          add(same, `${label}: reference SQL yields exactly the intended unique answer`, `got ${JSON.stringify(vals)}, want ${qn.answer}`);
        }
      } catch (e) {
        await client.query('rollback to savepoint vfy').catch(() => {});
        add(false, `${label}: reference SQL runs`, e.message);
      }
    }
    add(Boolean(qn.title && qn.kind && qn.label && qn.label.includes('{value}')), `${label}: has a title, evidence kind and evidence label`);
  }

  // pack-only checks: the evidence-to-solution map, red herrings and the expected query results written by the author
  const runRows = async (sql) => {
    await client.query('savepoint pk');
    try {
      await client.query(`set local search_path = ${client.escapeIdentifier(schema)}`);
      const r = await client.query({ text: sql, rowMode: 'array' });
      return r.rows.map((row) => row.map((v) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v))));
    } finally {
      await client.query('rollback to savepoint pk');
    }
  };
  if (def.solutionMap) {
    for (const inf of def.solutionMap.inferences ?? []) {
      for (const [i, e] of inf.evidence.entries()) {
        try {
          const rows = await runRows(e.verify_sql);
          add(rows.length > 0, `solution map ${inf.id}: evidence ${i + 1} (${e.table}) is present in the data`, `${rows.length} rows`);
        } catch (err) {
          add(false, `solution map ${inf.id}: evidence ${i + 1} query runs`, err.message);
        }
      }
    }
    for (const rh of def.solutionMap.red_herrings ?? []) {
      for (const [i, e] of rh.evidence.entries()) {
        try {
          const rows = await runRows(e.verify_sql);
          add(rows.length > 0, `red herring ${rh.suspect}: the innocent explanation is backed by evidence (${i + 1})`, `${rows.length} rows`);
        } catch (err) {
          add(false, `red herring ${rh.suspect}: evidence query ${i + 1} runs`, err.message);
        }
      }
    }
  }
  for (const ex of def.expectations?.queries ?? []) {
    try {
      const rows = await runRows(ex.sql);
      add(JSON.stringify(rows) === JSON.stringify(ex.expect), `expected result: ${ex.name}`, `got ${JSON.stringify(rows).slice(0, 160)}`);
    } catch (err) {
      add(false, `expected result query runs: ${ex.name}`, err.message);
    }
  }
  return out;
}
