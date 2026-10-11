// Isolated LOCAL Postgres for development and tests (no Docker, no Supabase, no network).
// Nothing here can touch a remote or production database.
//
//   node scripts/local-db.mjs start     start the server (keeps running until Ctrl+C); env file: .env.localdb
//   node scripts/local-db.mjs setup     start, migrate, create player_exec, seed all cases, then stop
//   node scripts/local-db.mjs reset     delete the local data directory
//
// Point any tool at it with:   SLC_ENV_FILE=.env.localdb node scripts/<tool>.mjs      (or: npm run dev:local)
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalPg, prepareLocalDatabase, dataDir, envFileName, root, PORT } from './lib/localpg.mjs';

const cmd = process.argv[2] ?? 'start';

if (cmd === 'reset') {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(root, envFileName), { force: true });
  console.log('local database data removed');
  process.exit(0);
}

const { stop } = await startLocalPg();
console.log(`local postgres running on port ${PORT} (env file: ${envFileName})`);

if (cmd === 'setup') {
  try {
    prepareLocalDatabase();
    console.log('local database ready');
  } finally {
    await stop();
  }
  process.exit(0);
}

process.on('SIGINT', async () => {
  await stop();
  process.exit(0);
});
await new Promise(() => {});
