// Isolated LOCAL Postgres (embedded-postgres): no Docker, no Supabase, no network. Used for development and tests.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pgDriver from 'pg';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataDir = join(root, '.local-pg');
export const envFileName = '.env.localdb';
export const PORT = Number(process.env.LOCAL_PG_PORT ?? 54329);
const PASSWORD = 'local-dev-only';

async function reachable() {
  const c = new pgDriver.Client({ connectionString: `postgres://postgres:${PASSWORD}@localhost:${PORT}/postgres`, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const LINE_BREAK = new RegExp('\\r?\\n');

// Is any process still listening on our port? (Windows only; elsewhere the server stops cleanly.)
function listening() {
  if (process.platform !== 'win32') return false;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
  return new RegExp(`:${PORT}\\s+\\S+\\s+LISTENING`).test(out);
}

// Last resort on Windows, where stopping the embedded server can leave the postmaster behind: kill whatever recorded its
// pid in our data directory, and whatever is still listening on OUR port (nothing else).
function forceStop() {
  const pids = new Set();
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) pids.add(Number(readFileSync(pidFile, 'utf8').split(LINE_BREAK)[0]));
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const listener = new RegExp(`:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    for (const line of out.split(LINE_BREAK)) {
      const m = listener.exec(line);
      if (m) pids.add(Number(m[1]));
    }
  }
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(pidFile, { force: true });
}

// Starts (initialising on first use) the local server and makes sure the .env.localdb file exists.
// If a server from an earlier run is still up on the port, it is reused.
export async function startLocalPg() {
  if (await reachable()) {
    writeEnvFile();
    return { pg: null, stop: async () => forceStop() };
  }
  forceStop(); // a half-dead server from a crashed run may still hold the port; clear it
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: PASSWORD, port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--no-locale'], onLog: () => {}, onError: () => {} });
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('slc');
  } catch {
    /* already exists */
  }
  writeEnvFile();
  return {
    pg,
    stop: async () => {
      // a graceful stop can hang on Windows while a client connection lingers: bound it, then clear whatever still holds our port
      await Promise.race([pg.stop().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
      await new Promise((r) => setTimeout(r, 300));
      if (listening()) forceStop();
    },
  };
}

function writeEnvFile() {
  const envFile = join(root, envFileName);
  if (!existsSync(envFile)) {
    // Nothing here is a real credential: throwaway local values only.
    writeFileSync(
      envFile,
      [
        `DATABASE_URL=postgres://postgres:${PASSWORD}@localhost:${PORT}/slc`,
        `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
        'ADMIN_PASSWORD=local-admin-password',
        'SUPABASE_SERVICE_ROLE_KEY=',
        'JOIN_RATE_PER_MINUTE=10',
        'JOIN_RATE_PER_HOUR=30',
        '',
      ].join('\n'),
    );
  }
}

// Runs a repo script with the local env file selected (never .env.local).
export function runScript(args, extraEnv = {}) {
  const r = spawnSync('node', args, { cwd: root, stdio: 'inherit', env: { ...process.env, SLC_ENV_FILE: envFileName, ...extraEnv } });
  if (r.status !== 0) throw new Error(`failed: node ${args.join(' ')}`);
}

// migrate + player role + seed every case (all idempotent)
export function prepareLocalDatabase() {
  runScript(['scripts/migrate.mjs']);
  runScript(['scripts/setup-player-role.mjs']);
  if (existsSync(join(root, 'scripts', 'seed-cases.mjs'))) runScript(['scripts/seed-cases.mjs']);
}
