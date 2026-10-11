// Turns a skeleton-A case (3 phases x easy/medium/hard, generated and verified) into a v5 SQL-track case: investigation
// threads with a required/optional mix, thread-level evidence unlocks, story events, hints and a two-component final
// deduction. The puzzle data and every answer stay exactly as generated; only the presentation structure is new.
//
//   8 questions x 10 points + responsibility 12 + explanation 8 = 100
import { arrangeOptions, fill, hintsFor } from './common.mjs';

export function toV5Sql(def, ordinal) {
  const m = def.meta;
  const code = `SQL${String(ordinal).padStart(2, '0')}`;
  const find = (phase, difficulty) => def.tasks.find((t) => t.phase === phase && t.difficulty === difficulty);
  const tbl = (p) => def.phases[p - 1].tables;
  // Phase 1 opens the roster and door log; the custody log and the messages open through threads (see `unlocks`).
  const phases = def.phases.map((p, i) => ({ clue: p.clue, tables: i === 0 ? p.tables : [] }));
  const base = { ...def, phases, code, track: 'SQL', targetMinutes: 18 };

  const q = (t) => ({ ...t, hints: hintsFor(base, t) });
  const custody = tbl(2)[0];
  const messages = tbl(3)[0];

  const threads = [
    {
      key: 't1a', phase: 1, position: 1, required: true, prerequisite: null, subject: null,
      title: `Who was inside the ${m.area}?`,
      intro: `Start with the door records. Establish who actually entered the ${m.area} while it mattered.`,
      outcomeType: 'COMPLETED',
      outcomeText: `The door records fix who was inside the ${m.area} during the interval, and when the last person left. One name does not fit the usual crowd.`,
      questions: [q(find(1, 'easy')), q(find(1, 'medium'))],
    },
    {
      key: 't1b', phase: 1, position: 2, required: false, prerequisite: 't1a', subject: m.outsider,
      title: 'The face that does not belong',
      intro: 'One entrant works somewhere else entirely. It may be nothing, or it may be everything.',
      outcomeType: 'CLEARED',
      outcomeText: `${m.outsider} entered the ${m.area} only briefly, on an errand, and was gone before the inspection. They are no longer a suspect.`,
      questions: [q(find(1, 'hard'))],
    },
    {
      key: 't2a', phase: 2, position: 1, required: true, prerequisite: null, subject: null,
      title: `The ${m.item}: who handled it?`,
      intro: `The custody record has just been opened. Follow the ${m.item} through the interval.`,
      outcomeType: 'COMPLETED',
      outcomeText: `The custody log pins down every handling of the ${m.item} and the last moment it was touched before it left for the stage.`,
      unlocks: [{ table: custody, when: 'available' }],
      questions: [q(find(2, 'easy')), q(find(2, 'medium'))],
    },
    {
      key: 't2b', phase: 2, position: 2, required: true, prerequisite: 't2a', subject: null,
      title: 'The batch that should not be there',
      intro: 'A refill is recorded after the official check. Read the note carefully.',
      outcomeType: 'LEAD_DISCOVERED',
      outcomeText: `The ${m.item} was refilled from batch ${m.lot} after ${m.inspector} had inspected and cleared it. Somebody changed what was in it.`,
      questions: [q(find(2, 'hard'))],
    },
    {
      key: 't3a', phase: 3, position: 1, required: true, prerequisite: null, subject: null,
      title: `${def.victimName}'s messages`,
      intro: 'The victim\'s phone was recovered. The messages are now open to you.',
      outcomeType: 'LEAD_DISCOVERED',
      outcomeText: `${def.victimName} had been pressing someone hard. The messages show how often, and what was at stake.`,
      unlocks: [{ table: messages, when: 'available' }],
      questions: [q(find(3, 'medium'))],
    },
    {
      key: 't3b', phase: 3, position: 2, required: true, prerequisite: 't3a', subject: null,
      title: 'Put it all together',
      intro: 'Location, handling and threats. Only one person fits all three.',
      outcomeType: 'COMPLETED',
      outcomeText: 'Placed inside the room, handling the evidence after the check, and the target of the threats: the pieces converge on one person.',
      questions: [q(find(3, 'hard'))],
    },
  ];

  const story = threads.map((t) => ({
    thread: t.key,
    title: t.title,
    body: t.questions.map((x) => fill(x.label, x.answer)).join('. ') + '. ' + t.outcomeText,
  }));

  const culprit = def.culpritName;
  const finalOptions = arrangeOptions(
    def.slug,
    `${culprit} stayed behind in the ${m.area} after ${m.inspector}'s ${m.inspectTime} inspection and swapped in a different batch (${m.lot}).`,
    [
      `${m.outsider} slipped into the ${m.area} during the interval and tampered with the ${m.item} before the inspection.`,
      `${m.inspector} tampered with the ${m.item} while inspecting it, then signed it off as clean.`,
      `Nobody tampered with the ${m.item}: it was faulty from the moment it was checked in, and the logs only look suspicious.`,
    ],
  );

  return { ...base, threads, story, finalOptions, finalPoints: { culprit: 12, mechanism: 8 } };
}
