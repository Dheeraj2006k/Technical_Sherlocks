import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

// Transaction-mode pooler: tiny pool, never use named prepared statements
// (pg only prepares when a `name` is passed, so plain query() is safe).
const g = globalThis as unknown as { __slcPool?: Pool };

function pool(): Pool {
  if (!g.__slcPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__slcPool = new Pool({
      connectionString: url,
      max: 2,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 10000,
    });
    g.__slcPool.on("error", () => {});
  }
  return g.__slcPool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool().query<T>(text, params);
}

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  c.on("error", () => {}); // a dropped connection must not crash the process
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
