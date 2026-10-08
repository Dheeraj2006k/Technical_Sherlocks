import { NextResponse } from "next/server";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_BODY_BYTES = 100_000;

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  try {
    const b = JSON.parse(text);
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Invalid JSON body");
}

// Postgres text cannot hold NUL bytes; control characters have no business in any field we store.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, `${field} is required`);
  const s = String(v).trim();
  if (!s) throw new HttpError(400, `${field} is required`);
  if (CONTROL_RE.test(s)) throw new HttpError(400, `${field} contains invalid characters`);
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
}

export function uuid(v: unknown, field: string): string {
  const s = str(v, field, 64);
  if (!UUID_RE.test(s)) throw new HttpError(400, `${field} is invalid`);
  return s.toLowerCase();
}

// Wraps a handler: HttpError -> JSON error, anything else -> generic 500 (never leaks details).
export async function api(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status, headers: e.headers });
    // Next.js control-flow errors (prerender interruption, redirects, ...) carry a digest; let them through.
    if (e && typeof (e as { digest?: unknown }).digest === "string") throw e;
    console.error("api error:", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
