import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

// Which env file the scripts read. Default .env.local; set SLC_ENV_FILE (for example .env.localdb) to point every
// script and test at an isolated local database instead. Real credentials are never mixed into a local run:
// when SLC_ENV_FILE is set, .env.local is NOT read.
export function envPath(root) {
  const f = process.env.SLC_ENV_FILE || '.env.local';
  return isAbsolute(f) ? f : join(root, f);
}

// Parses the env file into a plain object (does not touch process.env).
export function parseEnvLocal(root) {
  const p = envPath(root);
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Loads the env file into process.env without overriding existing vars.
export function loadEnvLocal(root) {
  for (const [k, v] of Object.entries(parseEnvLocal(root))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // TLS for remote databases (Supabase), none for a local one. pg reads PGSSLMODE when the URL has no sslmode.
  if (!process.env.PGSSLMODE) process.env.PGSSLMODE = describeDatabase().local ? 'disable' : 'no-verify';
}

// Human-readable label of where the database is, with NO secrets: used to refuse risky operations.
export function describeDatabase(url = process.env.DATABASE_URL) {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    return { host: u.hostname, port: u.port, local, supabase: /supabase\.(co|com)$/.test(u.hostname) };
  } catch {
    return { host: 'unknown', port: '', local: false, supabase: false };
  }
}
