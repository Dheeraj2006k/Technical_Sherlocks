// Applies the player-SQL gate to one case's evidence tables (schema case_<slug>). Idempotent.
//
// Every evidence table has its OWN random key (case_table_keys, server-only). The table's RLS policy holds only the
// SHA-256 of that key. For each request the server sets  app.keys = <comma list of the keys of the tables this team has
// unlocked>  inside the read-only transaction; a row is visible only if the hash of one of those keys matches the table's
// policy. A player can read the keys of tables they have unlocked (they are in their own session) but cannot derive or
// forge the key of a locked table or of another case. The SQL console and the Evidence Browser both run through this one
// gate, so they can never disagree about what is unlocked.
import { createHash, randomBytes } from 'node:crypto';

export const PLAYER_ROLE = 'player_exec';

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ident = (client, s) => client.escapeIdentifier(s);

export function schemaFor(slug) {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(slug)) throw new Error(`bad slug: ${slug}`);
  return `case_${slug}`;
}

export async function provisionCase(client, caseId, { rotateKeys = false } = {}) {
  const c = (await client.query('select slug from cases where id = $1', [caseId])).rows[0];
  if (!c) throw new Error('case not found');
  const schema = schemaFor(c.slug);

  await client.query(`grant usage on schema ${ident(client, schema)} to ${PLAYER_ROLE}`);
  const tables = (await client.query('select tablename from pg_tables where schemaname = $1', [schema])).rows.map((r) => r.tablename);

  // keys: one per table, created once (rotate to invalidate old ones); drop keys of tables that no longer exist
  for (const t of tables) {
    const key = randomBytes(24).toString('hex');
    await client.query(
      rotateKeys
        ? 'insert into case_table_keys (case_id, table_name, key) values ($1, $2, $3) on conflict (case_id, table_name) do update set key = excluded.key'
        : 'insert into case_table_keys (case_id, table_name, key) values ($1, $2, $3) on conflict (case_id, table_name) do nothing',
      [caseId, t, key],
    );
  }
  await client.query('delete from case_table_keys where case_id = $1 and not (table_name = any($2))', [caseId, tables]);
  const keys = Object.fromEntries((await client.query('select table_name, key from case_table_keys where case_id = $1', [caseId])).rows.map((r) => [r.table_name, r.key]));

  for (const t of tables) {
    const q = `${ident(client, schema)}.${ident(client, t)}`;
    await client.query(`alter table ${q} enable row level security`);
    await client.query(`drop policy if exists gate on ${q}`);
    const hash = sha256Hex(keys[t]);
    // uncorrelated EXISTS: evaluated once per statement, not per row
    const using =
      `exists (select 1 from unnest(string_to_array(coalesce(current_setting('app.keys', true), ''), ',')) as k(v) ` +
      `where sha256(convert_to(k.v, 'UTF8')) = '\\x${hash}'::bytea)`;
    await client.query(`create policy gate on ${q} for select to ${PLAYER_ROLE} using (${using})`);
    await client.query(`revoke all on ${q} from ${PLAYER_ROLE}`);
    await client.query(`grant select on ${q} to ${PLAYER_ROLE}`);
  }
  return { schema, tables };
}
