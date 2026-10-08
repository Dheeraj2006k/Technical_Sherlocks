// Seeds the Stage 2 STUB case into the dev database (idempotent).
//
//   Case code: SH3R-10CK   (stored as SH3R10CK; this is what a head types to join)
//   Password:  stub-pass-123
//   Case ID:   00000000-0000-4000-8000-000000000001  (internal; never shown to players)
//   Status:    live
//
// 3 phases x 3 tasks covering SINGLE_CHARACTER, NUMBER, TIME and TEXT. Task answers are
// trivial ("type the number 5") on purpose; real case data arrives in Stage 3.
// Re-running DELETES the stub case and any teams that joined it, then recreates it.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';
import { insertStubCase, deleteCase } from './lib/stub-case.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

const CASE_ID = '00000000-0000-4000-8000-000000000001';
const PASSWORD = 'stub-pass-123';
const CASE_CODE = 'SH3R10CK';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('begin');
  await deleteCase(client, CASE_ID);
  await insertStubCase(client, { id: CASE_ID, password: PASSWORD, caseCode: CASE_CODE, title: 'Stub Case', fixed: true });
  await client.query('commit');
  console.log('seeded stub case: code SH3R-10CK, password stub-pass-123');
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error('seed failed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
