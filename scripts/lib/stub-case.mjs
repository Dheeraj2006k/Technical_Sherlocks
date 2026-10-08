// Builds the Stage 2 stub case (3 phases x 3 tasks, all four answer types).
// Used by scripts/seed-stub-case.mjs (fixed ids) and by the automated tests (random ids).
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { randomCaseCode } from './codes.mjs';

const CHARACTER_NAMES = ['Ada Wren', 'Boris Hale', 'Clara Voss', 'Dmitri Park', 'Elena Cruz', 'Felix Grant'];

// [phase, difficulty, answer_type, prompt, answer]; SINGLE_CHARACTER answer = roster index.
const TASKS = [
  [1, 'easy', 'SINGLE_CHARACTER', 'Pick the character who was seen at the stage door.', 2],
  [1, 'medium', 'NUMBER', 'Type the number 5.', '5'],
  [1, 'hard', 'TIME', 'Enter the time the lights went out (HH:MM).', '21:45'],
  [2, 'easy', 'NUMBER', 'Type the number 12.', '12'],
  [2, 'medium', 'TEXT', 'Type the code word ALPHA-7.', 'ALPHA-7'],
  [2, 'hard', 'SINGLE_CHARACTER', 'Pick the character who lied about the keys.', 4],
  [3, 'easy', 'TIME', 'Enter the time of the final message (HH:MM).', '09:05'],
  [3, 'medium', 'TEXT', 'Type the phrase Shadow Key.', 'Shadow Key'],
  [3, 'hard', 'NUMBER', 'Type the number 3.5.', '3.5'],
];

/**
 * @param client  a connected pg client/pool
 * @param opts.fixed  deterministic ids (seed script) vs random ids (tests)
 * @param opts.caseCode  8-char Crockford code (random when omitted)
 * @param opts.status    'live' (joinable) by default
 * @param opts.tag    string embedded in clue/prompt text so tests can detect leaks
 * @returns { caseId, password, characters, tasks } where tasks include correct_answer (for tests)
 */
export async function insertStubCase(client, { id, password, title = 'Stub Case', fixed = false, tag = '', bcryptCost = 10, caseCode, status = 'live', slug } = {}) {
  const n = (kind, i) => (fixed ? `00000000-0000-4000-8000-${String(kind * 1000 + i).padStart(12, '0')}` : randomUUID());
  const caseId = id ?? n(0, 1);
  const hash = await bcrypt.hash(password, bcryptCost);

  const code = caseCode ?? randomCaseCode();
  await client.query(
    'insert into cases (id, case_code, slug, password_hash, title, status, hook_text) values ($1, $2, $3, $4, $5, $6, $7)',
    [caseId, code, slug ?? (fixed ? 'stub' : `t${randomUUID().replace(/-/g, '').slice(0, 12)}`), hash, title, status, `HOOK${tag}: a stub mystery for state-machine testing.`],
  );

  const tables = [['cast_crew'], ['access_log'], ['text_messages']];
  for (let p = 1; p <= 3; p++) {
    await client.query(
      'insert into case_phases (case_id, phase_number, clue_text, tables_unlocked) values ($1, $2, $3, $4)',
      [caseId, p, `CLUE_PHASE_${p}${tag}: narrative for phase ${p}.`, tables[p - 1]],
    );
  }

  const characters = [];
  for (let i = 0; i < CHARACTER_NAMES.length; i++) {
    const cid = n(1, i + 1);
    await client.query('insert into characters (id, case_id, name, role_in_story) values ($1, $2, $3, $4)', [
      cid,
      caseId,
      CHARACTER_NAMES[i],
      'stub role',
    ]);
    characters.push({ id: cid, name: CHARACTER_NAMES[i] });
  }

  const tasks = [];
  for (let i = 0; i < TASKS.length; i++) {
    const [phase, difficulty, answerType, prompt, answer] = TASKS[i];
    const correct = answerType === 'SINGLE_CHARACTER' ? characters[answer].id : answer;
    const tid = n(2, i + 1);
    await client.query(
      `insert into tasks (id, case_id, phase_number, difficulty, prompt_text, answer_type, correct_answer, sql_concept)
       values ($1, $2, $3, $4, $5, $6, $7, 'stub')`,
      [tid, caseId, phase, difficulty, `${prompt} [P${phase}${tag}]`, answerType, correct],
    );
    tasks.push({ id: tid, phase, difficulty, answer_type: answerType, correct_answer: correct });
  }
  // The stub's culprit is the 4th character (index 3).
  await client.query('update cases set culprit_character_id = $2 where id = $1', [caseId, characters[3].id]);
  return { caseId, caseCode: code, password, characters, tasks, culpritId: characters[3].id, wrongCulpritId: characters[0].id };
}

// Deletes a case and everything hanging off it (teams reference cases without cascade).
export async function deleteCase(client, caseId) {
  await client.query('delete from teams where case_id = $1', [caseId]);
  await client.query('delete from cases where id = $1', [caseId]);
}
