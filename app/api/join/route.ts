import bcrypt from "bcryptjs";
import { after } from "next/server";
import type { PoolClient } from "pg";
import { formatCode, generateTeamCode, normalizeCode } from "@/lib/codes";
import { query, withTx } from "@/lib/db";
import { cleanName, MAX_PLAYERS } from "@/lib/game";
import { api, HttpError, json, readBody, str } from "@/lib/http";
import { checkJoinRate } from "@/lib/ratelimit";
import { pingTeam } from "@/lib/realtime";
import { issueSession, type Role } from "@/lib/session";

// Compared against when the code isn't found, so timing doesn't reveal which codes exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

// One body, one status, for every credential failure: wrong/malformed code, wrong password,
// case not live. Never say which part was wrong.
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

class Replay extends Error {}

export async function POST(req: Request) {
  return api(async () => {
    await checkJoinRate(req);
    const body = await readBody(req);
    const hasCase = body.case_code !== undefined;
    const hasTeam = body.team_code !== undefined;
    if (hasCase === hasTeam) throw fail();

    const joined = hasCase ? await joinAsHead(body) : await joinAsTeamMember(body);

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

async function joinAsHead(body: Record<string, unknown>): Promise<Joined> {
  const name = cleanName(body.display_name);
  const key = str(body.idempotency_key, "idempotency_key", 100);
  if (key.length < 8) throw new HttpError(400, "idempotency_key is too short");
  const teamNameIn = typeof body.team_name === "string" && body.team_name.trim() ? str(body.team_name, "team_name", 40) : null;

  const code = normalizeCode(body.case_code, 8);
  const c = code
    ? await query<{ id: string; password_hash: string; status: string }>(
        "select id, password_hash, status from cases where case_code = $1",
        [code],
      )
    : { rows: [] as { id: string; password_hash: string; status: string }[] };
  const found = c.rows[0];
  const pwOk = await checkPassword(body.case_password, found?.password_hash);
  if (!found || !pwOk || found.status !== "live") throw fail();
  const caseId = found.id;

  const existing = async () => {
    const r = await query<Joined & { case_id: string }>(JOINED_BY_KEY, [key]);
    if (!r.rows[0]) return null;
    if (r.rows[0].case_id !== caseId) throw new HttpError(409, "idempotency_key was already used");
    return { ...r.rows[0], replay: true };
  };

  const prior = await existing();
  if (prior) return prior;

  try {
    return await withTx<Joined>(async (tx) => {
      let team: { id: string; team_code: string; team_name: string } | undefined;
      for (let i = 0; i < 20 && !team; i++) {
        const tc = generateTeamCode();
        const r = await tx.query(
          `insert into teams (case_id, team_code, team_name, paused_at)
           values ($1, $2, $3, (select case when paused then now() end from game_control))
           on conflict (team_code) do nothing returning id, team_code, team_name`,
          [caseId, tc, teamNameIn ?? `${name}'s team`],
        );
        team = r.rows[0];
      }
      if (!team) throw new Error("could not allocate a team code");
      const p = await tx.query(
        "insert into players (team_id, display_name, role, last_seen_at) values ($1, $2, 'head', now()) returning id",
        [team.id, name],
      );
      const playerId: string = p.rows[0].id;
      await tx.query("insert into team_progress (team_id) values ($1)", [team.id]);
      await tx.query("insert into team_scores (team_id) values ($1)", [team.id]);
      // A concurrent request with the same key blocks here until we commit, then conflicts.
      const jr = await tx.query(
        `insert into join_requests (idempotency_key, team_id, player_id) values ($1, $2, $3)
         on conflict (idempotency_key) do nothing returning id`,
        [key, team.id, playerId],
      );
      if (jr.rowCount === 0) throw new Replay();
      return {
        team_id: team.id,
        team_code: team.team_code,
        team_name: team.team_name,
        player_id: playerId,
        display_name: name,
        role: "head",
        replay: false,
      };
    });
  } catch (e) {
    if (e instanceof Replay) {
      const again = await existing();
      if (again) return again;
    }
    throw e;
  }
}

const JOINED_BY_KEY = `
  select t.id as team_id, t.case_id, t.team_code, t.team_name, p.id as player_id, p.display_name, p.role
    from join_requests jr
    join teams t on t.id = jr.team_id
    join players p on p.id = jr.player_id
   where jr.idempotency_key = $1`;

// Investigators join (or rejoin) with team_code + display_name. Rejoining as the head additionally
// requires the case password.
async function joinAsTeamMember(body: Record<string, unknown>): Promise<Joined> {
  const name = cleanName(body.display_name);
  const code = normalizeCode(body.team_code, 6);
  if (!code) throw fail();

  return withTx(async (tx: PoolClient) => {
    // Row lock serializes concurrent joins to the same team, so counting is safe.
    const t = await tx.query(
      `select t.id, t.team_code, t.team_name, c.status, c.password_hash
         from teams t join cases c on c.id = t.case_id
        where t.team_code = $1 for update of t`,
      [code],
    );
    const team = t.rows[0];
    if (!team || team.status !== "live") throw fail();

    // Same display name (any case) = rejoin: same player, same role.
    const ex = await tx.query(
      "select id, display_name, role from players where team_id = $1 and lower(display_name) = lower($2)",
      [team.id, name],
    );
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
    if (n.rows[0].n >= MAX_PLAYERS) throw new HttpError(409, `This team is full (${MAX_PLAYERS} players max)`);

    const p = await tx.query(
      "insert into players (team_id, display_name, role, last_seen_at) values ($1, $2, 'investigator', now()) returning id",
      [team.id, name],
    );
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
