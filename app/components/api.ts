import type { ApiResult } from "../types";

export async function post(path: string, body?: unknown): Promise<ApiResult> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const ra = r.headers.get("retry-after");
    return { ok: r.ok, status: r.status, data, retryAfter: ra ? Number(ra) : null };
  } catch {
    return { ok: false, status: 0, data: { error: "Connection interrupted. Check your network and try again." }, retryAfter: null };
  }
}

// Human wording for the server's error responses (never a bare "Something went wrong").
export function friendlyError(r: ApiResult): string {
  const msg = typeof r.data.error === "string" ? r.data.error : "";
  if (r.status === 0) return "Connection interrupted. Check your network and try again.";
  if (r.status === 423) return "The investigation is paused by the organizers. Hang tight.";
  if (r.status === 429) return `Slow down, detective. Try again in ${r.retryAfter ?? "a few"} seconds.`;
  if (r.status === 401) return msg || "Your session has ended. Rejoin the investigation.";
  return msg || "The server could not complete that request. Try again in a moment.";
}
