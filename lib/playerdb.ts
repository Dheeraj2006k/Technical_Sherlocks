import pg, { Pool, type PoolClient } from "pg";
import Cursor from "pg-cursor";

// Player SQL runs ONLY through this pool: the dedicated login role `player_exec` (SELECT-only grants,
// RLS-subject, 3s statement timeout, read-only). Never the owner role, never the service key.
const g = globalThis as unknown as { __slcPlayerPool?: Pool };

export const ROW_CAP = 200;
export const STATEMENT_TIMEOUT_MS = 3000;
// Hard wall-clock bound on the whole request, independent of anything the SQL does.
const DEADLINE_MS = 6000;

// Date/time columns come back as the exact text Postgres prints (no JS timezone conversion).
const RAW_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);
const types = {
  getTypeParser: (oid: number, format?: string) =>
    RAW_OIDS.has(oid) ? (v: string) => v : (pg.types.getTypeParser as (o: number, f?: string) => unknown)(oid, format),
};

function playerPool(): Pool {
  if (!g.__slcPlayerPool) {
    const url = process.env.DATABASE_URL_PLAYER;
    if (!url) throw new PlayerDbUnavailable();
    g.__slcPlayerPool = new Pool({
      connectionString: url,
      max: 2,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 10000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      types: types as any,
    });
    g.__slcPlayerPool.on("error", () => {});
  }
  return g.__slcPlayerPool;
}

export class PlayerDbUnavailable extends Error {}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export type PlayerResult = { columns: string[]; rows: unknown[][]; truncated: boolean };

function plain(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `\\x${v.toString("hex")}`;
  if (typeof v === "bigint") return v.toString();
  return v;
}

const sleepThen = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

// One read-only transaction: set the (non-forgeable) per-phase key, run the single statement
// through an extended-protocol cursor (so exactly one statement is possible and no SQL wrapping can
// be escaped), and read at most ROW_CAP + 1 rows.
//
// Hardening around the connection itself: a player can make their own backend die
// (pg_terminate_backend on their own pid). That surfaces as an 'error' event on a checked-out client,
// which would crash the whole server if unhandled, so a listener is always attached; a deadline
// guarantees the request finishes; and the client is destroyed (not reused) after any failure.
export async function runPlayerQuery(schema: string, key: string, sql: string): Promise<PlayerResult> {
  const client: PoolClient = await playerPool().connect();
  client.on("error", () => {});
  let released = false;
  const release = (destroy: boolean) => {
    if (released) return;
    released = true;
    client.release(destroy ? true : undefined);
  };

  const work = (async (): Promise<PlayerResult> => {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`set local search_path = ${quoteIdent(schema)}`);
    await client.query("select set_config('app.key', $1, true)", [key]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cursor = client.query(new Cursor(sql, [], { rowMode: "array", types: types as any }));
    let rows: unknown[][];
    try {
      rows = (await cursor.read(ROW_CAP + 1)) as unknown[][];
    } finally {
      await cursor.close().catch(() => {});
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields: { name: string }[] = (cursor as any)._result?.fields ?? [];
    await client.query("rollback");
    const truncated = rows.length > ROW_CAP;
    return {
      columns: fields.map((f) => f.name),
      rows: (truncated ? rows.slice(0, ROW_CAP) : rows).map((r) => r.map(plain)),
      truncated,
    };
  })();
  work.catch(() => {}); // if the deadline wins, don't leave an unhandled rejection behind

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("deadline"), { code: "57014" })), DEADLINE_MS);
  });

  try {
    const result = await Promise.race([work, deadline]);
    release(false);
    return result;
  } catch (e) {
    // Bounded cleanup: never wait on a dead connection.
    await Promise.race([client.query("rollback").catch(() => {}), sleepThen(1500, null)]);
    release(true);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
