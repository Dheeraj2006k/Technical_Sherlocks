// Builds the app, starts it on a test port against the dev DB, runs the node:test suites, stops it.
// Usage: node tests/run.mjs [--no-build] [tests/some.test.mjs ...]
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.TEST_PORT ?? '3101';
const SECRETS_FILE = join(tmpdir(), `slc-test-secrets-${process.pid}.txt`);
writeFileSync(SECRETS_FILE, '');

if (!process.argv.includes('--no-build')) {
  const b = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) process.exit(1);
}

const server = spawn(`npx next start -p ${PORT}`, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

function killServer() {
  if (process.platform === 'win32') spawnSync(`taskkill /pid ${server.pid} /T /F`, { shell: true, stdio: 'ignore' });
  else server.kill('SIGTERM');
}

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/state`);
    ready = r.status === 401 || r.status === 200;
  } catch {}
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error('server did not start:\n' + serverLog);
  killServer();
  process.exit(1);
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || 'tests/*.test.mjs';
const t = spawnSync(`node --test --test-timeout=400000 --test-concurrency=1 ${files}`, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TEST_BASE_URL: `http://localhost:${PORT}`, TEST_SECRETS_FILE: SECRETS_FILE },
});
killServer();

// The server log must never contain any case code, password or case id used by the tests.
const secrets = [...new Set(readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/).filter(Boolean))];
rmSync(SECRETS_FILE, { force: true });
const leaked = secrets.filter((x) => serverLog.includes(x));
if (leaked.length) console.error(`FAIL: ${leaked.length} test credential(s) found in the server log`);
else console.log(`server log check: none of ${secrets.length} test credentials appear in the server log`);
process.exit(t.status === 0 && !leaked.length ? 0 : 1);
