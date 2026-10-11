// Runs the whole test pipeline against an isolated LOCAL Postgres (no remote database is touched).
//   node tests/run-local.mjs [--no-build] [tests/some.test.mjs ...]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { startLocalPg, prepareLocalDatabase, envFileName, root } from '../scripts/lib/localpg.mjs';

const { stop } = await startLocalPg();
let code = 1;
try {
  prepareLocalDatabase();
  const r = spawnSync('node', ['tests/run.mjs', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, SLC_ENV_FILE: envFileName } });
  code = r.status ?? 1;
} finally {
  await stop().catch(() => {});
}
void join;
process.exit(code);
