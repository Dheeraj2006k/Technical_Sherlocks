// Inserts a dummy case via the pooled connection (DATABASE_URL), reads it back, deletes it.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
let id;
let ok = false;
try {
  const ins = await pool.query(
    "insert into cases (password_hash, title, status, hook_text) values ('smoke-hash', 'SMOKE TEST CASE', 'draft', 'smoke') returning id"
  );
  id = ins.rows[0].id;
  console.log('insert: ok');

  const sel = await pool.query('select title, status from cases where id = $1', [id]);
  if (sel.rowCount !== 1 || sel.rows[0].title !== 'SMOKE TEST CASE') throw new Error('read-back mismatch');
  console.log('read:   ok');

  const del = await pool.query('delete from cases where id = $1', [id]);
  if (del.rowCount !== 1) throw new Error('delete affected ' + del.rowCount + ' rows');
  id = undefined;
  console.log('delete: ok');
  ok = true;
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
} finally {
  if (id) await pool.query('delete from cases where id = $1', [id]).catch(() => {});
  await pool.end();
}
process.exit(ok ? 0 : 1);
