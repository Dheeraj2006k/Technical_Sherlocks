// TLS policy for Postgres connections: encrypted (certificate not verified, as the Supabase pooler requires) for any
// remote host, none for a local development database. pg reads PGSSLMODE when the connection URL has no sslmode.
export function ensureSslMode(url: string) {
  if (process.env.PGSSLMODE) return;
  let local = false;
  try {
    local = ["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname);
  } catch {}
  process.env.PGSSLMODE = local ? "disable" : "no-verify";
}
