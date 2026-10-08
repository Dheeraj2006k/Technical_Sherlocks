import { createHmac } from "node:crypto";
import { query } from "./db";
import { HttpError } from "./http";

// Rate limits live in the DB: Vercel is serverless, so in-memory counters don't work.

export const JOIN_PER_MINUTE = 10;
export const JOIN_PER_HOUR = 30;
export const SUBMITS_PER_MINUTE = 10;
export const QUERIES_PER_MINUTE = 30;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
}

function hashIp(ip: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(ip).digest("hex");
}

// Records this attempt (and prunes rows older than an hour), then enforces the limits.
// Every attempt counts, including failed ones, so credential guessing is throttled.
// `bucket` keeps different endpoints in separate counters; 'join' keeps the plain hash of the IP.
async function checkAttempts(req: Request, bucket: string, perMinute: number, perHour: number): Promise<void> {
  const ip = clientIp(req);
  const h = hashIp(bucket === "join" ? ip : `${bucket}:${ip}`);
  await query(
    `with pruned as (delete from join_attempts where created_at < now() - interval '1 hour')
     insert into join_attempts (ip_hash) values ($1)`,
    [h],
  );
  const r = await query<{ m: number; h: number }>(
    `select count(*) filter (where created_at > now() - interval '1 minute')::int as m, count(*)::int as h
       from join_attempts where ip_hash = $1 and created_at > now() - interval '1 hour'`,
    [h],
  );
  const { m, h: hour } = r.rows[0];
  if (hour > perHour) throw new HttpError(429, "Too many attempts. Try again later.", { "Retry-After": "3600" });
  if (m > perMinute) throw new HttpError(429, "Too many attempts. Try again later.", { "Retry-After": "60" });
}

// Defaults follow the spec (10/min, 30/hour per IP). A whole venue can sit behind ONE public IP (NAT), so
// organizers can raise them for event day with JOIN_RATE_PER_MINUTE / JOIN_RATE_PER_HOUR.
const envNum = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
export const checkJoinRate = (req: Request) =>
  checkAttempts(req, "join", envNum(process.env.JOIN_RATE_PER_MINUTE, JOIN_PER_MINUTE), envNum(process.env.JOIN_RATE_PER_HOUR, JOIN_PER_HOUR));
export const checkAdminLoginRate = (req: Request) => checkAttempts(req, "admin", 5, 20);
