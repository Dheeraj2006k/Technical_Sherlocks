import { createHash } from "node:crypto";
import { query, withTx } from "@/lib/db";
import { api, HttpError, json, readBody } from "@/lib/http";
import { PlayerDbUnavailable, runPlayerQuery } from "@/lib/playerdb";
import { QUERIES_PER_MINUTE } from "@/lib/ratelimit";
import { assertActive, requireSession } from "@/lib/session";
import { classifyError, precheckSql } from "@/lib/sql";
import { schemaFor } from "@/lib/schema";

// Execute a read-only query for the session's team, scoped to its case and unlocked phases.
// team_id / case / phase come from the session + DB only. Credentials and the phase key never
// leave the server.
export async function POST(req: Request) {
  return api(async () => {
    const s = await requireSession(req);
    assertActive(s);
    const body = await readBody(req);
    const sql = precheckSql(body.sql);

    const info = await query<{ state: string; slug: string; key: string | null; reached: number }>(
      `select tp.state, c.slug, k.key,
              case tp.state when 'WAITING' then 0 when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end as reached
         from team_progress tp
         join teams t on t.id = tp.team_id
         join cases c on c.id = t.case_id
         left join case_query_keys k on k.case_id = c.id
              and k.phase = case tp.state when 'PHASE_1' then 1 when 'PHASE_2' then 2 else 3 end
        where tp.team_id = $1`,
      [s.team_id],
    );
    const row = info.rows[0];
    if (!row) throw new HttpError(401, "Session no longer valid");
    if (row.reached === 0) throw new HttpError(409, "The investigation hasn't started yet.");
    if (!row.key) throw new HttpError(503, "This case isn't ready for queries.");

    const hash = createHash("sha256").update(sql).digest("hex");

    // Per-player rate limit from query_logs rows (no in-memory counters). The advisory lock
    // serializes one player's concurrent requests so the count can't be raced past.
    const logId = await withTx(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`q:${s.player_id}`]);
      const r = await tx.query(
        `select count(*)::int as n,
                extract(epoch from (min(created_at) + interval '60 seconds' - now()))::int as wait
           from (select created_at from query_logs
                  where player_id = $1 and created_at > now() - interval '60 seconds'
                  order by created_at desc limit $2) r`,
        [s.player_id, QUERIES_PER_MINUTE],
      );
      if (r.rows[0].n >= QUERIES_PER_MINUTE) {
        throw new HttpError(429, "Too many queries. Wait a moment.", { "Retry-After": String(Math.max(1, r.rows[0].wait ?? 60)) });
      }
      const ins = await tx.query(
        `insert into query_logs (team_id, player_id, query_hash, success, error_type)
         values ($1, $2, $3, false, 'pending') returning id`,
        [s.team_id, s.player_id, hash],
      );
      return ins.rows[0].id as string;
    });

    const t0 = performance.now();
    try {
      const result = await runPlayerQuery(schemaFor(row.slug), row.key, sql);
      const ms = Math.round(performance.now() - t0);
      await query("update query_logs set execution_time_ms = $2, row_count = $3, success = true, error_type = null where id = $1", [
        logId,
        ms,
        result.rows.length,
      ]);

      let notice: string | undefined;
      if (result.rows.length === 0) {
        const locked = await query<{ tables_unlocked: string[] }>(
          `select tables_unlocked from case_phases
            where case_id = (select case_id from teams where id = $1) and phase_number > $2`,
          [s.team_id, row.reached],
        );
        const hit = locked.rows.flatMap((r) => r.tables_unlocked).find((n) => new RegExp(`\\b${n}\\b`, "i").test(sql));
        if (hit) notice = `Heads up: "${hit}" isn't unlocked yet, so it returns nothing.`;
      }
      return json({ ok: true, ...result, row_count: result.rows.length, row_cap: 200, elapsed_ms: ms, notice });
    } catch (e) {
      if (e instanceof PlayerDbUnavailable) {
        await query("update query_logs set error_type = 'unavailable' where id = $1", [logId]).catch(() => {});
        throw new HttpError(503, "The query console is unavailable.");
      }
      const info2 = classifyError(e);
      // Infrastructure failures (not the player's SQL) are logged for the organizers: code + short message only.
      if (info2.error_type === "other" || info2.error_type === "unavailable") {
        const er = e as { code?: string; message?: string };
        console.error("player query infrastructure error:", er.code ?? "no-code", String(er.message ?? "").slice(0, 160));
      }
      const ms = Math.round(performance.now() - t0);
      await query("update query_logs set execution_time_ms = $2, success = false, error_type = $3 where id = $1", [
        logId,
        ms,
        info2.error_type,
      ]).catch(() => {});
      return json({ ok: false, error: info2.message, error_type: info2.error_type, elapsed_ms: ms }, 200);
    }
  });
}
