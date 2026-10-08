// Post-event cleanup (PRD section 11): query_logs are kept during the event for debugging, then discarded.
// Also prunes the rate-limit table. Dry run by default; pass --yes to actually delete.
//   node scripts/discard-query-logs.mjs          show what would be deleted
//   node scripts/discard-query-logs.mjs --yes    delete query_logs and join_attempts
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvLocal } from './lib/env.mjs';

loadEnvLocal(join(dirname(fileURLToPath(import.meta.url)), '..'));
const yes = process.argv.includes('--yes');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const c = await client.query('select (select count(*)::int from query_logs) as logs, (select count(*)::int from join_attempts) as attempts');
  console.log(`query_logs: ${c.rows[0].logs} rows, join_attempts: ${c.rows[0].attempts} rows`);
  if (!yes) {
    console.log('dry run: nothing deleted (pass --yes to delete)');
  } else {
    await client.query('begin');
    const a = await client.query('delete from query_logs');
    const b = await client.query('delete from join_attempts');
    await client.query('commit');
    console.log(`deleted ${a.rowCount} query_logs rows and ${b.rowCount} join_attempts rows`);
  }
} finally {
  await client.end();
}
