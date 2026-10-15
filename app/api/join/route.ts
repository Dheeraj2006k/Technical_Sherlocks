import bcrypt from "bcryptjs";
import { after } from "next/server";
import type { PoolClient } from "pg";
import { formatCode, generateTeamCode, normalizeCaseCode, normalizeCode } from "@/lib/codes";
import { withTx } from "@/lib/db";
import { cleanName, MAX_PLAYERS } from "@/lib/game";
import { api, HttpError, json, readBody, str } from "@/lib/http";
import { checkJoinRate } from "@/lib/ratelimit";
import { pingTeam } from "@/lib/realtime";
import { issueSession, type Role } from "@/lib/session";

// Compared against when nothing is found, so timing doesn't reveal which credentials exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

// One body, one status, for every credential failure (PRD 4): unknown/withdrawn registration, no assignment, wrong case
// code, wrong password, case not published. Never say which part was wrong.
const fail = () => new HttpError(401, "Invalid credentials");

type Joined = {
  team_id: string;
  team_code: string; // raw 6 chars
  team_name: string;
  player_id: string;
  display_name: string;
  role: Role;
  replay: boolean;
};

export async function POST(req: Request) {
  return api(async () => {
    await checkJoinRate(req);
    const body = await readBody(req);
    const hasReg = body.registration_ref !== undefined;
    const hasTeam = body.team_code !== undefined;
    if (hasReg === hasTeam) throw fail();

    const joined = hasReg ? await joinAsHead(body) : await joinAsTeamMember(body);

    if (!joined.replay) after(() => pingTeam(joined.team_id)); // teammates see the new player live
    const res = json({
      ok: true,
      replay: joined.replay,
      team: { team_code: formatCode(joined.team_code), team_name: joined.team_name },
      player: { id: joined.player_id, display_name: joined.display_name, role: joined.role },
    });
    await issueSession(res, joined);
    return res;
  });
}

async function checkPassword(password: unknown, hash: string | undefined): Promise<boolean> {
  const pw = typeof password === "string" && password.length <= 200 ? password : "";
  const ok = await bcrypt.compare(pw, hash ?? DUMMY_HASH);
  return ok && hash !== undefined && pw.length > 0;
}

// The head joins with the registration reference (credential), the case code the organizer assigned and the case password.
// The case comes from the ADMIN's assignment for that registration, never from what the head claims.
async function joinAsHead(body: Record<string, unknown>): Promise<Joined> {
  const name = cleanName(body.display_name);
  const key = body.idempotency_key === undefined ? null : str(body.idempotency_key, "idempotency_key", 100);
  if (key !== null && key.length < 8) throw new HttpError(400, "idempotency_key is too short");

  const ref = normalizeCode(body.registration_ref, 8);
  const code = normalizeCaseCode(body.case_code);

  return withTx<Joined>(async (tx) => {
    const reg = ref
      ? await tx.query(
          `select r.id, r.team_ref, r.team_size, r.registration_status, a.id as assignment_id, a.case_id, a.team_id as assigned_team_id,
                  c.case_code, c.password_hash, c.status
             from registrations r
             left join team_case_assignments a on a.registration_id = r.id and a.status in ('assigned', 'started')
             left join cases c on c.id = a.case_id
            where r.registration_ref = $1
            for update of r`,
          [ref],
        )
      : { rows: [] as Record<string, unknown>[] };
    const r = reg.rows[0] as
      | { id: string; team_ref: string; team_size: number; registration_status: string; assignment_id: string | null; case_id: string | null; case_code: string | null; password_hash: string | null; status: string | null }
      | undefined;
    const pwOk = await checkPassword(body.case_password, r?.password_hash ?? undefined);
    if (!r || !pwOk || r.registration_status === "withdrawn" || !r.case_id || !code || code !== r.case_code) throw fail();

    // A registration owns at most one team: rejoining as its head restores that head. A team stays pinned to the content
    // version it started with, so rejoining still works after that version has been disabled for NEW assignments.
    const existing = await tx.query(
      `select t.id as team_id, t.team_code, t.team_name, p.id as player_id, p.display_name, p.role
         from teams t join players p on p.team_id = t.id and p.role = 'head'
        where t.registration_id = $1`,
      [r.id],
    );
    if (existing.rows[0]) {
      if (r.status !== "published" && r.status !== "disabled") throw fail();
      return { ...(existing.rows[0] as Omit<Joined, "replay">), replay: true };
    }
    if (r.status !== "published") throw fail(); // only a published version can start a new team

    let team: { id: string; team_code: string; team_name: string } | undefined;
    for (let i = 0; i < 20 && !team; i++) {
      const ins = await tx.query(
        `insert into teams (case_id, team_code, team_name, registration_id, paused_at)
         values ($1, $2, $3, $4, (select case when paused then now() end from game_control))
         on conflict (team_code) do nothing returning id, team_code, team_name`,
        [r.case_id, generateTeamCode(), r.team_ref, r.id],
      );
      team = ins.rows[0];
    }
    if (!team) throw new Error("could not allocate a team code");
    const p = await tx.query("insert into players (team_id, display_name, role, last_seen_at) values ($1, $2, 'head', now()) returning id", [team.id, name]);
    const playerId: string = p.rows[0].id;
    await tx.query("insert into team_progress (team_id) values ($1)", [team.id]);
    await tx.query("insert into team_scores (team_id) values ($1)", [team.id]);
    await tx.query("update team_case_assignments set team_id = $2, updated_at = now() where id = $1", [r.assignment_id, team.id]);
    if (key) await tx.query("insert into join_requests (idempotency_key, team_id, player_id) values ($1, $2, $3) on conflict do nothing", [key, team.id, playerId]);
    return { team_id: team.id, team_code: team.team_code, team_name: team.team_name, player_id: playerId, display_name: name, role: "head", replay: false };
  });
}

// Investigators join (or rejoin) with team_code + display_name. Rejoining as the head additionally
// requires the case password.
async function joinAsTeamMember(body: Record<string, unknown>): Promise<Joined> {
  const name = cleanName(body.display_name);
  const code = normalizeCode(body.team_code, 6);
  if (!code) throw fail();

  return withTx(async (tx: PoolClient) => {
    // Row lock serializes concurrent joins to the same team, so counting is safe.
    const t = await tx.query(
      `select t.id, t.team_code, t.team_name, c.status, c.password_hash, coalesce(r.team_size, ${MAX_PLAYERS}) as team_size
         from teams t join cases c on c.id = t.case_id
         left join registrations r on r.id = t.registration_id
        where t.team_code = $1 for update of t`,
      [code],
    );
    const team = t.rows[0];
    // investigators join a team that is pinned to its version: published, or retired (disabled) after the team started
    if (!team || (team.status !== "published" && team.status !== "disabled")) throw fail();

    // Same display name (any case) = rejoin: same player, same role.
    const ex = await tx.query("select id, display_name, role from players where team_id = $1 and lower(display_name) = lower($2)", [team.id, name]);
    if (ex.rows[0]) {
      if (ex.rows[0].role === "head" && !(await checkPassword(body.case_password, team.password_hash))) throw fail();
      return {
        team_id: team.id,
        team_code: team.team_code,
        team_name: team.team_name,
        player_id: ex.rows[0].id,
        display_name: ex.rows[0].display_name,
        role: ex.rows[0].role,
        replay: true,
      };
    }

    const n = await tx.query("select count(*)::int as n from players where team_id = $1", [team.id]);
    const cap = Math.min(MAX_PLAYERS, team.team_size as number);
    if (n.rows[0].n >= cap) throw new HttpError(409, `This team is full (${cap} player${cap === 1 ? "" : "s"} registered)`);

    const p = await tx.query("insert into players (team_id, display_name, role, last_seen_at) values ($1, $2, 'investigator', now()) returning id", [team.id, name]);
    return {
      team_id: team.id,
      team_code: team.team_code,
      team_name: team.team_name,
      player_id: p.rows[0].id,
      display_name: name,
      role: "investigator" as Role,
      replay: false,
    };
  });
}
