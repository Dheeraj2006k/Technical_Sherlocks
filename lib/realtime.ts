import { query } from "./db";

// Server side of Stage 5: after state changes, broadcast a data-free "changed" ping on the team's
// channel via the Supabase Realtime REST API. Best effort by design: if it fails, clients still
// converge through polling. The service key is used ONLY here, server-side, to publish pings;
// never to run player SQL.
function realtimeBase(): string | null {
  const explicit = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname; // db.<ref>.supabase.co
    const m = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
    return m ? `https://${m[1]}.supabase.co` : null;
  } catch {
    return null;
  }
}

export function realtimeConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && realtimeBase());
}

export async function pingTokens(tokens: string[]): Promise<void> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = realtimeBase();
  if (!key || !base || tokens.length === 0) return;
  try {
    await fetch(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: tokens.map((t) => ({ topic: `team:${t}`, event: "changed", payload: {}, private: false })) }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // swallowed: polling is the safety net
  }
}

export async function pingTeam(teamId: string): Promise<void> {
  if (!realtimeConfigured()) return;
  try {
    const r = await query<{ realtime_token: string }>("select realtime_token from teams where id = $1", [teamId]);
    if (r.rows[0]) await pingTokens([r.rows[0].realtime_token]);
  } catch {}
}

export async function pingAllTeams(): Promise<void> {
  if (!realtimeConfigured()) return;
  try {
    const r = await query<{ realtime_token: string }>("select realtime_token from teams");
    await pingTokens(r.rows.map((x) => x.realtime_token));
  } catch {}
}
