// Applies the player-SQL gate to one case's clue tables (schema case_<slug>). Idempotent.
//
// For each clue table, RLS admits a row only if sha256(current_setting('app.key')) equals the hash
// of the key of ANY phase >= the phase that unlocks that table (phases are additive). Tables not
// listed in any case_phases.tables_unlocked are locked for everyone. The keys themselves live in
// case_query_keys (server-only); the policies contain only their SHA-256 hashes, so a player who
// reads pg_policies, or calls set_config('app.key', ...), cannot reach a later phase's rows.
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

  // Keys: one per phase, random, created once (rotate to invalidate old ones).
  for (let p = 1; p <= 3; p++) {
    const key = randomBytes(24).toString('hex');
    await client.query(
      rotateKeys
        ? 'insert into case_query_keys (case_id, phase, key) values ($1, $2, $3) on conflict (case_id, phase) do update set key = excluded.key'
        : 'insert into case_query_keys (case_id, phase, key) values ($1, $2, $3) on conflict (case_id, phase) do nothing',
      [caseId, p, key],
    );
  }
  const keys = (await client.query('select phase, key from case_query_keys where case_id = $1', [caseId])).rows;
  const hashByPhase = Object.fromEntries(keys.map((k) => [k.phase, sha256Hex(k.key)]));

  // First phase that unlocks each table.
  const phases = (
    await client.query('select phase_number, tables_unlocked from case_phases where case_id = $1 order by phase_number', [caseId])
  ).rows;
  const unlockPhase = {};
  for (const ph of phases) for (const t of ph.tables_unlocked) if (!(t in unlockPhase)) unlockPhase[t] = ph.phase_number;

  await client.query(`grant usage on schema ${ident(client, schema)} to ${PLAYER_ROLE}`);
  const tables = (await client.query('select tablename from pg_tables where schemaname = $1', [schema])).rows.map((r) => r.tablename);
  for (const t of tables) {
    const q = `${ident(client, schema)}.${ident(client, t)}`;
    await client.query(`alter table ${q} enable row level security`);
    await client.query(`drop policy if exists gate on ${q}`);
    const u = unlockPhase[t];
    const allowed = u ? [1, 2, 3].filter((p) => p >= u).map((p) => `'\\x${hashByPhase[p]}'::bytea`) : [];
    const using = allowed.length
      ? `sha256(convert_to(coalesce(current_setting('app.key', true), ''), 'UTF8')) = any (array[${allowed.join(', ')}])`
      : 'false';
    await client.query(`create policy gate on ${q} for select to ${PLAYER_ROLE} using (${using})`);
    await client.query(`revoke all on ${q} from ${PLAYER_ROLE}`);
    await client.query(`grant select on ${q} to ${PLAYER_ROLE}`);
  }
  return { schema, tables, unlockPhase };
}
