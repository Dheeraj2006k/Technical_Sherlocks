// Generic case engine: installs any case definition and mechanically verifies the PRD section 9
// validation checklist items that CAN be checked by machine.
//
// A definition is plain data:
//   { slug, title, hook, victimName, culpritName, rosterNames[],
//     tables: [{ name, ddl, rows: [[...], ...] }],              // schema case_<slug>
//     phases: [{ clue, tables: ['t1', ...] } x3],
//     tasks:  [{ phase, difficulty, type, prompt, answer, concept, sql } x9] }
// task.answer is the canonical text (for SINGLE_CHARACTER: the character's name); task.sql is a reference
// query that returns exactly that answer using only tables unlocked at that phase.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { randomCaseCode } from '../lib/codes.mjs';
import { provisionCase, schemaFor } from '../lib/provision.mjs';

const CHUNK = 150;

export async function installCase(
  client,
  def,
  { id = randomUUID(), slug = def.slug, caseCode, password, status = 'draft', title = def.title, bcryptCost = 10 } = {},
) {
  const schema = schemaFor(slug);
  const q = (s) => client.escapeIdentifier(s);
  const code = caseCode ?? randomCaseCode();
  const pw = password ?? randomUUID(); // unrecoverable unless the caller supplies one: use gen-case-credentials
  const hash = await bcrypt.hash(pw, bcryptCost);

  await client.query(`drop schema if exists ${q(schema)} cascade`);
  await client.query(`create schema ${q(schema)}`);
  for (const t of def.tables) {
    await client.query(`create table ${q(schema)}.${q(t.name)} (${t.ddl.replaceAll('{S}', q(schema))})`);
    const width = t.rows[0].length;
    for (let i = 0; i < t.rows.length; i += CHUNK) {
      const part = t.rows.slice(i, i + CHUNK);
      const params = [];
      const tuples = part.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`);
      const cols = t.columns ? `(${t.columns.map(q).join(', ')})` : '';
      await client.query(`insert into ${q(schema)}.${q(t.name)} ${cols} values ${tuples.join(', ')}`, params);
      void width;
    }
  }

  await client.query(
    `insert into cases (id, case_code, slug, password_hash, title, status, hook_text, solution_motive, solution_method, solution_chain)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, code, slug, hash, title, status, def.hook, def.solution?.motive ?? null, def.solution?.method ?? null, JSON.stringify(def.solution?.chain ?? [])],
  );
  for (let p = 1; p <= 3; p++) {
    await client.query('insert into case_phases (case_id, phase_number, clue_text, tables_unlocked) values ($1, $2, $3, $4)', [
      id, p, def.phases[p - 1].clue, def.phases[p - 1].tables,
    ]);
  }
  const characters = [];
  for (const name of def.rosterNames) {
    const cid = randomUUID();
    await client.query('insert into characters (id, case_id, name, role_in_story) values ($1, $2, $3, $4)', [cid, id, name, def.rosterRoles?.[name] ?? 'Person of interest']);
    characters.push({ id: cid, name });
  }
  const tasks = [];
  for (const task of def.tasks) {
    const correct = task.type === 'SINGLE_CHARACTER' ? characters.find((c) => c.name === task.answer).id : task.answer;
    const tid = randomUUID();
    await client.query(
      `insert into tasks (id, case_id, phase_number, difficulty, prompt_text, answer_type, correct_answer, sql_concept, title, evidence_kind, evidence_label)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tid, id, task.phase, task.difficulty, task.prompt, task.type, correct, task.concept, task.title ?? null, task.kind ?? null, task.label ?? null],
    );
    tasks.push({ id: tid, phase: task.phase, difficulty: task.difficulty, answer_type: task.type, correct_answer: correct, answer_text: task.answer, sql: task.sql });
  }
  const culpritId = characters.find((c) => c.name === def.culpritName).id;
  await client.query('update cases set culprit_character_id = $2 where id = $1', [id, culpritId]);
  await provisionCase(client, id);
  return { caseId: id, slug, schema, caseCode: code, password: pw, characters, tasks, culpritId };
}

export async function removeCaseFully(client, caseId) {
  const row = (await client.query('select slug from cases where id = $1', [caseId])).rows[0];
  await client.query('delete from teams where case_id = $1', [caseId]);
  await client.query('delete from cases where id = $1', [caseId]);
  if (row) await client.query(`drop schema if exists ${client.escapeIdentifier(schemaFor(row.slug))} cascade`);
}

// --- machine-checkable parts of the PRD section 9 validation checklist -----------------------------
// Runs against an installed copy of the case (as the DB owner) and returns [{ ok, label, detail }].
export async function verifyDefinition(client, def, installed) {
  const out = [];
  const add = (ok, label, detail = '') => out.push({ ok, label, detail });
  const schema = schemaFor(installed.slug);

  // structure: 3 phases x (easy, medium, hard)
  for (let p = 1; p <= 3; p++) {
    const ds = def.tasks.filter((t) => t.phase === p).map((t) => t.difficulty).join(',');
    add(ds === 'easy,medium,hard', `phase ${p} has exactly one easy, medium and hard task`, ds);
  }
  add(def.rosterNames.includes(def.culpritName) && !def.rosterNames.includes(def.victimName), 'roster contains the culprit and excludes the victim');
  add(new Set(def.tasks.map((t) => t.type)).size >= 3, 'task types vary', [...new Set(def.tasks.map((t) => t.type))].join(','));

  // every phase's unlocked tables exist and have rows
  const existing = (await client.query('select tablename from pg_tables where schemaname = $1', [schema])).rows.map((r) => r.tablename);
  const unlocked = def.phases.flatMap((p) => p.tables);
  add(def.tables.every((t) => unlocked.includes(t.name)) && unlocked.every((n) => existing.includes(n)), 'every clue table is unlocked by exactly the phases that list it');
  add(def.tables.every((t) => t.rows.length >= 8), 'every clue table has meaningful data (8+ rows)');

  // each task: reference SQL returns exactly one value equal to the stored answer, using only tables
  // unlocked at that phase (static check on the SQL text) -> "solvable with only the tables unlocked"
  for (const task of def.tasks) {
    const label = `phase ${task.phase} ${task.difficulty} ${task.type}`;
    const allowed = new Set(def.phases.slice(0, task.phase).flatMap((p) => p.tables));
    const locked = def.tables.map((t) => t.name).filter((n) => !allowed.has(n) && new RegExp(`\\b${n}\\b`).test(task.sql));
    add(locked.length === 0, `${label}: SQL uses only tables unlocked by then`, locked.join(','));
    try {
      // savepoints: the caller usually runs us inside a scratch transaction that it rolls back itself
      await client.query('savepoint vfy');
      await client.query(`set local search_path = ${client.escapeIdentifier(schema)}`);
      const r = await client.query(task.sql);
      await client.query('rollback to savepoint vfy');
      const vals = r.rows.map((row) => String(Object.values(row)[0]));
      add(vals.length === 1 && vals[0] === task.answer, `${label}: reference SQL yields exactly the intended unique answer`, `got ${JSON.stringify(vals)}, want ${task.answer}`);
    } catch (e) {
      await client.query('rollback to savepoint vfy').catch(() => {});
      add(false, `${label}: reference SQL runs`, e.message);
    }
  }

  // presentation + resolution content required by the UI (titles, evidence board, final reveal)
  add(def.tasks.every((t) => t.title && t.kind && t.label && t.label.includes('{value}')), 'every task has a title, evidence kind and evidence label');
  add(Boolean(def.solution?.motive && def.solution?.method && def.solution?.chain?.length >= 3), 'the case has a motive, method and evidence chain for the resolution screen');
  add(def.rosterNames.every((n) => def.rosterRoles?.[n]), 'every roster character has a public role');
  add(!def.rosterNames.some((n) => /culprit|killer|murderer/i.test(def.rosterRoles?.[n] ?? '')), 'no role text spoils the culprit');

  // the culprit is uniquely determined by the data unlocked through phase 3 (the final task isolates one person)
  const last = def.tasks.find((t) => t.phase === 3 && t.difficulty === 'hard');
  add(last.type === 'SINGLE_CHARACTER' && last.answer === def.culpritName, 'the last hard task isolates the culprit');
  return out;
}
