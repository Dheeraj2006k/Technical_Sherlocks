import { query } from "@/lib/db";
import { getUnlocks } from "@/lib/engine";
import { api, json } from "@/lib/http";
import { schemaFor } from "@/lib/schema";
import { requireSession } from "@/lib/session";

// Column names of the evidence tables this team has unlocked (so players can write queries).
export async function GET(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    const u = await getUnlocks(query, s.team_id);
    if (!u || u.tables.length === 0) return json({ tables: [] });
    const cols = await query<{ table_name: string; column_name: string; data_type: string }>(
      `select col.table_name, col.column_name, col.data_type
         from information_schema.columns col
        where col.table_schema = $1 and col.table_name = any($2)
        order by col.table_name, col.ordinal_position`,
      [schemaFor(u.slug), u.tables],
    );
    const tables: Record<string, { name: string; type: string }[]> = {};
    for (const c of cols.rows) (tables[c.table_name] ??= []).push({ name: c.column_name, type: c.data_type });
    return json({ tables: Object.entries(tables).map(([name, columns]) => ({ name, columns })) });
  });
}
