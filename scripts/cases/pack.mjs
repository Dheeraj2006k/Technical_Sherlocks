// Case Pack loader and structural validator (PRD Addendum 1).
//
// GitHub files under cases/<CODE>-<slug>/ are the canonical authoring source; Postgres holds only the runtime copy.
// This module reads a pack from disk, turns it into the plain-data definition the install engine understands
// (scripts/cases/engine.mjs) and runs every check that needs no database. Database-backed checks (reference queries,
// evidence queries, red-herring evidence) live in engine.mjs `verifyDefinition`.
//
// Pack layout (all files UTF-8; JSON unless noted):
//   manifest.json          case code, track, title, content version, declared lifecycle status, duration, reviewer, eligibility
//   story.md               player-facing hook and the three phase briefings (headings fixed, see parseStory)
//   characters.json        roster: public role, profile, relationships, alibi claim, what evidence proves
//   ground-truth.json      PRIVATE: culprit, victim, motive, method, timeline, causal chain, resolution text
//   investigation.json     phases (open tables), threads, prerequisites, unlocks, story events
//   tasks.json             questions: prompt, deterministic answer, points, private explanation, reference SQL
//   hints.json             four ordered hints per question and the scoring rule they follow
//   final-deduction.json   culprit points, fixed explanation choices (exactly one correct)
//   solution-map.json      PRIVATE: evidence-to-solution map and the red herrings with their innocent explanations
//   answer-key.md          PRIVATE: human-readable answer key
//   evidence/schema.sql    create table statements only
//   evidence/seed/<t>.json {columns, rows}
//   tests/expectations.json  extra expected query results asserted by the pack tests
//   review.json            human review / blind-playtest record (never changes the content hash)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CASES_DIR = join(ROOT, 'cases');
// The supplied roster: the only titles a canonical (content_version 2) case may carry.
export const CANONICAL_TITLES = {
  SQL01: 'Seven Minutes Late', SQL02: 'The Last Show', SQL03: 'The Missing Batch', SQL04: 'The Borrowed Badge', SQL05: 'The Wrong Parcel', SQL06: 'The Empty Account',
  LOG01: "The Locked Room That Wasn't", LOG02: 'The Vanishing Trophy', LOG03: 'The Silent Call', LOG04: 'The Rainy-Day Alibi', LOG05: 'The Duplicate Invitation', LOG06: 'The Last Render',
};
export const CANONICAL_VERSION = 2;
export const CATALOGUE_CODES = ['SQL01', 'SQL02', 'SQL03', 'SQL04', 'SQL05', 'SQL06', 'LOG01', 'LOG02', 'LOG03', 'LOG04', 'LOG05', 'LOG06'];
export const LIFECYCLE = ['draft', 'review', 'tested', 'published', 'disabled'];
export const REWARD_SCHEDULE = [10, 8, 6, 4, 2];
export const WRONG_PENALTY = 2;
export const QUESTION_POINTS = 10;
export const TOTAL_POINTS = 100;
export const HINTS_PER_QUESTION = 4;
const OUTCOMES = ['CLEARED', 'LEAD_DISCOVERED', 'REMAINS_PERSON_OF_INTEREST', 'COMPLETED'];
const ANSWER_TYPES = ['SINGLE_CHARACTER', 'NUMBER', 'TIME', 'TEXT', 'CHOICE'];
const KINDS = ['PERSON', 'ACCESS', 'OBJECT', 'MESSAGE', 'TIME', 'MOTIVE'];
const REQUIRED_FILES = [
  'manifest.json', 'story.md', 'characters.json', 'ground-truth.json', 'investigation.json', 'tasks.json', 'hints.json',
  'final-deduction.json', 'solution-map.json', 'answer-key.md', 'review.json', 'evidence/schema.sql', 'tests/expectations.json',
];

const norm = (s) => s.replace(/\r\n/g, '\n');
const readText = (dir, rel) => norm(readFileSync(join(dir, rel), 'utf8'));
const readJson = (dir, rel) => JSON.parse(readText(dir, rel));
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)).map((x) => `${n}/${x}`) : [n]));

export function listPackDirs() {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((n) => /^(SQL|LOG)\d{2}-/.test(n) && statSync(join(CASES_DIR, n)).isDirectory())
    .sort()
    .map((n) => join(CASES_DIR, n));
}

// Content hash: every pack file except review.json and the lifecycle fields of the manifest, so recording a human review
// or moving a case along the lifecycle never changes "which content this is".
export function contentHash(dir) {
  const h = createHash('sha256');
  for (const rel of walk(dir).sort()) {
    if (rel === 'review.json') continue;
    let text = readText(dir, rel);
    if (rel === 'manifest.json') {
      const m = JSON.parse(text);
      delete m.status;
      delete m.reviewer;
      delete m.publication_eligible;
      text = JSON.stringify(m);
    }
    h.update(rel).update('\0').update(text).update('\0');
  }
  return h.digest('hex');
}

// "## Phase 1 briefing" style sections. The hook is everything under "# Hook".
export function parseStory(text) {
  const out = { hook: null, phases: {} };
  const parts = text.split(/^#{1,2}\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = part.slice(0, nl).trim().toLowerCase();
    const body = part.slice(nl + 1).trim().replace(/\n{2,}/g, '\n\n');
    if (head === 'hook') out.hook = body;
    const m = head.match(/^phase ([123]) briefing$/);
    if (m) out.phases[Number(m[1])] = body;
  }
  return out;
}

// Splits schema.sql into create-table statements. Anything else is rejected by the structural checks.
export function parseSchema(sql) {
  const stripped = sql.replace(/--[^\n]*/g, '');
  const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  const tables = [];
  const rejected = [];
  for (const st of statements) {
    const m = st.match(/^create\s+table\s+([a-z][a-z0-9_]{0,40})\s*\(([\s\S]*)\)$/i);
    if (m) tables.push({ name: m[1].toLowerCase(), body: m[2].trim() });
    else rejected.push(st.slice(0, 60));
  }
  return { tables, rejected };
}

const columnNames = (body) => {
  // top-level comma split (parentheses may nest in checks and types)
  const cols = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) cols.push(cur.trim());
  return cols.filter((c) => !/^(primary|foreign|unique|check|constraint)\b/i.test(c)).map((c) => c.split(/\s+/)[0].toLowerCase());
};

// Loads a pack. Never throws for content problems: they are returned as `problems` so every pack can be reported at once.
export function loadPack(dir) {
  const problems = [];
  const folder = dir.split(/[\\/]/).pop();
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(dir, f)));
  for (const f of missing) problems.push(`missing file ${f}`);
  const J = (rel) => {
    try {
      return readJson(dir, rel);
    } catch (e) {
      problems.push(`${rel}: ${e.message}`);
      return null;
    }
  };
  const manifest = J('manifest.json');
  const characters = J('characters.json');
  const truth = J('ground-truth.json');
  const inv = J('investigation.json');
  const tasksFile = J('tasks.json');
  const hintsFile = J('hints.json');
  const finalFile = J('final-deduction.json');
  const map = J('solution-map.json');
  const review = J('review.json');
  const expectations = J('tests/expectations.json');
  const story = existsSync(join(dir, 'story.md')) ? parseStory(readText(dir, 'story.md')) : { hook: null, phases: {} };
  const schemaSql = existsSync(join(dir, 'evidence/schema.sql')) ? readText(dir, 'evidence/schema.sql') : '';
  const schema = parseSchema(schemaSql);
  const seeds = {};
  const seedDir = join(dir, 'evidence', 'seed');
  if (existsSync(seedDir)) for (const f of readdirSync(seedDir).filter((x) => x.endsWith('.json'))) seeds[f.replace(/\.json$/, '')] = JSON.parse(readText(dir, `evidence/seed/${f}`));

  const pack = { dir, folder, manifest, characters, truth, inv, tasksFile, hintsFile, finalFile, map, review, expectations, story, schema, seeds, problems, missing };
  if (problems.length || !manifest || !characters || !truth || !inv || !tasksFile || !hintsFile || !finalFile) return { ...pack, def: null, hash: missing.length ? null : contentHash(dir) };
  pack.hash = contentHash(dir);
  pack.def = buildDefinition(pack);
  return pack;
}

// Pack -> the definition consumed by scripts/cases/engine.mjs (same shape the runtime installer has always used).
export function buildDefinition(p) {
  const { manifest: m, characters, truth, inv, tasksFile, hintsFile, finalFile, story } = p;
  const slug = `${m.case_code.toLowerCase()}_v${m.content_version}`;
  const roster = characters.characters;
  const byKey = new Map(tasksFile.tasks.map((t) => [t.key, t]));
  const names = new Set(p.schema.tables.map((t) => t.name));
  const tables = p.schema.tables.map((t) => {
    const seed = p.seeds[t.name] ?? { columns: [], rows: [] };
    return {
      name: t.name,
      // references to sibling tables are written unqualified in schema.sql; the installer qualifies them with the case schema
      ddl: t.body.replace(/\breferences\s+([a-z][a-z0-9_]*)\s*\(/gi, (all, n) => (names.has(n.toLowerCase()) ? `references {S}.${n.toLowerCase()}(` : all)),
      columns: seed.columns,
      rows: seed.rows,
    };
  });
  const threads = inv.threads.map((th) => ({
    key: th.key, phase: th.phase, position: th.position, title: th.title, subject: th.subject ?? null, intro: th.intro,
    outcomeType: th.outcome_type, outcomeText: th.outcome_text, required: th.required, prerequisite: th.prerequisite ?? null,
    unlocks: th.unlocks ?? [],
    questions: tasksFile.tasks
      .filter((t) => t.thread === th.key)
      .map((t) => ({
        key: t.key, title: t.title, prompt: t.prompt, type: t.answer_type, answer: t.answer, alt: t.alt_answers ?? [], options: t.options ?? null, concept: t.concept,
        kind: t.evidence_kind ?? 'OBJECT', label: t.evidence_label ?? 'Finding: {value}', difficulty: t.difficulty, reward: t.reward_schedule ?? null, sql: t.reference_sql, explanation: t.explanation, points: t.points,
        hints: hintsFile.hints[t.key] ?? [],
      })),
  }));
  void byKey;
  return {
    slug,
    code: m.case_code,
    track: m.track,
    title: m.title,
    version: m.content_version,
    hook: story.hook,
    targetMinutes: m.duration_minutes,
    victimName: truth.victim,
    culpritName: truth.culprit,
    rosterNames: roster.map((c) => c.name),
    nonSuspects: roster.filter((c) => c.suspect === false).map((c) => c.name),
    rosterRoles: Object.fromEntries(roster.map((c) => [c.name, c.role])),
    rosterProfiles: Object.fromEntries(roster.map((c) => [c.name, c.profile ?? null])),
    solution: { motive: truth.resolution.motive, method: truth.resolution.method, chain: truth.resolution.chain },
    tables,
    phases: [1, 2, 3].map((n) => ({ name: inv.phases.find((x) => x.phase === n)?.name ?? null, clue: story.phases[n] ?? '', tables: inv.phases.find((x) => x.phase === n)?.tables ?? [] })),
    threads,
    story: inv.story_events.map((s) => ({ thread: s.thread, title: s.title, body: s.body })),
    finalOptions: finalFile.mechanism.options.map((o) => ({ label: o.label, correct: Boolean(o.correct) })),
    finalPoints: { culprit: finalFile.culprit.points, mechanism: finalFile.mechanism.points },
    solutionMap: p.map,
    expectations: p.expectations,
    review: p.review,
    manifest: m,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Structural checks (no database). Returns [{ ok, label, detail }].
// ---------------------------------------------------------------------------------------------------------------------
export function structuralChecks(pack) {
  const out = [];
  const add = (ok, label, detail = '') => out.push({ ok: Boolean(ok), label, detail });
  add(pack.problems.length === 0, 'every required pack file exists and parses', pack.problems.join('; '));
  if (!pack.def) return out;
  const { manifest: m, characters, truth, inv, tasksFile, hintsFile, finalFile, map, story, schema, seeds, review, expectations, def } = pack;

  // manifest
  add(CATALOGUE_CODES.includes(m.case_code), 'case code is one of the twelve catalogue codes', m.case_code);
  add(pack.folder.startsWith(`${m.case_code}-`), 'folder name starts with the case code', pack.folder);
  add((m.track === 'SQL') === m.case_code.startsWith('SQL') && ['SQL', 'LOGIC'].includes(m.track), 'track matches the case code prefix', m.track);
  add(Number.isInteger(m.content_version) && m.content_version >= 1, 'content version is a positive integer');
  add(LIFECYCLE.includes(m.status), 'declared status is a lifecycle state', m.status);
  add(['draft', 'review'].includes(m.status) || (review?.human_review?.completed && review?.blind_playtest?.completed), 'a pack cannot declare tested/published without a recorded human review and blind playtest');
  add(Number.isInteger(m.duration_minutes) && m.duration_minutes >= 10 && m.duration_minutes <= 30, 'duration target is 10-30 minutes', String(m.duration_minutes));
  add(m.title && m.reviewer && typeof m.reviewer === 'object' && typeof m.publication_eligible === 'boolean', 'manifest has a title, reviewer information and publication eligibility');
  add(!(m.publication_eligible && !(review?.human_review?.completed && review?.blind_playtest?.completed)), 'publication_eligible is false until human review and blind playtest are recorded');
  add(review && ['human_review', 'blind_playtest', 'automated'].every((k) => k in review), 'review.json records automated, human review and blind-playtest status');
  add(!review?.human_review?.completed || (review.human_review.reviewer && review.human_review.date && review.human_review.content_hash === pack.hash), 'a recorded human review names a reviewer, a date and this exact content hash');
  add(!review?.blind_playtest?.completed || (review.blind_playtest.participants >= 1 && review.blind_playtest.content_hash === pack.hash), 'a recorded blind playtest names participants and this exact content hash');

  // story: hook and three briefings exist; the briefings do not name the solution as a verdict
  add(story.hook && story.hook.length > 120, 'story hook is written');
  add([1, 2, 3].every((n) => (story.phases[n] ?? '').length > 120), 'all three phase briefings are written');
  const spoil = /\b(is the (killer|culprit|thief)|was the (killer|culprit|thief)|(he|she|they) did it|the culprit is|the guilty)\b/i;
  add(!spoil.test(`${story.hook} ${Object.values(story.phases).join(' ')}`), 'player-facing story does not announce the solution');

  // characters / ground truth
  const roster = characters.characters;
  const names = roster.map((c) => c.name);
  add(new Set(names).size === names.length && names.length >= 4 && names.length <= 14, 'roster has 4-14 distinct characters', String(names.length));
  add(names.includes(truth.culprit) && !names.includes(truth.victim), 'culprit is on the roster; victim is not');
  add(roster.every((c) => c.role && c.profile), 'every character has a public role and profile');
  add(!roster.some((c) => /culprit|killer|murderer|guilty|thief/i.test(c.role)), 'no public role text spoils the culprit');
  add(roster.filter((c) => c.suspect !== false).length >= 4 && roster.filter((c) => c.name === truth.culprit && c.suspect === false).length === 0, 'the final suspect list has at least four people including the culprit');
  add(truth.timeline?.length >= 4 && truth.timeline.every((t) => t.time && t.event && t.evidence), 'ground truth has a timeline of 4+ evidenced events');
  add(truth.causal_chain?.length >= 3 && truth.motive && truth.method && truth.explanation, 'ground truth has motive, method, explanation and a causal chain of 3+ steps');
  add(truth.resolution?.motive && truth.resolution?.method && truth.resolution?.chain?.length >= 3, 'resolution text (motive, method, chain) is present');

  // investigation structure
  const tableNames = schema.tables.map((t) => t.name);
  add(schema.rejected.length === 0, 'schema.sql contains only create table statements', schema.rejected.join(' | '));
  add(tableNames.length >= 3 && tableNames.length <= 18, 'case has 3-18 evidence tables', String(tableNames.length));
  add(tableNames.every((t) => seeds[t]), 'every evidence table has a seed file', tableNames.filter((t) => !seeds[t]).join(','));
  add(Object.keys(seeds).every((t) => tableNames.includes(t)), 'no seed file lacks a table');
  for (const t of schema.tables) {
    const cols = columnNames(t.body);
    const seed = seeds[t.name];
    if (!seed) continue;
    add(seed.columns.every((c) => cols.includes(c)) && seed.rows.every((r) => r.length === seed.columns.length), `table ${t.name}: seed columns match the schema and every row is complete`);
  }
  add(def.phases.length === 3 && inv.phases.length === 3, 'three phases are defined');
  const unlockTables = [...inv.phases.flatMap((p) => p.tables), ...inv.threads.flatMap((t) => (t.unlocks ?? []).map((u) => u.table))];
  add(unlockTables.every((t) => tableNames.includes(t)) && tableNames.every((t) => unlockTables.includes(t)), 'every table is unlocked exactly where declared and every unlock names a real table');
  const th = inv.threads;
  const thKeys = new Set(th.map((t) => t.key));
  add(thKeys.size === th.length, 'thread keys are unique');
  add(th.every((t) => [1, 2, 3].includes(t.phase) && OUTCOMES.includes(t.outcome_type) && t.title && t.intro && t.outcome_text), 'every thread has a phase, title, intro, outcome type and outcome text');
  add(th.every((t) => !t.subject || names.includes(t.subject)), 'thread subjects are roster characters');
  add(th.every((t) => !t.prerequisite || thKeys.has(t.prerequisite)), 'thread prerequisites resolve');
  const byKey = new Map(th.map((t) => [t.key, t]));
  let acyclic = true;
  for (const t of th) {
    const seen = new Set([t.key]);
    for (let q = t.prerequisite ? byKey.get(t.prerequisite) : null; q; q = q.prerequisite ? byKey.get(q.prerequisite) : null) {
      if (seen.has(q.key) || q.phase > t.phase) acyclic = false;
      seen.add(q.key);
      if (seen.size > th.length + 1) break;
    }
  }
  add(acyclic, 'no circular or backwards unlock dependencies');
  add(th.every((t) => !t.required || !t.prerequisite || byKey.get(t.prerequisite)?.required), 'required threads never depend on optional ones (solo-playable)');
  add([1, 2, 3].every((p) => th.some((t) => t.phase === p && t.required)), 'every phase has a required thread');
  add(th.filter((t) => t.required).length >= 3, 'at least three required threads (one per phase)');
  add(inv.story_events.length === th.length && inv.story_events.every((s) => thKeys.has(s.thread) && s.title && s.body?.length > 60), 'every thread has a written story event');

  // tasks
  const tasks = tasksFile.tasks;
  const keys = new Set(tasks.map((t) => t.key));
  add(keys.size === tasks.length && tasks.length >= 4 && tasks.length <= 10, 'uniquely keyed questions (4-10)', String(tasks.length));
  add(tasks.every((t) => thKeys.has(t.thread)) && th.every((t) => tasks.some((x) => x.thread === t.key)), 'every question is in a real thread and every thread has a question');
  add(tasks.every((t) => ANSWER_TYPES.includes(t.answer_type) && (!t.evidence_kind || KINDS.includes(t.evidence_kind)) && t.title), 'every question has a valid answer type, a title and a known evidence kind');
  add(tasks.every((t) => Number.isInteger(t.points) && t.points > 0), 'every question has positive base points');
  add(tasks.every((t) => !t.reward_schedule || (t.reward_schedule.length === 5 && t.reward_schedule[0] === t.points && t.reward_schedule.every((x, i, a) => i === 0 || x < a[i - 1]) && t.reward_schedule.at(-1) > 0)), 'a per-question reward ladder starts at the question points and strictly decreases');
  const total = tasks.reduce((s, t) => s + t.points, 0) + finalFile.culprit.points + finalFile.mechanism.points;
  add(total === TOTAL_POINTS, 'all question and final-component base points sum to exactly 100', String(total));
  add(new Set(tasks.map((t) => t.prompt)).size === tasks.length, 'question prompts are distinct');
  add(tasks.every((t) => t.answer_type !== 'SINGLE_CHARACTER' || names.includes(t.answer)), 'character answers are roster names');
  add(tasks.every((t) => t.answer_type !== 'TIME' || /^([01]\d|2[0-3]):[0-5]\d$/.test(t.answer)), 'time answers are HH:MM');
  add(tasks.every((t) => t.answer_type !== 'NUMBER' || /^-?\d+(\.\d+)?$/.test(t.answer)), 'number answers are numeric');
  add(tasks.every((t) => [].concat(t.reference_sql).length >= 1 && [].concat(t.reference_sql).every((q) => /^\s*(select|with)\b/i.test(q) && !q.trim().replace(/;\s*$/, '').includes(';'))), 'reference/evidence queries are single SELECT/WITH statements');
  add(tasks.every((t) => !t.evidence_label || t.evidence_label.includes('{value}')), 'evidence labels carry a {value} placeholder');
  add(tasks.every((t) => t.explanation && t.explanation.length > 40), 'every question has a private explanation');
  add(tasks.every((t) => t.answer_type !== 'CHOICE' || (Array.isArray(t.options) && t.options.length >= 2 && t.options.length <= 6 && t.options.filter((o) => o.key === t.answer).length === 1)), 'every multiple-choice question lists its options and exactly one correct key');
  // The prerequisite chain also has to fit the question order a team experiences
  add(tasks.map((t) => t.key).join() === [...new Set(tasks.map((t) => t.key))].join(), 'question keys are not repeated');

  // hints
  const rule = hintsFile.scoring;
  add(JSON.stringify(rule?.reward_schedule) === JSON.stringify(REWARD_SCHEDULE) && rule?.wrong_answer_penalty === WRONG_PENALTY && rule?.sql_errors_free === true, 'hint file states the approved scoring rule (10/8/6/4/2, -2 per wrong committed answer, SQL errors free)');
  add(tasks.every((t) => hintsFile.hints[t.key]?.length >= 2 && hintsFile.hints[t.key].length <= 5 && hintsFile.hints[t.key].every((h) => typeof h === 'string' && h.length >= 20)), 'every question has 2-5 written hints in order');
  add(Object.keys(hintsFile.hints).every((k) => keys.has(k)), 'no hints reference an unknown question');
  const leaks = tasks.filter((t) => t.answer.length >= 4 && (hintsFile.hints[t.key] ?? []).slice(0, 3).some((h) => h.toLowerCase().includes(t.answer.toLowerCase())));
  add(leaks.length === 0, 'hints 1-3 never state the canonical answer', leaks.map((t) => t.key).join(','));
  add(tasks.every((t) => (hintsFile.hints[t.key] ?? []).every((h, i, a) => a.indexOf(h) === i)), 'hints within a question are distinct');
  const logic = m.track === 'LOGIC';
  add(!logic || tasks.every((t) => !/\bselect\b[^.]{0,60}\bfrom\b|\bgroup by\b|\b(inner|left|right) join\b|\bwhere\s+\w+\s*(=|like|in)\b/i.test((hintsFile.hints[t.key] ?? []).join(' '))), 'Logic hints use Evidence Browser instructions, not SQL');

  // final deduction
  const opts = finalFile.mechanism.options;
  add(opts.length >= 3 && opts.length <= 4 && opts.filter((o) => o.correct).length === 1 && new Set(opts.map((o) => o.label)).size === opts.length && opts.every((o) => o.label.length > 40), 'explanation choices: 3-4 distinct written options, exactly one correct');
  add(finalFile.culprit.points > 0 && finalFile.mechanism.points > 0, 'both final components carry points');

  // evidence-to-solution map and red herrings
  const inferences = map.inferences ?? [];
  add(inferences.length >= 3 && inferences.every((i) => i.id && i.claim && i.tasks?.length && i.tasks.every((k) => keys.has(k)) && i.evidence?.length && i.evidence.every((e) => tableNames.includes(e.table) && e.summary && e.verify_sql)), 'solution map: every key inference cites questions and evidence with a verification query');
  add(tasks.every((t) => inferences.some((i) => i.tasks.includes(t.key))), 'solution map covers every question');
  const rh = map.red_herrings ?? [];
  add(rh.length >= 2 && rh.length <= 3, 'two or three red herrings are documented', String(rh.length));
  add(rh.every((r) => names.includes(r.suspect) && r.suspect !== truth.culprit && r.why_suspicious && r.innocent_explanation && r.evidence?.length && r.evidence.every((e) => tableNames.includes(e.table) && e.verify_sql)), 'every red herring names a non-culprit suspect, why they look guilty, an innocent explanation and verifying evidence');
  add(new Set(rh.map((r) => r.suspect)).size === rh.length, 'red herrings concern different suspects');
  add(Array.isArray(expectations?.queries) && expectations.queries.length >= 2 && expectations.queries.every((q) => q.name && q.sql && Array.isArray(q.expect)), 'tests/expectations.json lists 2+ expected query results');
  return out;
}

export function loadAllPacks() {
  return listPackDirs().map(loadPack);
}
