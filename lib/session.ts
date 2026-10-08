import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import { query } from "./db";
import { HttpError } from "./http";

export const SESSION_COOKIE = "slc_session";
const MAX_AGE_S = 8 * 3600;

export type Role = "head" | "investigator";
export type Session = {
  team_id: string;
  player_id: string;
  role: Role;
  case_id: string;
  display_name: string;
  paused: boolean;
};

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function issueSession(
  res: NextResponse,
  s: { team_id: string; player_id: string; role: Role },
) {
  const token = await new SignJWT({ team_id: s.team_id, player_id: s.player_id, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(key());
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function clearSession(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Verifies the signature AND that the player/team still exist (an admin reset
// deletes rows, which invalidates sessions). Identity comes from the DB row; the case id
// is deliberately NOT in the token so it can't be read out of the cookie.
export async function requireSession(req: Request): Promise<Session> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "Not signed in");
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, key(), { algorithms: ["HS256"] }));
  } catch {
    throw new HttpError(401, "Invalid session");
  }
  const { player_id, team_id, role } = claims as Record<string, unknown>;
  if (typeof player_id !== "string" || typeof team_id !== "string") throw new HttpError(401, "Invalid session");
  const { rows } = await query<Session>(
    `select p.id as player_id, p.team_id, p.role, p.display_name, t.case_id, (t.paused_at is not null) as paused
       from players p join teams t on t.id = p.team_id
      where p.id = $1 and p.team_id = $2`,
    [player_id, team_id],
  );
  const r = rows[0];
  if (!r || r.role !== role) throw new HttpError(401, "Session no longer valid");
  return r;
}

// Emergency pause: scoring, queries and phase progress are frozen for paused teams.
export function assertActive(s: Session) {
  if (s.paused) throw new HttpError(423, "The game is paused by the organizers. Hang tight.");
}
