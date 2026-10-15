import { HttpError } from "./http";
import { checkSqlText } from "./sqlprecheck";

export { MAX_SQL_LENGTH, touchesCatalog } from "./sqlprecheck";

// UX-layer pre-check (PRD 6.1 layer 6): friendly messages for obvious mistakes. Safety does NOT depend on it; the DB
// role, RLS gate, read-only transaction, timeout and cursor row cap do. The rules live in lib/sqlprecheck.ts.
export function precheckSql(raw: unknown): string {
  const r = checkSqlText(raw);
  if (!r.ok) throw new HttpError(400, r.error);
  return r.sql;
}

export type QueryErrorInfo = { error_type: string; message: string };

// Maps Postgres errors to a stable type (stored in query_logs) and a player-facing message.
export function classifyError(e: unknown): QueryErrorInfo {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? "";
  if (code === "57014") return { error_type: "timeout", message: "That query took too long (3 second limit). Try narrowing it down." };
  if (code === "42501") return { error_type: "permission", message: "That table doesn't exist or isn't available to you." };
  if (code === "25006") return { error_type: "read_only", message: "Only read-only queries are allowed." };
  if (code === "42P01") return { error_type: "unknown_table", message: "That table doesn't exist or isn't unlocked yet." };
  if (code.startsWith("42") || code.startsWith("22")) {
    return { error_type: "sql", message: String(err.message ?? "Invalid query") };
  }
  if (code === "53300" || code === "57P01" || code === "08006") {
    return { error_type: "unavailable", message: "The database is busy. Try again in a moment." };
  }
  return { error_type: "other", message: "The evidence database could not be reached just now. Try again in a few seconds, and tell an organizer if it keeps happening." };
}
