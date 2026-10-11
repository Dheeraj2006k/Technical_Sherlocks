// Skeleton B ("the alibi grid"): the LOGIC-track case builder. The player never needs SQL: the evidence is five tables
// browsed in the Evidence Browser (search, filter, sort) and the questions are about reconciling who SAID they were
// somewhere with where the records SAW them, and who could have handled the item afterwards.
//
// Every answer is DERIVED from the generated rows, and every question ships a reference query (used only by the case
// validator) proving the answer is unique and reachable from the tables unlocked by then. Times, codes and the number of
// extra witnesses vary with the theme seed.
//
// People order is fixed: 0 victim, 1 culprit, 2 inspector, 3 outsider (lied about being there; innocent, seen by one
// source only), 4 red herring (seen in the area, truthful), 5 and 6 red herrings (motives), 7..13 bystanders.
import { arrangeOptions, fill, hintsFor } from './common.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const CODE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function buildSkeletonB(theme, ordinal) {
  const r = rng(theme.seed);
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const T = theme.tables;
  const ts = (mins) => `${theme.date} ${hhmm(mins)}:00`;
  const P = theme.people;
  if (P.length !== 14) throw new Error(`${theme.slug}: need 14 people`);
  const [victim, culprit, inspector, outsider, herring1] = P;
  const area = theme.area;
  const areaWords = area.toLowerCase().replaceAll('_', ' ');
  const [pl0, pl1, pl2, pl3] = theme.places;
  const item = theme.item;
const qi = item.replaceAll("'", "''"); // item name escaped for the reference SQL literals

  // ---- timeline
  const winStart = Number(theme.windowStart.slice(0, 2)) * 60 + Number(theme.windowStart.slice(3, 5));
  const winEnd = winStart + 20;
  const I = winStart + 15;
  const oIn = winStart + ri(1, 3);
  const hIn = winStart + ri(3, 6);
  const cIn = winStart + ri(5, 8);
  const cLast = I + ri(2, 4); // culprit is the last person seen in the area, after the inspection
  const modifiedAt = I + ri(1, 2);
  const takenAt = I + ri(9, 12);
  const usedAt = takenAt + ri(18, 24);
  const extraWitnesses = ri(0, 2); // bystanders (idx 7..) who really were in the area and said so
  const extraLiar = ri(0, 1) === 1; // idx 9: said elsewhere, was seen in the area by two sources
  const extraThreats = ri(0, 2);
  const code = (n) => Array.from({ length: n }, () => CODE_CHARS[ri(0, CODE_CHARS.length - 1)]).join('');
  const lotA = `${code(3)}-${ri(100, 999)}`;
  let lotB = `${code(3)}-${ri(100, 999)}`;
  while (lotB === lotA) lotB = `${code(3)}-${ri(100, 999)}`;
  const early = winStart - 200;

  // ---- sightings [person, place, mins, source]
  const sightings = [];
  const see = (i, place, m, source) => sightings.push([i + 1, place, m, source]);
  // everyone is seen arriving somewhere (noise outside the window)
  P.forEach((_, i) => see(i, [pl0, pl1, pl2, pl3][i % 4], early + i * 5 + ri(0, 3), ['BADGE', 'GUARD', 'CCTV'][i % 3]));
  see(4, area, early + 20, 'BADGE'); // a cleaner-type visit long before the window
  see(2, area, early + 40, 'BADGE');
  see(5, area, winEnd + 8, 'GUARD'); // seen after the window
  // the window: who was inside the area
  see(3, area, oIn, 'GUARD'); // the outsider: ONE source only
  see(4, area, hIn, 'CCTV');
  see(4, area, hIn + 1, 'BADGE');
  see(1, area, cIn, 'CCTV');
  see(1, area, cIn + 1, 'BADGE');
  see(1, area, cLast, 'CCTV'); // last seen in the area, after the inspection
  see(2, area, I - 2, 'BADGE');
  see(2, area, I, 'CCTV');
  const witnesses = Array.from({ length: extraWitnesses }, (_, k) => 7 + k);
  for (const w of witnesses) see(w, area, winStart + ri(2, 12), 'BADGE');
  if (extraLiar) {
    see(9, area, winStart + ri(4, 10), 'BADGE');
    see(9, area, winStart + ri(11, 14), 'GUARD');
  }
  // truthful alibis elsewhere during the window
  see(5, pl1, winStart + 5, 'CCTV');
  see(6, pl2, winStart + 6, 'BADGE');
  see(0, pl0, winStart + 3, 'CCTV');
  for (const i of [10, 11, 12, 13].concat(extraLiar ? [] : [9]).concat(extraWitnesses < 2 ? [8] : []).concat(extraWitnesses < 1 ? [7] : [])) {
    see(i, pl3, winStart + 4 + (i % 5), 'GUARD');
  }
  sightings.sort((a, b) => a[2] - b[2]);

  // ---- statements [person, claimedPlace]; all cover the window
  const statements = [];
  const say = (i, place) => statements.push([i + 1, place, winStart, winEnd, winEnd + 30 + i]);
  say(1, pl1); // culprit lies: "I was at ..."
  say(3, pl3); // outsider lies too
  say(4, area);
  say(2, area);
  say(5, pl1);
  say(6, pl2);
  say(0, pl0);
  for (const w of witnesses) say(w, area);
  if (extraLiar) say(9, pl3);
  for (const i of [10, 11, 12, 13]) say(i, pl3);
  statements.sort((a, b) => a[0] - b[0]);

  // ---- handling log [item, action, person, mins, note]
  const handling = [
    [item, 'CHECKED_IN', 1, early - 8, theme.itemWords.checkedIn],
    [item, 'FILLED', 1, winStart - 100, `${theme.itemWords.filled} ${lotA}`],
    [item, 'RETURNED_TO_SHELF', 3, oIn + 1, theme.itemWords.returned],
    [item, 'INSPECTED', 2, I, theme.itemWords.inspected],
    [item, 'REFILLED', 1, modifiedAt, `${theme.itemWords.refilled} ${lotB}`],
    [item, 'TAKEN_TO_DISPLAY', 3, takenAt, theme.itemWords.taken],
    [item, 'USED_ON_STAGE', 0, usedAt, theme.itemWords.used],
  ];
  theme.otherItems.forEach((o, k) => {
    handling.push([o, 'CHECKED_IN', 1, early - 6 + k * 2, 'Logged and tested']);
    handling.push([o, 'TAKEN_TO_DISPLAY', 3, winStart - 70 + k, 'Moved into position']);
    if (k % 2 === 0) handling.push([o, 'INSPECTED', 2, early + 12 + k, 'Walk-through']);
  });
  handling.sort((a, b) => a[3] - b[3]);

  // ---- messages [from, to, mins, body]
  const firstThreat = ri(17 * 60 + 30, 19 * 60);
  const secondThreat = winStart - ri(10, 18);
  const M = theme.messages;
  const msgs = [
    [0, 1, firstThreat, M.threat1],
    [1, 0, firstThreat + ri(5, 12), M.plea],
    [0, 1, secondThreat, M.threat2],
    ...Array.from({ length: extraThreats }, (_, k) => [0, 1, firstThreat + 15 + k * 7 + ri(0, 3), 'Still waiting for your answer.']),
    [2, 3, winStart - 6, M.errand],
    [3, 2, winStart - 5, 'On it!'],
    [4, 0, winStart - 2, M.herring1Wish],
    [5, 0, secondThreat - 10, M.herring2Row],
    [6, 0, winStart + 7, M.herring3Money],
    [1, 0, modifiedAt + 1, M.culpritReady],
    [7, 8, early + 20, M.chatter[0]],
    [9, 10, early + 60, M.chatter[1]],
    [11, 2, early + 80, M.chatter[2]],
    [12, 13, winStart - 60, M.chatter[3]],
    [13, 9, usedAt + 18, M.aftermath],
  ];
  msgs.sort((a, b) => a[2] - b[2]);

  const tables = [
    {
      name: T.people,
      columns: ['person_id', 'name', 'role', 'unit'],
      ddl: 'person_id int primary key, name text not null, role text not null, unit text not null',
      rows: P.map((p, i) => [i + 1, p.name, p.role, p.unit]),
    },
    {
      name: T.sightings,
      columns: ['person_id', 'place', 'seen_at', 'source'],
      ddl: `sighting_id serial primary key, person_id int not null references {S}.${T.people}(person_id), place text not null, seen_at timestamp not null, source text not null check (source in ('CCTV','BADGE','GUARD'))`,
      rows: sightings.map(([p, pl, m, s]) => [p, pl, ts(m), s]),
    },
    {
      name: T.statements,
      columns: ['person_id', 'claimed_place', 'claimed_from', 'claimed_to', 'recorded_at'],
      ddl: `statement_id serial primary key, person_id int not null references {S}.${T.people}(person_id), claimed_place text not null, claimed_from timestamp not null, claimed_to timestamp not null, recorded_at timestamp not null`,
      rows: statements.map(([p, pl, a, b, rec]) => [p, pl, ts(a), ts(b), ts(rec)]),
    },
    {
      name: T.handling,
      columns: ['item_name', 'action', 'person_id', 'handled_at', 'note'],
      ddl: `entry_id serial primary key, item_name text not null, action text not null, person_id int not null references {S}.${T.people}(person_id), handled_at timestamp not null, note text`,
      rows: handling.map(([it, a, p, m, n]) => [it, a, p + 1, ts(m), n]),
    },
    {
      name: T.messages,
      columns: ['sender_id', 'receiver_id', 'sent_at', 'body'],
      ddl: `msg_id serial primary key, sender_id int not null references {S}.${T.people}(person_id), receiver_id int not null references {S}.${T.people}(person_id), sent_at timestamp not null, body text not null`,
      rows: msgs.map(([s, rcv, m, body]) => [s + 1, rcv + 1, ts(m), body]),
    },
  ];

  // ---- answers derived from the data
  const wS = `'${ts(winStart)}'`;
  const wE = `'${ts(winEnd)}'`;
  const inArea = `select person_id from ${T.sightings} where place = '${area}' and seen_at between ${wS} and ${wE}`;
  const liars = `select s.person_id from ${T.statements} s join ${T.sightings} g on g.person_id = s.person_id
                  where s.claimed_place <> '${area}' and g.place = '${area}' and g.seen_at between s.claimed_from and s.claimed_to`;
  const inWindow = sightings.filter((s) => s[1] === area && s[2] >= winStart && s[2] <= winEnd);
  const inCount = new Set(inWindow.map((s) => s[0])).size;
  const lastSeen = Math.max(...inWindow.map((s) => s[2]));
  const liarCount = statements.filter((st) => st[1] !== area && inWindow.some((s) => s[0] === st[0])).length;
  const threatCount = msgs.filter((m) => m[0] === 0 && m[1] === 1).length;

  const questions = {
    count: {
      title: 'WHO WAS INSIDE', kind: 'ACCESS', difficulty: 'easy', type: 'NUMBER',
      label: `{value} people were seen inside the ${areaWords} during the interval`,
      prompt: `How many different people were seen at the ${areaWords} (place ${area}) between ${hhmm(winStart)} and ${hhmm(winEnd)}, inclusive?`,
      answer: String(inCount), concept: 'filter by place and time, then count each person once',
      sql: `select count(distinct person_id) from ${T.sightings} where place = '${area}' and seen_at between ${wS} and ${wE}`,
      lastHint: `In the Evidence Browser open ${T.sightings}, filter place equal to ${area}, sort by seen_at, and count each person only once (different sources can see the same person).`,
    },
    last: {
      title: 'LAST SEEN', kind: 'TIME', difficulty: 'medium', type: 'TIME',
      label: `The last person was seen in the ${areaWords} at {value}`,
      prompt: `At what time was the last sighting at the ${areaWords} (place ${area}) at or before ${hhmm(winEnd)}?`,
      answer: hhmm(lastSeen), concept: 'sort by time and read the latest',
      sql: `select to_char(max(seen_at), 'HH24:MI') from ${T.sightings} where place = '${area}' and seen_at <= ${wE}`,
      lastHint: `Filter ${T.sightings} to place ${area}, sort seen_at from newest to oldest, and ignore anything after ${hhmm(winEnd)}.`,
    },
    alibis: {
      title: 'ALIBI CHECK', kind: 'ACCESS', difficulty: 'hard', type: 'NUMBER',
      label: `{value} people said they were somewhere else but were seen in the ${areaWords}`,
      prompt: `Each statement says where a person claimed to be from ${hhmm(winStart)} to ${hhmm(winEnd)}. How many people claimed to be somewhere OTHER than ${area} yet were seen at ${area} in that time?`,
      answer: String(liarCount), concept: 'compare what each person said with where they were seen',
      sql: `select count(distinct s.person_id) from ${T.statements} s join ${T.sightings} g on g.person_id = s.person_id
              where s.claimed_place <> '${area}' and g.place = '${area}' and g.seen_at between s.claimed_from and s.claimed_to`,
      lastHint: `List everyone seen at ${area} in the window (from ${T.sightings}). Then open ${T.statements} and mark each of them whose claimed_place is not ${area}.`,
    },
    thin: {
      title: 'THE THIN ALIBI', kind: 'PERSON', difficulty: 'medium', type: 'SINGLE_CHARACTER',
      label: `Seen in the ${areaWords} by a single source only: {value}`,
      prompt: `Of the people who claimed to be elsewhere but were seen at ${area} in the window, exactly one was seen there by only ONE kind of source (CCTV, BADGE or GUARD). Who?`,
      answer: outsider.name, concept: 'compare how many different sources saw each person',
      sql: `select p.name from ${T.people} p where p.person_id in (${liars}) and p.person_id in (
              select person_id from ${T.sightings} where place = '${area}' and seen_at between ${wS} and ${wE} group by person_id having count(distinct source) = 1)`,
      lastHint: `Take the people who lied about being elsewhere. For each, count the DIFFERENT sources (CCTV, BADGE, GUARD) that saw them at ${area}. Exactly one has a single source.`,
    },
    lot: {
      title: 'BATCH CODE TRACE', kind: 'OBJECT', difficulty: 'hard', type: 'TEXT',
      label: `Refill batch code: {value}`,
      prompt: `What batch code was written down when the ${item} was refilled after it was inspected? (format: ABC-123)`,
      answer: lotB, concept: 'filter by item and action, then read the note',
      sql: `select substring(note from '[0-9A-Z]{3}-[0-9]{3}') from ${T.handling} where item_name = '${qi}' and action = 'REFILLED'`,
      lastHint: `Open ${T.handling}, filter item_name to the ${item} and action to REFILLED, then read the code at the end of the note.`,
    },
    errand: {
      title: 'THE ERRAND', kind: 'TIME', difficulty: 'medium', type: 'TIME',
      label: `${inspector.name} sent ${outsider.name} to the ${areaWords} at {value}`,
      prompt: `At what time did ${inspector.name} message ${outsider.name} asking them to go to the ${areaWords}?`,
      answer: hhmm(winStart - 6), concept: 'filter messages by sender and receiver',
      sql: `select to_char(m.sent_at, 'HH24:MI') from ${T.messages} m join ${T.people} s on s.person_id = m.sender_id join ${T.people} r on r.person_id = m.receiver_id where s.name = '${inspector.name}' and r.name = '${outsider.name}'`,
      lastHint: `In ${T.messages}, find the message whose sender is ${inspector.name} and whose receiver is ${outsider.name}. Use the ${T.people} table to match ids to names.`,
    },
    threats: {
      title: 'THREAT COUNT', kind: 'MESSAGE', difficulty: 'medium', type: 'NUMBER',
      label: `{value} messages sent to ${culprit.name}`,
      prompt: `How many messages did ${victim.name} send to ${culprit.name} in total?`,
      answer: String(threatCount), concept: 'filter messages by sender and receiver, then count',
      sql: `select count(*) from ${T.messages} m join ${T.people} s on s.person_id = m.sender_id join ${T.people} r on r.person_id = m.receiver_id where s.name = '${victim.name}' and r.name = '${culprit.name}'`,
      lastHint: `Match ids to names in ${T.people}, then filter ${T.messages} to sender ${victim.name} and receiver ${culprit.name} and count the rows.`,
    },
    final: {
      title: 'THE FINAL CONVERGENCE', kind: 'MOTIVE', difficulty: 'hard', type: 'SINGLE_CHARACTER',
      label: `Alibi, sightings, handling and threats all point to {value}`,
      prompt: `Exactly one person (a) said they were elsewhere but was seen at ${area} in the window, (b) was seen there by at least two different kinds of source, (c) handled the ${item} AFTER the ${hhmm(I)} inspection, and (d) received a message from ${victim.name} before ${hhmm(winEnd - 5)}. Who?`,
      answer: culprit.name, concept: 'combine four separate facts until only one person remains',
      sql: `select p.name from ${T.people} p
              where p.person_id in (${liars})
                and p.person_id in (select person_id from ${T.sightings} where place = '${area}' and seen_at between ${wS} and ${wE} group by person_id having count(distinct source) >= 2)
                and p.person_id in (select person_id from ${T.handling} where item_name = '${qi}' and handled_at > '${ts(I)}')
                and p.person_id in (select receiver_id from ${T.messages} where sender_id = 1 and sent_at < '${ts(winEnd - 5)}')`,
      lastHint: 'Write down who passes each of the four tests, one table at a time. Strike out everyone who fails any of them; one name is left.',
    },
  };
  const withHints = (base) => (q) => ({ ...q, hints: hintsFor(base, q) });

  const code2 = `LOG${String(ordinal).padStart(2, '0')}`;
  const base = {
    slug: theme.slug,
    code: code2,
    track: 'LOGIC',
    title: theme.title,
    hook: theme.hook,
    targetMinutes: 18,
    victimName: victim.name,
    culpritName: culprit.name,
    tables,
  };
  const h = withHints(base);

  const threads = [
    {
      key: 't1a', phase: 1, position: 1, required: true, prerequisite: null, subject: null,
      title: `Who was inside the ${areaWords}?`,
      intro: `The people list and the sighting records are open. Work out who was actually in the ${areaWords} during the interval.`,
      outcomeType: 'COMPLETED',
      outcomeText: `The sightings fix who was inside the ${areaWords} during the interval, and who was seen there last.`,
      questions: [h(questions.count), h(questions.last)],
    },
    {
      key: 't1b', phase: 1, position: 2, required: true, prerequisite: 't1a', subject: null,
      title: 'Do the statements hold up?',
      intro: 'Everyone gave a statement about where they were. The statements are now open. Check them against the sightings.',
      outcomeType: 'LEAD_DISCOVERED',
      outcomeText: 'Not everybody told the truth about where they were. Some statements do not survive the sightings.',
      unlocks: [{ table: T.statements, when: 'available' }],
      questions: [h(questions.alibis)],
    },
    {
      key: 't2a', phase: 2, position: 1, required: true, prerequisite: null, subject: outsider.name,
      title: 'The thinnest alibi',
      intro: 'Several people lied. Who has the weakest evidence against them?',
      outcomeType: 'REMAINS_PERSON_OF_INTEREST',
      outcomeText: `${outsider.name} lied about being elsewhere, but only a single guard saw them in the ${areaWords}. They stay a person of interest until their reason is known.`,
      questions: [h(questions.thin)],
    },
    {
      key: 't2b', phase: 2, position: 2, required: true, prerequisite: null, subject: null,
      title: `The ${item}: what was done to it?`,
      intro: `The handling record for the ${item} is now open.`,
      outcomeType: 'LEAD_DISCOVERED',
      outcomeText: `The ${item} was refilled from batch ${lotB} after ${inspector.name} had inspected and cleared it. Somebody changed what was in it.`,
      unlocks: [{ table: T.handling, when: 'available' }],
      questions: [h(questions.lot)],
    },
    {
      key: 't2c', phase: 2, position: 3, required: false, prerequisite: 't2a', subject: outsider.name,
      title: `Why was ${outsider.name} there?`,
      intro: 'An optional lead. The messages may explain the visit.',
      outcomeType: 'CLEARED',
      outcomeText: `${inspector.name} had sent ${outsider.name} into the ${areaWords} on an errand. ${outsider.name} was embarrassed to admit it, but is no longer a suspect.`,
      unlocks: [{ table: T.messages, when: 'available' }],
      questions: [h(questions.errand)],
    },
    {
      key: 't3a', phase: 3, position: 1, required: true, prerequisite: null, subject: null,
      title: `${victim.name}'s messages`,
      intro: "The victim's phone was recovered. Their messages are open to you.",
      outcomeType: 'LEAD_DISCOVERED',
      outcomeText: `${victim.name} had been pressing someone hard. The messages show how often, and what was at stake.`,
      unlocks: [{ table: T.messages, when: 'available' }],
      questions: [h(questions.threats)],
    },
    {
      key: 't3b', phase: 3, position: 2, required: true, prerequisite: 't3a', subject: null,
      title: 'Put it all together',
      intro: 'Statements, sightings, handling and threats. Only one person survives all four tests.',
      outcomeType: 'COMPLETED',
      outcomeText: 'A false alibi, solid sightings, the item handled after the check, and the target of the threats: every piece converges on one person.',
      questions: [h(questions.final)],
    },
  ];

  const story = threads.map((t) => ({
    thread: t.key,
    title: t.title,
    body: t.questions.map((x) => fill(x.label, x.answer)).join('. ') + '. ' + t.outcomeText,
  }));

  const finalOptions = arrangeOptions(
    theme.slug,
    `${culprit.name} lied about their whereabouts, stayed in the ${areaWords} after ${inspector.name}'s ${hhmm(I)} inspection and swapped in a different batch (${lotB}).`,
    [
      `${outsider.name} slipped into the ${areaWords} and tampered with the ${item} before the inspection, then lied to hide it.`,
      `${inspector.name} tampered with the ${item} while inspecting it, then signed it off as clean.`,
      `Nobody tampered with the ${item}: it was faulty from the start, and the lies in the statements are only embarrassment.`,
    ],
  );

  return {
    ...base,
    rosterNames: P.slice(1).map((p) => p.name),
    rosterRoles: Object.fromEntries(P.slice(1).map((p) => [p.name, p.role])),
    solution: {
      motive: theme.motive,
      method: `During the interval ${culprit.name} claimed to be at ${pl1} but was seen in the ${areaWords}, stayed inside after ${inspector.name}'s ${hhmm(I)} inspection and, at ${hhmm(modifiedAt)}, refilled the ${item} from a different batch (${lotB}).`,
      chain: [
        `${culprit.name} said they were at ${pl1}, but CCTV and the badge system both placed them in the ${areaWords}, and they were the last person seen there, at ${hhmm(lastSeen)}.`,
        `The ${item} was refilled at ${hhmm(modifiedAt)} from batch ${lotB}, after it had been inspected and cleared at ${hhmm(I)}.`,
        `${victim.name} had messaged ${culprit.name} ${threatCount} times about it before the interval.`,
        `${outsider.name} lied too, but only to hide an errand ${inspector.name} had asked for; ${herring1.name} and the others were cleared.`,
      ],
    },
    phases: [
      { clue: theme.clues[0], tables: [T.people, T.sightings] },
      { clue: theme.clues[1], tables: [] },
      { clue: theme.clues[2], tables: [] },
    ],
    threads,
    story,
    finalOptions,
    finalPoints: { culprit: 12, mechanism: 8 },
    meta: { area: areaWords, item, inspector: inspector.name, lot: lotB },
    _liarsSql: liars, // exposed for tests
    _inArea: inArea,
  };
}
