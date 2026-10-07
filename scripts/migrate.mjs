// Applies supabase/migrations/*.sql in filename order using DATABASE_URL from .env.local.
// Tracks applied files in schema_migrations; each file runs in its own transaction.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvLocal(root);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}

const dir = join(root, 'supabase', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())'
  );
  const { rows } = await client.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const f of files) {
    if (applied.has(f)) {
      console.log(`skip   ${f}`);
      continue;
    }
    await client.query('begin');
    try {
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`apply  ${f}`);
    } catch (e) {
      await client.query('rollback');
      console.error(`FAILED ${f}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
