import { query } from "@/lib/db";
import { api, json } from "@/lib/http";
import { schemaFor } from "@/lib/schema";
import { requireSession } from "@/lib/session";

// Column names of the tables this team has unlocked (so players can write queries).
export async function GET(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    const r = await query<{ slug: string; reached: number }>(
      `select c.slug, case tp.state when 'WAITING' then 0 when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end as reached
         from team_progress tp join teams t on t.id = tp.team_id join cases c on c.id = t.case_id
        where tp.team_id = $1`,
      [s.team_id],
    );
    const row = r.rows[0];
    if (!row || row.reached === 0) return json({ tables: [] });
    const cols = await query<{ table_name: string; column_name: string; data_type: string }>(
      `select col.table_name, col.column_name, col.data_type
         from information_schema.columns col
        where col.table_schema = $1
          and col.table_name in (select unnest(tables_unlocked) from case_phases
                                  where case_id = $2 and phase_number <= $3)
        order by col.table_name, col.ordinal_position`,
      [schemaFor(row.slug), s.case_id, row.reached],
    );
    const tables: Record<string, { name: string; type: string }[]> = {};
    for (const c of cols.rows) (tables[c.table_name] ??= []).push({ name: c.column_name, type: c.data_type });
    return json({ tables: Object.entries(tables).map(([name, columns]) => ({ name, columns })) });
  });
}
