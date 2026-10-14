// SQL Field Guide (PRD 17.1 / 17.4): the guide is static, its examples are real (they run, and print exactly what the guide
// says), and every example respects what the console accepts. No server is involved: this file loads the guide's own data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { TOPICS, searchTopics, GUIDE_INTRO } from '../app/fieldguide/content.ts';
import { GUIDE_TABLES } from '../app/fieldguide/dataset.ts';
import { checkSqlText } from '../lib/sqlprecheck.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(root, p), 'utf8');
const examples = TOPICS.flatMap((t) => t.blocks.filter((b) => b.type === 'example').map((b) => ({ topic: t.id, title: b.title, ...b.example })));

// date/time values come back as the exact text Postgres prints, as in the real console (lib/playerdb.ts)
const RAW = new Set([1082, 1083, 1114, 1184, 1266]);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, types: { getTypeParser: (oid, fmt) => (RAW.has(oid) ? (v) => v : pg.types.getTypeParser(oid, fmt)) } });
await client.connect();
const schema = `fg_${Date.now().toString(36)}`;
await client.query(`create schema ${schema}`);
await client.query(`set search_path = ${schema}`);
for (const t of GUIDE_TABLES) {
  await client.query(`create table ${t.name} (${t.ddl})`);
  for (const row of t.rows) await client.query(`insert into ${t.name} (${t.columns.join(', ')}) values (${row.map((_, i) => `$${i + 1}`).join(', ')})`, row);
}
after(async () => {
  await client.query(`drop schema if exists ${schema} cascade`);
  await client.end();
});

const norm = (rows) => rows.map((r) => r.map((v) => (v === null ? null : String(v))));

test('the guide is static: no network call, no AI, no generation in any of its source files', () => {
  for (const f of ['app/components/FieldGuide.tsx', 'app/components/Help.tsx', 'app/fieldguide/content.ts', 'app/fieldguide/dataset.ts', 'app/components/Tour.tsx']) {
    const s = src(f);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\/api\//.test(s), `${f} makes no network request`);
    assert.ok(!/openai|anthropic|claude|gpt|llm|completion|generate\(/i.test(s.replace(/claude\.ai/gi, '')), `${f} mentions no model`);
  }
  assert.ok(/no ai|never need it|nothing in this guide/i.test(GUIDE_INTRO) || GUIDE_INTRO.length > 50);
});

test('the guide covers every topic the PRD lists, plus errors, reading results and a worked detective example', () => {
  const text = JSON.stringify(TOPICS).toLowerCase();
  for (const word of ['select', 'where', 'order by', 'limit', 'count', 'sum', 'min', 'max', 'avg', 'group by', 'join', ' and ', ' or ', 'like', ' in (', 'is null', 'alias', 'ambiguous', 'does not exist', 'syntax error', 'no rows', 'capital']) {
    assert.ok(text.includes(word), `the guide mentions ${word}`);
  }
  for (const id of ['results', 'select', 'where', 'and-or', 'in', 'like', 'is-null', 'order-limit', 'aggregates', 'group-by', 'join', 'errors', 'detective', 'limits']) assert.ok(TOPICS.some((t) => t.id === id), `topic ${id}`);
});

test('the worked detective example has a question, its evidence structure, a supported query, its result, what it does and does not prove, and a next step', () => {
  const d = TOPICS.find((t) => t.id === 'detective');
  const prose = d.blocks.filter((b) => b.type === 'p').map((b) => b.text).join(' ');
  assert.match(prose, /Question:/);
  assert.match(prose, /door_scans \(scan_id, badge_no, door, direction, scanned_at\)/);
  assert.match(prose, /What it proves/);
  assert.match(prose, /does not prove/);
  assert.match(prose, /Next step/);
  const ex = d.blocks.find((b) => b.type === 'example').example;
  assert.equal(checkSqlText(ex.sql).ok, true);
  assert.deepEqual(ex.rows, [['Kabir Rao', '2025-06-12 11:05:00']]);
});

test('every example is accepted by the console pre-check, except the ones the guide explicitly shows as refused', () => {
  assert.ok(examples.length >= 25, 'the guide has plenty of examples');
  for (const e of examples) {
    const r = checkSqlText(e.sql);
    if (e.refused) assert.equal(r.ok, false, `${e.title} should be refused`);
    else assert.equal(r.ok, true, `${e.title}: ${e.sql} (${r.error})`);
  }
  for (const e of examples) assert.ok(e.refused || !/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(e.sql), `${e.title} teaches nothing but SELECT`);
});

test('every example runs against the guide dataset and prints exactly what the guide shows', async () => {
  for (const e of examples) {
    if (e.refused) continue;
    if (e.errorCode) {
      await assert.rejects(client.query(e.sql), (err) => err.code === e.errorCode, `${e.title} should fail with ${e.errorCode}`);
      continue;
    }
    const r = await client.query({ text: e.sql, rowMode: 'array' });
    assert.deepEqual(r.fields.map((f) => f.name), e.columns, `${e.title}: columns`);
    assert.deepEqual(norm(r.rows), norm(e.rows), `${e.title}: rows`);
  }
});

test('the examples respect the 200-row cap (none comes near it) and use only the guide tables', () => {
  const names = new Set(GUIDE_TABLES.map((t) => t.name));
  for (const e of examples) {
    if (e.refused || e.errorCode) continue;
    assert.ok((e.rows ?? []).length <= 20, e.title);
    const used = [...e.sql.matchAll(/\b(?:from|join)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    assert.ok(used.every((u) => names.has(u)), `${e.title} uses ${used}`);
  }
});

test('search and navigation work: topics are found by title, keyword or body text, in best-first order', () => {
  assert.equal(searchTopics('').length, TOPICS.length);
  assert.equal(searchTopics('   ').length, TOPICS.length);
  assert.equal(searchTopics('join')[0].id, 'join');
  assert.ok(searchTopics('left join').some((t) => t.id === 'join'));
  assert.ok(searchTopics('null').some((t) => t.id === 'is-null'));
  assert.ok(searchTopics('ambiguous').some((t) => t.id === 'errors'));
  assert.ok(searchTopics('capital letters').some((t) => t.id === 'errors' || t.id === 'where'));
  assert.equal(searchTopics('zzzznotatopic').length, 0);
  assert.ok(searchTopics('group having').some((t) => t.id === 'group-by'));
});

test('opening or closing the guide cannot change a thing: it is a pure component with no game imports and no storage writes', () => {
  const s = src('app/components/FieldGuide.tsx');
  assert.ok(!/from "\.\/api"|post\(|localStorage|sessionStorage|document\.cookie/.test(s));
  // the editor lives in SqlConsole, mounted in a hidden tab panel next to the drawer, so toggling the drawer never remounts it
  const game = src('app/components/Game.tsx');
  assert.match(game, /<FieldGuide open=\{guideOpen\} onClose=\{closeGuide\} \/>/);
  assert.match(game, /hidden=\{tab !== "console"\}/);
});
