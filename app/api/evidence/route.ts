import { query } from "@/lib/db";
import { getUnlocks } from "@/lib/engine";
import { api, HttpError, json, readBody } from "@/lib/http";
import { PlayerDbUnavailable, playerTx, plainRow, quoteId } from "@/lib/playerdb";
import { QUERIES_PER_MINUTE } from "@/lib/ratelimit";
import { schemaFor } from "@/lib/schema";
import { assertActive, requireSession } from "@/lib/session";
import { classifyError } from "@/lib/sql";

// Evidence Browser (PRD 10): search / filter / sort / paginate the evidence tables a team has unlocked, without SQL.
// Same enforcement as the SQL console: the statement runs as player_exec in a read-only transaction with the per-table
// RLS keys of the team's unlocked tables. Table and column names come from an allow-list (the case schema's real columns
// of unlocked tables); every value is a bound parameter; nothing from the request is ever concatenated into SQL.
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_FILTERS = 6;
const MAX_TERM = 100;

// Comparison casts by Postgres data_type, from a fixed allow-list (the cast text below is never user input).
const NUMERIC = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);
const TEMPORAL = new Set(["date", "time without time zone", "timestamp without time zone", "timestamp with time zone"]);

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

type Col = { name: string; type: string };

export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);

    const unlocks = await getUnlocks(query, s.team_id);
    if (!unlocks) throw new HttpError(401, "Session no longer valid");
    if (unlocks.state === "WAITING") throw new HttpError(409, "The investigation hasn't started yet.");
    const schema = schemaFor(unlocks.slug);

    const cols = await query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = $1 and table_name = any($2) order by table_name, ordinal_position`,
      [schema, unlocks.tables],
    );
    const byTable = new Map<string, Col[]>();
    for (const c of cols.rows) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, []);
      byTable.get(c.table_name)!.push({ name: c.column_name, type: c.data_type });
    }

    // No table chosen: return the catalogue of unlocked tables and their columns.
    if (body.table === undefined) {
      return json({ ok: true, tables: [...byTable].map(([name, columns]) => ({ name, columns })) });
    }

    if (typeof body.table !== "string" || !byTable.has(body.table)) throw new HttpError(404, "That evidence isn't available.");
    const table = body.table;
    const columns = byTable.get(table)!;
    const colOf = (n: unknown): Col => {
      const c = typeof n === "string" ? columns.find((x) => x.name === n) : undefined;
      if (!c) throw new HttpError(400, "Unknown column.");
      return c;
    };

    const params: unknown[] = [];
    const bind = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [];

    if (body.search !== undefined && body.search !== null && body.search !== "") {
      if (typeof body.search !== "string" || body.search.length > MAX_TERM) throw new HttpError(400, "Search term is too long.");
      const p = bind(`%${likeEscape(body.search)}%`);
      where.push(`(${columns.map((c) => `${quoteId(c.name)}::text ilike ${p}`).join(" or ")})`);
    }

    const filters = body.filters ?? [];
    if (!Array.isArray(filters) || filters.length > MAX_FILTERS) throw new HttpError(400, "Too many filters.");
    for (const f of filters as Record<string, unknown>[]) {
      const col = colOf(f?.column);
      const op = f?.op;
      const value = f?.value;
      if (typeof value !== "string" || value.length > MAX_TERM) throw new HttpError(400, "Filter value is invalid.");
      const id = quoteId(col.name);
      if (op === "eq") where.push(`lower(${id}::text) = lower(${bind(value)})`);
      else if (op === "neq") where.push(`lower(${id}::text) is distinct from lower(${bind(value)})`);
      else if (op === "contains") where.push(`${id}::text ilike ${bind(`%${likeEscape(value)}%`)}`);
      else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
        if (NUMERIC.has(col.type)) where.push(`${id}::numeric ${sym} ${bind(value)}::numeric`);
        else if (TEMPORAL.has(col.type)) where.push(`${id} ${sym} ${bind(value)}::${col.type}`);
        else where.push(`${id}::text ${sym} ${bind(value)}`);
      } else throw new HttpError(400, "Unknown filter.");
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    let orderSql = "order by ctid";
    if (body.sort !== undefined && body.sort !== null) {
      const sort = body.sort as Record<string, unknown>;
      const dir = sort.dir === "desc" ? "desc" : "asc";
      orderSql = `order by ${quoteId(colOf(sort.column).name)} ${dir} nulls last, ctid`;
    }

    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(body.page_size ?? DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE));
    const page = Math.max(1, Math.min(10000, Math.trunc(Number(body.page ?? 1)) || 1));

    // Same per-player budget as the console (three times the allowance: browsing is cheaper than free-form SQL).
    const recent = await query("select count(*)::int as n from query_logs where player_id = $1 and created_at > now() - interval '60 seconds' and query_hash like 'evidence:%'", [s.player_id]);
    if (recent.rows[0].n >= QUERIES_PER_MINUTE * 3) {
      throw new HttpError(429, "Too many requests. Wait a moment.", { "Retry-After": "10" });
    }
    await query("insert into query_logs (team_id, player_id, query_hash, success, error_type) values ($1, $2, $3, true, null)", [
      s.team_id,
      s.player_id,
      `evidence:${table}`,
    ]);

    const from = `${quoteId(table)}`;
    try {
      const out = await playerTx(schema, unlocks.keys, async (client) => {
        const countRes = await client.query({ text: `select count(*)::int as n from ${from} ${whereSql}`, values: params });
        const limitP = `$${params.length + 1}`;
        const offP = `$${params.length + 2}`;
        const rowsRes = await client.query({
          text: `select ${columns.map((c) => quoteId(c.name)).join(", ")} from ${from} ${whereSql} ${orderSql} limit ${limitP} offset ${offP}`,
          values: [...params, pageSize, (page - 1) * pageSize],
          rowMode: "array",
        });
        return { total: countRes.rows[0].n as number, rows: (rowsRes.rows as unknown[][]).map(plainRow) };
      });
      return json({
        ok: true,
        table,
        columns: columns.map((c) => c.name),
        rows: out.rows,
        total: out.total,
        page,
        page_size: pageSize,
        pages: Math.max(1, Math.ceil(out.total / pageSize)),
      });
    } catch (e) {
      if (e instanceof PlayerDbUnavailable) throw new HttpError(503, "The evidence browser is unavailable.");
      const info = classifyError(e);
      if (info.error_type === "sql") throw new HttpError(400, "That filter value doesn't fit the column's type.");
      if (info.error_type === "other" || info.error_type === "unavailable") {
        const er = e as { code?: string };
        console.error("evidence infrastructure error:", er.code ?? "no-code");
      }
      throw new HttpError(info.error_type === "timeout" ? 408 : 503, info.message);
    }
  });
}
