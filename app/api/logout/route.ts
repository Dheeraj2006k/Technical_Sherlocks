import { api, json } from "@/lib/http";
import { clearSession } from "@/lib/session";

export async function POST() {
  return api(async () => {
    const res = json({ ok: true });
    clearSession(res);
    return res;
  });
}
