import { checkAdminPassword, issueAdmin } from "@/lib/admin";
import { api, HttpError, json, readBody } from "@/lib/http";
import { checkAdminLoginRate } from "@/lib/ratelimit";

export async function POST(req: Request) {
  return api(async () => {
    await checkAdminLoginRate(req);
    const body = await readBody(req);
    if (!checkAdminPassword(body.password)) throw new HttpError(401, "Invalid credentials");
    const res = json({ ok: true });
    await issueAdmin(res);
    return res;
  });
}
