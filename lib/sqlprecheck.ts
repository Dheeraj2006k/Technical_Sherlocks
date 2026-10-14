// Dependency-free SQL pre-check, shared by the server (lib/sql.ts) and the Field Guide tests, so the guide can only ever
// show queries the console actually accepts. A usability layer: safety rests on the database role, RLS gate, read-only
// transaction, timeout and row cap, never on this check.
export const MAX_SQL_LENGTH = 4000;

// Catalog / metadata probes (PRD 9.3: the console must not reveal locked tables through metadata).
const CATALOG_RE =
  /\b(pg_[a-z0-9_]*|information_schema|to_reg[a-z]*|has_[a-z_]*_privilege|obj_description|col_description|shobj_description|format_type|regclass|regnamespace|regproc|regtype)\b/i;

export function touchesCatalog(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  return CATALOG_RE.test(stripped);
}

export type PrecheckResult = { ok: true; sql: string } | { ok: false; error: string };

// Allows a single trailing semicolon; WITH is accepted as well as SELECT so CTEs work.
export function checkSqlText(raw: unknown): PrecheckResult {
  if (typeof raw !== "string") return { ok: false, error: "Enter a query to run." };
  let sql = raw.trim();
  sql = sql.replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, error: "Enter a query to run." };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, error: `Query is too long (max ${MAX_SQL_LENGTH} characters).` };
  if (sql.includes(";")) return { ok: false, error: "Only one statement at a time (no semicolons)." };
  if (!/^(select|with)\b/i.test(sql)) return { ok: false, error: "Queries must start with SELECT (or WITH)." };
  if (touchesCatalog(sql)) return { ok: false, error: "System tables and metadata aren't part of the evidence. Query the case tables directly." };
  return { ok: true, sql };
}
