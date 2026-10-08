import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import { HttpError } from "./http";

export const ADMIN_COOKIE = "slc_admin";
const AUDIENCE = "slc-admin";
const MAX_AGE_S = 6 * 3600;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

// Constant-time comparison of the supplied password against ADMIN_PASSWORD.
export function checkAdminPassword(supplied: unknown): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof supplied !== "string" || supplied.length > 200) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Admin tokens carry audience "slc-admin" and no player claims, so a player session can never
// act as admin and an admin token can never act as a player.
export async function issueAdmin(res: NextResponse) {
  const token = await new SignJWT({ adm: true })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("6h")
    .sign(key());
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function clearAdmin(res: NextResponse) {
  res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
}

export async function requireAdmin(req: Request): Promise<void> {
  const raw = req.headers.get("cookie") ?? "";
  let token: string | null = null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === ADMIN_COOKIE) token = part.slice(i + 1).trim();
  }
  if (!token) throw new HttpError(401, "Admin sign-in required");
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"], audience: AUDIENCE });
    if (payload.adm !== true) throw new Error("not admin");
  } catch {
    throw new HttpError(401, "Admin sign-in required");
  }
  // State-changing admin requests must come from our own origin (the cookie is SameSite=Strict as well).
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) throw new HttpError(403, "Bad origin");
  }
}
