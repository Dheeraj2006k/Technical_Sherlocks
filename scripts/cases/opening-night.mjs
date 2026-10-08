// Case 1: OPENING NIGHT (reference case). Authored against PRD section 9.
//
// SETTING   Grand Meridian Theatre, opening night of Macbeth, 2025-03-14.
// CRIME     Leonard Voss (lead actor) is poisoned by the wine in his prop chalice (collapses 21:32).
// CULPRIT   Marcus Bell, prop master.  MOTIVE  Leonard discovered Marcus had been selling antique
//           props and threatened to tell the director after the show.
// METHOD    During the intermission (20:45-21:05) Marcus stayed in the locked prop room after the
//           stage manager's 21:00 inspection and "topped up" the chalice from a different bottle.
// RED HERRINGS  Diana Frost (loud contract row, in the dressing wing), Oscar Lin (money Leonard
//           owed the production, visited the wing), Priya Nair (understudy who entered the prop
//           room; the stage manager asked her to fetch a cue sheet).
//
// Tables (schema case_<slug>): cast_crew, access_log (P1) | prop_handling_log (P2) | text_messages (P3)
// Every task is solvable with only the tables unlocked at that phase. verify-case.mjs / the test
// suite run the reference SQL below against the real data to prove each answer is unique.
import { installCase, removeCaseFully } from './engine.mjs';

const D = '2025-03-14';
const t = (hhmm) => `${D} ${hhmm}:00`;

// id, name, role, department, badge_id, in_roster (can be the culprit)
const PEOPLE = [
  [1, 'Leonard Voss', 'Lead Actor (Macbeth)', 'Cast', 'B101', false],
  [2, 'Diana Frost', 'Lead Actress (Lady Macbeth)', 'Cast', 'B102', true],
  [3, 'Oscar Lin', 'Director', 'Management', 'B103', true],
  [4, 'Marcus Bell', 'Prop Master', 'Props', 'B104', true],
  [5, 'Priya Nair', 'Understudy', 'Cast', 'B105', true],
  [6, 'Helena Ross', 'Stage Manager', 'Stage Management', 'B106', true],
  [7, 'Tomas Quill', 'Lighting Designer', 'Technical', 'B107', true],
  [8, 'Greta Holm', 'Costume Designer', 'Wardrobe', 'B108', true],
  [9, 'Felix Armitage', 'Producer and Owner', 'Management', 'B109', true],
  [10, 'Nina Castellano', 'Makeup Artist', 'Wardrobe', 'B110', true],
  [11, 'Jonah Pike', 'Stagehand', 'Stage Crew', 'B111', true],
  [12, 'Ruth Abbott', 'House Manager', 'Front of House', 'B112', true],
  [13, 'Samir Doshi', 'Sound Engineer', 'Technical', 'B113', true],
  [14, 'Wendell Marsh', 'Theatre Critic', 'Guest', 'B114', true],
];

// badge, door, direction, time
const ACCESS = [
  ['B106', 'STAGE_DOOR', 'IN', '16:30'], ['B111', 'STAGE_DOOR', 'IN', '16:45'], ['B104', 'STAGE_DOOR', 'IN', '17:00'],
  ['B113', 'STAGE_DOOR', 'IN', '17:05'], ['B107', 'STAGE_DOOR', 'IN', '17:10'], ['B108', 'STAGE_DOOR', 'IN', '17:20'],
  ['B101', 'STAGE_DOOR', 'IN', '17:30'], ['B102', 'STAGE_DOOR', 'IN', '17:35'], ['B110', 'STAGE_DOOR', 'IN', '17:40'],
  ['B105', 'STAGE_DOOR', 'IN', '17:45'], ['B103', 'STAGE_DOOR', 'IN', '17:50'], ['B112', 'STAGE_DOOR', 'IN', '18:00'],
  ['B109', 'STAGE_DOOR', 'IN', '18:30'], ['B114', 'LOBBY', 'IN', '19:10'], ['B112', 'LOBBY', 'IN', '18:05'],
  ['B109', 'LOBBY', 'IN', '19:00'], ['B109', 'LOBBY', 'OUT', '19:25'],
  ['B107', 'CONTROL_BOOTH', 'IN', '17:30'], ['B113', 'CONTROL_BOOTH', 'IN', '17:35'],
  // prop room, before the interval
  ['B104', 'PROP_ROOM', 'IN', '17:05'], ['B104', 'PROP_ROOM', 'OUT', '17:20'],
  ['B106', 'PROP_ROOM', 'IN', '17:15'], ['B106', 'PROP_ROOM', 'OUT', '17:25'],
  ['B111', 'PROP_ROOM', 'IN', '17:30'], ['B111', 'PROP_ROOM', 'OUT', '17:40'],
  ['B104', 'PROP_ROOM', 'IN', '19:00'], ['B104', 'PROP_ROOM', 'OUT', '19:15'],
  ['B111', 'PROP_ROOM', 'IN', '19:20'], ['B111', 'PROP_ROOM', 'OUT', '19:25'],
  // prop room, intermission 20:45-21:05
  ['B111', 'PROP_ROOM', 'IN', '20:47'], ['B111', 'PROP_ROOM', 'OUT', '20:50'],
  ['B105', 'PROP_ROOM', 'IN', '20:49'], ['B105', 'PROP_ROOM', 'OUT', '20:53'],
  ['B104', 'PROP_ROOM', 'IN', '20:51'], ['B104', 'PROP_ROOM', 'OUT', '21:03'],
  ['B106', 'PROP_ROOM', 'IN', '20:58'], ['B106', 'PROP_ROOM', 'OUT', '21:00'],
  ['B111', 'PROP_ROOM', 'IN', '21:10'], ['B111', 'PROP_ROOM', 'OUT', '21:12'],
  // dressing wing
  ['B108', 'DRESSING_WING', 'IN', '17:25'], ['B108', 'DRESSING_WING', 'OUT', '17:50'],
  ['B101', 'DRESSING_WING', 'IN', '17:32'], ['B101', 'DRESSING_WING', 'OUT', '19:20'],
  ['B102', 'DRESSING_WING', 'IN', '17:36'], ['B102', 'DRESSING_WING', 'OUT', '19:25'],
  ['B110', 'DRESSING_WING', 'IN', '17:45'], ['B110', 'DRESSING_WING', 'OUT', '19:20'],
  ['B101', 'DRESSING_WING', 'IN', '20:46'], ['B102', 'DRESSING_WING', 'IN', '20:47'],
  ['B108', 'DRESSING_WING', 'IN', '20:48'], ['B110', 'DRESSING_WING', 'IN', '20:50'],
  ['B103', 'DRESSING_WING', 'IN', '20:55'], ['B108', 'DRESSING_WING', 'OUT', '20:56'],
  ['B102', 'DRESSING_WING', 'OUT', '20:58'], ['B110', 'DRESSING_WING', 'OUT', '21:00'],
  ['B103', 'DRESSING_WING', 'OUT', '21:01'], ['B101', 'DRESSING_WING', 'OUT', '21:04'],
];

// prop, action, badge, time, note
const PROPS = [
  ['Chalice (Macbeth)', 'CHECKED_IN', 'B104', '17:10', 'Delivered from storage, rim polished'],
  ['Chalice (Macbeth)', 'FILLED', 'B104', '19:05', 'Stage wine, bottle lot 4RT-208'],
  ['Chalice (Macbeth)', 'RETURNED_TO_SHELF', 'B111', '20:48', 'Act 1 complete'],
  ['Chalice (Macbeth)', 'INSPECTED', 'B106', '21:00', 'Seal intact, wine clear'],
  ['Chalice (Macbeth)', 'REFILLED', 'B104', '21:02', 'Topped up from bottle lot 7QX-114'],
  ['Chalice (Macbeth)', 'TAKEN_TO_STAGE', 'B111', '21:11', 'Placed on banquet table'],
  ['Chalice (Macbeth)', 'USED_ON_STAGE', 'B101', '21:32', 'Act 2, banquet scene'],
  ['Dagger (Macbeth)', 'CHECKED_IN', 'B104', '17:12', 'Blade blunted and tested'],
  ['Dagger (Macbeth)', 'TAKEN_TO_STAGE', 'B111', '19:21', 'Left wing, prop table 2'],
  ['Dagger (Macbeth)', 'RETURNED_TO_SHELF', 'B111', '20:49', 'Act 1 complete'],
  ['Crown (Macbeth)', 'CHECKED_IN', 'B104', '17:14', 'Gilt retouched'],
  ['Crown (Macbeth)', 'INSPECTED', 'B106', '17:20', 'Stage manager walk-through'],
  ['Torch (Banquo)', 'CHECKED_IN', 'B104', '17:16', 'Battery replaced'],
  ['Torch (Banquo)', 'TAKEN_TO_STAGE', 'B111', '19:22', 'Stage right'],
];

// sender id, receiver id, time, body
const MESSAGES = [
  [1, 4, '18:42', 'I know about the missing antiques, Marcus. Tell Oscar yourself tonight or I will.'],
  [4, 1, '18:50', 'Please, let me explain after the show.'],
  [8, 10, '19:00', 'Spare wig in wardrobe if Lady M needs it.'],
  [12, 6, '19:15', 'House is full, ready for curtain.'],
  [9, 3, '19:40', 'Critic is in row C. Keep him happy.'],
  [7, 13, '20:10', 'Cue 42 needs a longer fade.'],
  [2, 1, '20:20', 'We need to talk about my contract. This is not over.'],
  [1, 4, '20:30', 'Last chance. After the curtain I am telling Oscar everything.'],
  [6, 5, '20:40', 'At the interval please fetch my cue sheet from the prop room shelf.'],
  [5, 6, '20:41', 'On it!'],
  [5, 1, '20:44', 'Break a leg tonight. Wish it was me out there though!'],
  [3, 1, '20:55', 'My office before Act 2. We need to discuss the money you owe the production.'],
  [4, 1, '21:01', 'Chalice is ready for you. It will be a night to remember.'],
  [14, 9, '21:50', 'Dreadful business. I will stay for the police.'],
];

export const TITLE = 'Opening Night';
export const HOOK =
  'Opening night at the Grand Meridian Theatre. Leonard Voss, star of tonight\'s Macbeth, collapsed on stage at 21:32 and died minutes later. The police say the wine in his prop chalice was poisoned. Somebody backstage did this, and the evidence is sitting in the theatre\'s own records.';

const PHASES = [
  {
    clue: 'The chalice spent the interval (20:45 to 21:05) in the locked prop room. The staff roster and the door badge logs are now open to you. Who could have reached it?',
    tables: ['cast_crew', 'access_log'],
  },
  {
    clue: 'Only a handful of people got into the prop room during the interval. The prop handling log shows who touched the chalice and when, and what went into it.',
    tables: ['prop_handling_log'],
  },
  {
    clue: "Leonard's phone has been recovered. His messages show who was angry with him, and who he had reason to fear. Put the logs, the prop log and the messages together and name the person who fits every piece.",
    tables: ['text_messages'],
  },
];

// Reference SQL (run by the verifier and tests as proof each answer is derivable and unique).
// kind SQL returns one column: the answer (character name for SINGLE_CHARACTER, HH:MM for TIME).
const TASKS = [
  {
    phase: 1, difficulty: 'easy', type: 'NUMBER', title: "ACCESS LOG ANALYSIS", kind: "ACCESS", label: "{value} people entered the prop room during the interval",
    prompt: 'How many different people badged IN to the PROP_ROOM during the interval (20:45 to 21:05, inclusive)?',
    answer: '4', concept: 'COUNT DISTINCT, BETWEEN',
    sql: `select count(distinct badge_id) from access_log where door = 'PROP_ROOM' and direction = 'IN' and logged_at between '${t('20:45')}' and '${t('21:05')}'`,
  },
  {
    phase: 1, difficulty: 'medium', type: 'TIME', title: "EXIT TIMELINE", kind: "TIME", label: "Last exit from the prop room before the interval ended: {value}",
    prompt: 'At what time did the last person badge OUT of the PROP_ROOM at or before 21:05?',
    answer: '21:03', concept: 'MAX, WHERE',
    sql: `select to_char(max(logged_at), 'HH24:MI') from access_log where door = 'PROP_ROOM' and direction = 'OUT' and logged_at <= '${t('21:05')}'`,
  },
  {
    phase: 1, difficulty: 'hard', type: 'SINGLE_CHARACTER', title: "DEPARTMENT CROSS-CHECK", kind: "PERSON", label: "Out-of-department entrant: {value}",
    prompt: 'Of the people who badged IN to the PROP_ROOM during the interval, exactly one works in a department other than Cast, Props or Stage Management. Who?',
    answer: 'Jonah Pike', concept: 'JOIN, NOT IN',
    sql: `select cc.name from cast_crew cc join (select distinct badge_id from access_log where door = 'PROP_ROOM' and direction = 'IN' and logged_at between '${t('20:45')}' and '${t('21:05')}') a on a.badge_id = cc.badge_id where cc.department not in ('Cast', 'Props', 'Stage Management')`,
  },
  {
    phase: 2, difficulty: 'easy', type: 'NUMBER', title: "CUSTODY CHAIN", kind: "OBJECT", label: "{value} handling entries on the chalice during the interval",
    prompt: 'How many entries in the prop handling log concern the Chalice (Macbeth) during the interval (20:45 to 21:05, inclusive)?',
    answer: '3', concept: 'COUNT, LIKE, BETWEEN',
    sql: `select count(*) from prop_handling_log where prop_name like 'Chalice%' and handled_at between '${t('20:45')}' and '${t('21:05')}'`,
  },
  {
    phase: 2, difficulty: 'medium', type: 'TIME', title: "LAST HANDLING", kind: "TIME", label: "The chalice was last handled at {value} before reaching the stage",
    prompt: 'At what time was the chalice last handled before it was taken to the stage?',
    answer: '21:02', concept: 'subquery, MAX',
    sql: `select to_char(max(handled_at), 'HH24:MI') from prop_handling_log where prop_name like 'Chalice%' and handled_at < (select handled_at from prop_handling_log where prop_name like 'Chalice%' and action = 'TAKEN_TO_STAGE')`,
  },
  {
    phase: 2, difficulty: 'hard', type: 'TEXT', title: "LOT CODE TRACE", kind: "OBJECT", label: "Refill batch code: {value}",
    prompt: 'What was the bottle lot code used to refill the chalice after the stage manager inspected it? (format: ABC-123)',
    answer: '7QX-114', concept: 'ORDER BY, reading text, self-comparison',
    sql: `select substring(note from '[0-9A-Z]{3}-[0-9]{3}') from prop_handling_log where prop_name like 'Chalice%' and action = 'REFILLED'`,
  },
  {
    phase: 3, difficulty: 'easy', type: 'TIME', title: "FIRST CONTACT", kind: "MESSAGE", label: "First threat from Leonard sent at {value}",
    prompt: 'At what time did Leonard send his first message to Marcus Bell?',
    answer: '18:42', concept: 'JOIN, MIN',
    sql: `select to_char(min(m.sent_at), 'HH24:MI') from text_messages m join cast_crew s on s.id = m.sender_id join cast_crew r on r.id = m.receiver_id where s.name = 'Leonard Voss' and r.name = 'Marcus Bell'`,
  },
  {
    phase: 3, difficulty: 'medium', type: 'NUMBER', title: "THREAT COUNT", kind: "MESSAGE", label: "{value} threatening messages sent to Marcus Bell",
    prompt: 'How many messages did Leonard send to Marcus Bell in total?',
    answer: '2', concept: 'JOIN, COUNT',
    sql: `select count(*) from text_messages m join cast_crew s on s.id = m.sender_id join cast_crew r on r.id = m.receiver_id where s.name = 'Leonard Voss' and r.name = 'Marcus Bell'`,
  },
  {
    phase: 3, difficulty: 'hard', type: 'SINGLE_CHARACTER', title: "THE FINAL INTERSECTION", kind: "MOTIVE", label: "Location, handling and threats all point to {value}",
    prompt: 'Exactly one person (a) badged IN to the PROP_ROOM during the interval, (b) handled the chalice AFTER the 21:00 inspection, and (c) received a message from Leonard before 21:00. Who?',
    answer: 'Marcus Bell', concept: 'CTE / INTERSECT across three tables',
    sql: `select cc.name from cast_crew cc
      where cc.badge_id in (select badge_id from access_log where door = 'PROP_ROOM' and direction = 'IN' and logged_at between '${t('20:45')}' and '${t('21:05')}')
        and cc.badge_id in (select badge_id from prop_handling_log where prop_name like 'Chalice%' and handled_at > '${t('21:00')}')
        and cc.id in (select receiver_id from text_messages where sender_id = 1 and sent_at < '${t('21:00')}')`,
  },
];

export const CULPRIT_NAME = 'Marcus Bell';
export const REFERENCE_TASKS = TASKS;

// Case definition for the generic engine (installer + verifier).
export const definition = {
  slug: 'opening_night',
  title: TITLE,
  hook: HOOK,
  victimName: 'Leonard Voss',
  culpritName: CULPRIT_NAME,
  rosterNames: PEOPLE.filter((p) => p[5]).map((p) => p[1]),
  rosterRoles: Object.fromEntries(PEOPLE.filter((p) => p[5]).map((p) => [p[1], p[2]])),
  solution: {
    "motive": "Leonard had discovered that Marcus had been quietly selling the theatre's antique props and told him he would reveal it to the director after the show.",
    "method": "During the interval Marcus stayed in the locked prop room after Helena's 21:00 inspection and, at 21:02, topped up the chalice from a different bottle (lot 7QX-114).",
    "chain": [
      "Marcus Bell badged into the prop room during the interval and was the last person out, at 21:03, after the official inspection.",
      "The chalice was refilled at 21:02 from lot 7QX-114, two minutes after Helena Ross inspected and cleared it.",
      "Leonard Voss had threatened Marcus twice that evening, at 18:42 and 20:30, about the missing antiques.",
      "Only Marcus matches the location, the handling and the threats together; Priya Nair, Diana Frost and Oscar Lin were cleared."
    ]
  },
  tables: [
    {
      name: 'cast_crew',
      columns: ['id', 'name', 'role', 'department', 'badge_id'],
      ddl: 'id int primary key, name text not null, role text not null, department text not null, badge_id text not null unique',
      rows: PEOPLE.map((p) => p.slice(0, 5)),
    },
    {
      name: 'access_log',
      columns: ['badge_id', 'door', 'direction', 'logged_at'],
      ddl: "log_id serial primary key, badge_id text not null, door text not null, direction text not null check (direction in ('IN','OUT')), logged_at timestamp not null",
      rows: ACCESS.map(([b, d, dir, hm]) => [b, d, dir, t(hm)]),
    },
    {
      name: 'prop_handling_log',
      columns: ['prop_name', 'action', 'badge_id', 'handled_at', 'note'],
      ddl: 'entry_id serial primary key, prop_name text not null, action text not null, badge_id text not null, handled_at timestamp not null, note text',
      rows: PROPS.map(([p, a, b, hm, n]) => [p, a, b, t(hm), n]),
    },
    {
      name: 'text_messages',
      columns: ['sender_id', 'receiver_id', 'sent_at', 'body'],
      ddl: 'msg_id serial primary key, sender_id int not null references {S}.cast_crew(id), receiver_id int not null references {S}.cast_crew(id), sent_at timestamp not null, body text not null',
      rows: MESSAGES.map(([s, r, hm, body]) => [s, r, t(hm), body]),
    },
  ],
  phases: PHASES.map((p) => ({ clue: p.clue, tables: p.tables })),
  tasks: TASKS.map((x) => ({ title: x.title, kind: x.kind, label: x.label, phase: x.phase, difficulty: x.difficulty, type: x.type, prompt: x.prompt, answer: x.answer, concept: x.concept, sql: x.sql })),
};

export const installOpeningNight = (client, opts = {}) => installCase(client, definition, opts);
export { removeCaseFully };
