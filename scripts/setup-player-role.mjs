// Creates (or refreshes) the dedicated, low-privilege login role that runs player SQL, and writes
// its connection string to .env.local as DATABASE_URL_PLAYER. The password is generated here,
// never printed, and never committed (.env.local is gitignored). Set the same variable in Vercel.
//
//   node scripts/setup-player-role.mjs            create role if missing; write the env var if missing
//   node scripts/setup-player-role.mjs --rotate   also generate a new password and rewrite the env var
//   node scripts/setup-player-role.mjs --pooled   keep the password, but rebuild DATABASE_URL_PLAYER from the host,
//                                                 port and database of DATABASE_URL (use after switching DATABASE_URL to
//                                                 the pooled/transaction-mode URL, which is what Vercel needs: its
//                                                 servers cannot reach Supabase's direct IPv6-only host)
//
// Safe to re-run: role settings are re-applied every time.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal, parseEnvLocal } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvLocal(root);
const ROLE = 'player_exec';
const rotate = process.argv.includes('--rotate');
const pooled = process.argv.includes('--pooled');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (expected in .env.local)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
let wroteEnv = false;
try {
  const exists = (await client.query('select 1 from pg_roles where rolname = $1', [ROLE])).rowCount === 1;
  const haveUrl = Boolean(parseEnvLocal(root).DATABASE_URL_PLAYER);
  const existingPassword = (() => {
    try {
      return decodeURIComponent(new URL(parseEnvLocal(root).DATABASE_URL_PLAYER).password) || null;
    } catch {
      return null;
    }
  })();
  if (pooled && !existingPassword) throw new Error('--pooled needs an existing DATABASE_URL_PLAYER (it reuses its password)');
  const needPassword = !exists || rotate || !haveUrl || pooled;
  const password = pooled && !rotate && exists ? existingPassword : needPassword ? randomBytes(24).toString('hex') : null;

  if (!exists) {
    await client.query(
      `create role ${ROLE} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
         connection limit 30 password ${client.escapeLiteral(password)}`,
    );
  } else if (needPassword && !(pooled && !rotate)) {
    await client.query(`alter role ${ROLE} password ${client.escapeLiteral(password)}`);
  }

  // Defense in depth for player SQL. (Also applied per-transaction with SET LOCAL by /api/query.)
  await client.query(`alter role ${ROLE} set statement_timeout = '3s'`);
  await client.query(`alter role ${ROLE} set lock_timeout = '1s'`);
  await client.query(`alter role ${ROLE} set idle_in_transaction_session_timeout = '10s'`);
  await client.query(`alter role ${ROLE} set default_transaction_read_only = on`);
  await client.query(`alter role ${ROLE} set search_path = ''`);
  await client.query(`revoke all on schema public from ${ROLE}`);
  await client.query(`revoke all on all tables in schema public from ${ROLE}`);

  if (needPassword) {
    const u = new URL(process.env.DATABASE_URL);
    // Supabase pooler usernames look like postgres.<project-ref>; keep the suffix.
    const suffix = u.username.includes('.') ? u.username.slice(u.username.indexOf('.')) : '';
    u.username = ROLE + suffix;
    u.password = password;
    const line = `DATABASE_URL_PLAYER=${u.toString()}`;
    const envPath = join(root, '.env.local');
    const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const lines = text.split(/\r?\n/).filter((l) => !/^\s*DATABASE_URL_PLAYER\s*=/.test(l));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
    writeFileSync(envPath, lines.join('\n'));
    wroteEnv = true;
  }
  console.log(`role ${ROLE}: ready (${exists ? 'existing' : 'created'}), settings applied`);
  console.log(wroteEnv ? 'DATABASE_URL_PLAYER written to .env.local (value not shown)' : 'DATABASE_URL_PLAYER already present, unchanged');
  if (wroteEnv) {
    const u = new URL(process.env.DATABASE_URL);
    console.log(`  -> now uses host kind: ${/pooler\.supabase\.com$/.test(u.hostname) ? 'pooler' : 'direct'}, port ${u.port || '5432'}`);
    console.log('  -> copy this value from .env.local into Vercel (DATABASE_URL_PLAYER) and redeploy');
  }
} catch (e) {
  console.error('setup failed:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
