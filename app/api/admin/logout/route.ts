import { clearAdmin } from "@/lib/admin";
import { api, json } from "@/lib/http";

export async function POST() {
  return api(async () => {
    const res = json({ ok: true });
    clearAdmin(res);
    return res;
  });
}
