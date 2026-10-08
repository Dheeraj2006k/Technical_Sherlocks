// Skeleton A ("restricted area + custody log + messages"): builds a full case definition from a theme.
// All answers are DERIVED from the generated rows (never typed in by hand) and every task ships a
// reference SQL query; engine.verifyDefinition() proves the answers are unique. Times and codes are
// randomized from a seed, so each theme has its own numbers.
//
// Theme shape (see themes.mjs):
//   { slug, title, hook, date, seed, tables:{roster,access,custody,messages}, item, area, wing, doors[],
//     timeline:{ intervalStart:'HH:MM' }, itemWords:{ ... }, clues:[3], people:[14 x {name, role, dept}] }
// People order is fixed: 0 victim, 1 culprit, 2 inspector, 3 outsider (works in a different department
// but entered the restricted area), 4 red herring (entered, cleared), 5 and 6 red herrings (wing visitors,
// motives), 7..13 bystanders.

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
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const CODE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function buildSkeletonA(theme) {
  const r = rng(theme.seed);
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive
  const T = theme.tables;
  const D = theme.date;
  const ts = (mins) => `${D} ${hhmm(mins)}:00`;

  const P = theme.people.map((p) => ({ ...p })); // [{ name, role, dept }]; extras below may get a department override
  if (P.length !== 14) throw new Error(`${theme.slug}: need 14 people`);
  const [victim, culprit, inspector, outsider, herring1] = P; // 5/6 are red herrings used only via their messages and wing visits
  const depts = new Set([culprit.dept, inspector.dept, herring1.dept, outsider.dept]);
  if (depts.size !== 4) throw new Error(`${theme.slug}: culprit/inspector/herring1/outsider departments must differ`);
  const badge = (i) => `B${101 + i}`;

  // ---- timeline (minutes since midnight)
  const winStart = toMin(theme.timeline.intervalStart);
  const winEnd = winStart + 20;
  const I = winStart + 15; // official inspection
  const outsiderIn = winStart + ri(1, 3);
  const outsiderOut = outsiderIn + ri(2, 4);
  const herring1In = winStart + ri(3, 5);
  const herring1Out = herring1In + ri(3, 5);
  const culpritIn = winStart + ri(5, 8);
  const culpritOut = I + ri(2, 4); // stays AFTER the inspection
  const inspectorIn = I - ri(1, 3);
  const inspectorOut = I;
  const modifiedAt = I + ri(1, 2); // culprit tampers right after the inspection, while still inside
  const returnedAt = outsiderIn + 1;
  const takenAt = I + ri(9, 12);
  const usedAt = takenAt + ri(18, 24);

  // extra entrants (bystanders who work in the inspector's department), extra custody rows and extra threats
  // vary the numeric answers from case to case so answers cannot be shared between teams on different cases
  const extraEntrants = ri(0, 2);
  const extraCustody = ri(0, 2);
  const extraThreats = ri(0, 2);
  const extras = Array.from({ length: extraEntrants }, (_, k) => {
    const idx = 7 + k;
    P[idx].dept = inspector.dept;
    const inn = winStart + ri(2, 12);
    return { idx, inn, out: inn + ri(2, 4) };
  });

  const code = (n) => Array.from({ length: n }, () => CODE_CHARS[ri(0, CODE_CHARS.length - 1)]);
  const lotA = `${code(3).join('')}-${ri(100, 999)}`;
  let lotB = `${code(3).join('')}-${ri(100, 999)}`;
  while (lotB === lotA) lotB = `${code(3).join('')}-${ri(100, 999)}`;

  // ---- access log rows [badge, door, dir, mins]
  const access = [];
  const A = theme.area;
  const arrive = (i, m) => access.push([badge(i), theme.doors[0], 'IN', m]);
  const early = winStart - 200;
  [6, 2, 1, 12, 8, 9, 0, 10, 11, 4, 3, 5, 7].forEach((i, k) => arrive(i, early + k * 4 + ri(0, 3))); // arrivals; victim included
  access.push([badge(13), theme.doors[1], 'IN', winStart - 95]); // the guest/critic-type enters elsewhere
  // earlier shifts in the restricted area (outside the window)
  access.push([badge(1), A, 'IN', early - 10], [badge(1), A, 'OUT', early + 6]);
  access.push([badge(2), A, 'IN', early + 8], [badge(2), A, 'OUT', early + 18]);
  access.push([badge(3), A, 'IN', early + 24], [badge(3), A, 'OUT', early + 32]);
  access.push([badge(1), A, 'IN', winStart - 105], [badge(1), A, 'OUT', winStart - 90]);
  access.push([badge(3), A, 'IN', winStart - 80], [badge(3), A, 'OUT', winStart - 75]);
  // window: the four entrants
  access.push([badge(3), A, 'IN', outsiderIn], [badge(3), A, 'OUT', outsiderOut]);
  access.push([badge(4), A, 'IN', herring1In], [badge(4), A, 'OUT', herring1Out]);
  access.push([badge(1), A, 'IN', culpritIn], [badge(1), A, 'OUT', culpritOut]);
  access.push([badge(2), A, 'IN', inspectorIn], [badge(2), A, 'OUT', inspectorOut]);
  for (const e of extras) access.push([badge(e.idx), A, 'IN', e.inn], [badge(e.idx), A, 'OUT', e.out]);
  // after the window
  access.push([badge(3), A, 'IN', winEnd + 5], [badge(3), A, 'OUT', winEnd + 7]);
  // the wing (herring visitors) around the window + earlier
  const wing = theme.wing;
  access.push([badge(0), wing, 'IN', winStart + 1], [badge(5), wing, 'IN', winStart + 2], [badge(6), wing, 'IN', winStart + 10]);
  access.push([badge(5), wing, 'OUT', winStart + 13], [badge(6), wing, 'OUT', winStart + 16], [badge(0), wing, 'OUT', winEnd + 3]);
  access.push([badge(0), wing, 'IN', early + 2], [badge(0), wing, 'OUT', early + 100]);
  access.push([badge(7), theme.doors[2], 'IN', early + 30], [badge(8), theme.doors[2], 'IN', early + 33]);
  access.push([badge(9), theme.doors[3], 'IN', early + 40], [badge(10), theme.doors[3], 'IN', early + 45]);
  access.push([badge(11), theme.doors[1], 'IN', early + 50], [badge(12), theme.doors[1], 'OUT', winEnd + 25]);
  access.sort((a, b) => a[3] - b[3]);

  // ---- custody log rows [item, action, badge, mins, note]
  const item = theme.item;
  const custody = [
    [item, 'CHECKED_IN', badge(1), early - 8, theme.itemWords.checkedIn],
    [item, 'FILLED', badge(1), winStart - 100, `${theme.itemWords.filled} ${lotA}`],
    [item, 'RETURNED_TO_SHELF', badge(3), returnedAt, theme.itemWords.returned],
    [item, 'INSPECTED', badge(2), I, theme.itemWords.inspected],
    [item, 'REFILLED', badge(1), modifiedAt, `${theme.itemWords.refilled} ${lotB}`],
    [item, 'TAKEN_TO_STAGE', badge(3), takenAt, theme.itemWords.taken],
    [item, 'USED_ON_STAGE', badge(0), usedAt, theme.itemWords.used],
  ];
  for (let k = 0; k < extraCustody; k++) {
    custody.push([item, k === 0 ? 'MOVED_ASIDE' : 'WIPED_DOWN', badge(3), winStart + ri(3, 12), 'Routine handling']);
  }
  theme.otherItems.forEach((o, k) => {
    custody.push([o, 'CHECKED_IN', badge(1), early - 6 + k * 2, 'Logged and tested']);
    custody.push([o, 'TAKEN_TO_STAGE', badge(3), winStart - 70 + k, 'Moved into position']);
    if (k % 2 === 0) custody.push([o, 'INSPECTED', badge(2), early + 12 + k, 'Walk-through']);
  });
  custody.sort((a, b) => a[3] - b[3]);

  // ---- messages [senderIdx, receiverIdx, mins, body]
  const firstThreat = ri(17 * 60 + 30, 19 * 60); // 17:30-19:00
  const secondThreat = winStart - ri(10, 18);
  const msgs = [
    [0, 1, firstThreat, theme.messages.threat1],
    [1, 0, firstThreat + ri(5, 12), theme.messages.plea],
    [0, 1, secondThreat, theme.messages.threat2],
    ...Array.from({ length: extraThreats }, (_, k) => [0, 1, firstThreat + 15 + k * 7 + ri(0, 3), 'Still waiting for your answer.']),
    [2, 4, winStart - 6, theme.messages.errand],
    [4, 2, winStart - 5, 'On it!'],
    [4, 0, winStart - 2, theme.messages.herring1Wish],
    [5, 0, secondThreat - 10, theme.messages.herring2Row],
    [6, 0, winStart + 7, theme.messages.herring3Money],
    [1, 0, modifiedAt - 1 + (modifiedAt - 1 < I ? 1 : 0), theme.messages.culpritReady],
    [7, 8, early + 20, theme.messages.chatter[0]],
    [9, 10, early + 60, theme.messages.chatter[1]],
    [11, 2, early + 80, theme.messages.chatter[2]],
    [12, 13, winStart - 60, theme.messages.chatter[3]],
    [13, 9, usedAt + 18, theme.messages.aftermath],
  ];
  msgs.sort((a, b) => a[2] - b[2]);

  // ---- tables
  const tables = [
    {
      name: T.roster,
      columns: ['id', 'name', 'role', 'department', 'badge_id'],
      ddl: 'id int primary key, name text not null, role text not null, department text not null, badge_id text not null unique',
      rows: P.map((p, i) => [i + 1, p.name, p.role, p.dept, badge(i)]),
    },
    {
      name: T.access,
      columns: ['badge_id', 'door', 'direction', 'logged_at'],
      ddl: "log_id serial primary key, badge_id text not null, door text not null, direction text not null check (direction in ('IN','OUT')), logged_at timestamp not null",
      rows: access.map(([b, d, dir, m]) => [b, d, dir, ts(m)]),
    },
    {
      name: T.custody,
      columns: ['item_name', 'action', 'badge_id', 'handled_at', 'note'],
      ddl: 'entry_id serial primary key, item_name text not null, action text not null, badge_id text not null, handled_at timestamp not null, note text',
      rows: custody.map(([it, a, b, m, n]) => [it, a, b, ts(m), n]),
    },
    {
      name: T.messages,
      columns: ['sender_id', 'receiver_id', 'sent_at', 'body'],
      ddl: `msg_id serial primary key, sender_id int not null references ${'{S}'}.${T.roster}(id), receiver_id int not null references ${'{S}'}.${T.roster}(id), sent_at timestamp not null, body text not null`,
      rows: msgs.map(([s, rcv, m, body]) => [s + 1, rcv + 1, ts(m), body]),
    },
  ];

  // ---- answers derived from the data and the matching reference SQL
  const wS = `'${ts(winStart)}'`;
  const wE = `'${ts(winEnd)}'`;
  const insideDirect = `select distinct badge_id from ${T.access} where door = '${A}' and direction = 'IN' and logged_at between ${wS} and ${wE}`;
  const lastOut = Math.max(outsiderOut, herring1Out, culpritOut, inspectorOut, ...extras.map((e) => e.out));
  const entrants = new Set(access.filter((a) => a[1] === A && a[2] === 'IN' && a[3] >= winStart && a[3] <= winEnd).map((a) => a[0])).size;
  const threatCount = msgs.filter((m) => m[0] === 0 && m[1] === 1).length;
  const takenMinutes = `(select handled_at from ${T.custody} where item_name = '${item}' and action = 'TAKEN_TO_STAGE')`;
  const handledWindow = custody.filter((c) => c[0] === item && c[3] >= winStart && c[3] <= winEnd).length;
  const lastBeforeTaken = Math.max(...custody.filter((c) => c[0] === item && c[3] < takenAt).map((c) => c[3]));

  const tasks = [
    {
      phase: 1, difficulty: 'easy', type: 'NUMBER', title: 'ACCESS LOG ANALYSIS', kind: 'ACCESS', label: `{value} people entered the ${A} during the interval`,
      prompt: `How many different people badged IN to the ${A} during the interval (${hhmm(winStart)} to ${hhmm(winEnd)}, inclusive)?`,
      answer: String(entrants), concept: 'COUNT DISTINCT, BETWEEN',
      sql: `select count(distinct badge_id) from ${T.access} where door = '${A}' and direction = 'IN' and logged_at between ${wS} and ${wE}`,
    },
    {
      phase: 1, difficulty: 'medium', type: 'TIME', title: 'EXIT TIMELINE', kind: 'TIME', label: `Last exit from the ${A} before the interval ended: {value}`,
      prompt: `At what time did the last person badge OUT of the ${A} at or before ${hhmm(winEnd)}?`,
      answer: hhmm(lastOut), concept: 'MAX, WHERE',
      sql: `select to_char(max(logged_at), 'HH24:MI') from ${T.access} where door = '${A}' and direction = 'OUT' and logged_at <= ${wE}`,
    },
    {
      phase: 1, difficulty: 'hard', type: 'SINGLE_CHARACTER', title: 'DEPARTMENT CROSS-CHECK', kind: 'PERSON', label: `Out-of-department entrant: {value}`,
      prompt: `Of the people who badged IN to the ${A} during the interval, exactly one works in a department other than ${herring1.dept}, ${culprit.dept} or ${inspector.dept}. Who?`,
      answer: outsider.name, concept: 'JOIN, NOT IN',
      sql: `select r.name from ${T.roster} r join (${insideDirect}) a on a.badge_id = r.badge_id where r.department not in ('${herring1.dept}', '${culprit.dept}', '${inspector.dept}')`,
    },
    {
      phase: 2, difficulty: 'easy', type: 'NUMBER', title: 'CUSTODY CHAIN', kind: 'OBJECT', label: `{value} handling entries on the ${item} during the interval`,
      prompt: `How many entries in the ${theme.custodyLabel} concern the ${item} during the interval (${hhmm(winStart)} to ${hhmm(winEnd)}, inclusive)?`,
      answer: String(handledWindow), concept: 'COUNT, BETWEEN',
      sql: `select count(*) from ${T.custody} where item_name = '${item}' and handled_at between ${wS} and ${wE}`,
    },
    {
      phase: 2, difficulty: 'medium', type: 'TIME', title: 'LAST HANDLING', kind: 'TIME', label: `The ${item} was last handled at {value} before reaching the stage`,
      prompt: `At what time was the ${item} last handled before it was taken to the stage?`,
      answer: hhmm(lastBeforeTaken), concept: 'subquery, MAX',
      sql: `select to_char(max(handled_at), 'HH24:MI') from ${T.custody} where item_name = '${item}' and handled_at < ${takenMinutes}`,
    },
    {
      phase: 2, difficulty: 'hard', type: 'TEXT', title: 'LOT CODE TRACE', kind: 'OBJECT', label: `Refill batch code: {value}`,
      prompt: `What was the lot code used when the ${item} was refilled after it was inspected? (format: ABC-123)`,
      answer: lotB, concept: 'filtering, reading text',
      sql: `select substring(note from '[0-9A-Z]{3}-[0-9]{3}') from ${T.custody} where item_name = '${item}' and action = 'REFILLED'`,
    },
    {
      phase: 3, difficulty: 'easy', type: 'TIME', title: 'FIRST CONTACT', kind: 'MESSAGE', label: `First threat sent at {value}`,
      prompt: `At what time did ${victim.name} send the first message to ${culprit.name}?`,
      answer: hhmm(firstThreat), concept: 'JOIN, MIN',
      sql: `select to_char(min(m.sent_at), 'HH24:MI') from ${T.messages} m join ${T.roster} s on s.id = m.sender_id join ${T.roster} r on r.id = m.receiver_id where s.name = '${victim.name}' and r.name = '${culprit.name}'`,
    },
    {
      phase: 3, difficulty: 'medium', type: 'NUMBER', title: 'THREAT COUNT', kind: 'MESSAGE', label: `{value} threatening messages sent to ${culprit.name}`,
      prompt: `How many messages did ${victim.name} send to ${culprit.name} in total?`,
      answer: String(threatCount), concept: 'JOIN, COUNT',
      sql: `select count(*) from ${T.messages} m join ${T.roster} s on s.id = m.sender_id join ${T.roster} r on r.id = m.receiver_id where s.name = '${victim.name}' and r.name = '${culprit.name}'`,
    },
    {
      phase: 3, difficulty: 'hard', type: 'SINGLE_CHARACTER', title: 'THE FINAL INTERSECTION', kind: 'MOTIVE', label: `Location, handling and threats all point to {value}`,
      prompt: `Exactly one person (a) badged IN to the ${A} during the interval, (b) handled the ${item} AFTER the ${hhmm(I)} inspection, and (c) received a message from ${victim.name} before ${hhmm(winEnd - 5)}. Who?`,
      answer: culprit.name, concept: 'CTE / intersection across three tables',
      sql: `select r.name from ${T.roster} r
        where r.badge_id in (${insideDirect})
          and r.badge_id in (select badge_id from ${T.custody} where item_name = '${item}' and handled_at > '${ts(I)}')
          and r.id in (select receiver_id from ${T.messages} where sender_id = 1 and sent_at < '${ts(winEnd - 5)}')`,
    },
  ];

  return {
    slug: theme.slug,
    title: theme.title,
    hook: theme.hook,
    victimName: victim.name,
    culpritName: culprit.name,
    rosterNames: P.slice(1).map((p) => p.name),
    rosterRoles: Object.fromEntries(P.slice(1).map((p) => [p.name, p.role])),
    solution: {
      motive: theme.motive,
      method: `During the interval ${culprit.name} stayed inside the ${A} after ${inspector.name}'s ${hhmm(I)} inspection and, at ${hhmm(modifiedAt)}, altered the ${item} using a different batch (${lotB}).`,
      chain: [
        `${culprit.name} badged into the ${A} during the interval and was the last person out, at ${hhmm(lastOut)}, after the official inspection.`,
        `The ${item} was refilled at ${hhmm(modifiedAt)} from batch ${lotB}, after it had been inspected and cleared at ${hhmm(I)}.`,
        `${victim.name} had threatened ${culprit.name} ${threatCount} times before the interval.`,
        `Only ${culprit.name} matches the location, the handling and the threats together; ${outsider.name}, ${herring1.name} and the others were cleared.`,
      ],
    },
    tables,
    phases: [
      { clue: theme.clues[0], tables: [T.roster, T.access] },
      { clue: theme.clues[1], tables: [T.custody] },
      { clue: theme.clues[2], tables: [T.messages] },
    ],
    tasks,
  };
}
