"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtClock } from "../phases";
import { Icon, Modal, StatusPill, ToastRegion, type ToastItem } from "../components/ui";

type Team = {
  team_code: string;
  team_name: string;
  case_title: string;
  state: string;
  total_pts: number;
  players: number;
  elapsed_s: number;
  paused: boolean;
  status: string;
  idle_s: number;
  recent_errors: number;
};
type Detail = {
  team_name: string;
  players: { display_name: string; role: string }[];
  submissions: { phase: number; difficulty: string; prompt_text: string; submitted_value: string; is_correct: boolean; submitted_at: string; player: string }[];
  queries: { created_at: string; player: string | null; success: boolean; error_type: string | null; row_count: number | null; execution_time_ms: number | null }[];
};
type Confirm = { title: string; body: string; label: string; tone: "default" | "danger"; run: () => Promise<void> };

const STAGES: { key: string; label: string; pct: number }[] = [
  { key: "WAITING", label: "Lobby", pct: 0 },
  { key: "PHASE_1", label: "Phase 1", pct: 10 },
  { key: "PHASE_2", label: "Phase 2", pct: 40 },
  { key: "PHASE_3", label: "Phase 3", pct: 70 },
  { key: "FINAL_DEDUCTION", label: "Final deduction", pct: 90 },
  { key: "FINISHED", label: "Finished", pct: 100 },
];
const STATUS_TONE: Record<string, "green" | "amber" | "red" | "cyan" | "muted"> = { playing: "cyan", finished: "green", paused: "red", waiting: "muted", idle: "amber" };

async function post(path: string, body: unknown) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, data: (await r.json().catch(() => ({}))) as { error?: string } };
  } catch {
    return { ok: false, data: { error: "Network error. Is the server reachable?" } };
  }
}

export default function AdminView() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [gamePaused, setGamePaused] = useState(false);
  const [detail, setDetail] = useState<{ code: string; d: Detail } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [connected, setConnected] = useState(true);

  const toast = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/dashboard", { cache: "no-store" });
      if (r.status === 401) return setAuthed(false);
      const d = await r.json();
      setTeams(d.teams);
      setGamePaused(d.game_paused);
      setAuthed(true);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 3000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await post("/api/admin/login", { password });
    setBusy(false);
    if (!r.ok) return setLoginError(r.data.error === "Invalid credentials" ? "That password was not accepted." : (r.data.error ?? "Sign-in failed."));
    setPassword("");
    setLoginError("");
    load();
  }

  async function act(path: string, body: unknown, success: string) {
    const r = await post(path, body);
    if (r.ok) toast("success", success);
    else toast("error", r.data.error ?? "Action failed.");
    load();
  }

  async function inspect(code: string) {
    const r = await fetch(`/api/admin/team?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    if (r.ok) setDetail({ code, d: await r.json() });
    else toast("error", "Could not load that team.");
  }

  if (authed === null) return <main id="main" className="splash grid-bg"><p className="muted">Connecting to mission control…</p></main>;

  if (!authed) {
    return (
      <main id="main" className="admin-login grid-bg">
        <form onSubmit={login} className="panel stack narrow" aria-labelledby="al-title">
          <p className="eyebrow"><Icon name="lock" size={14} /> Restricted</p>
          <h1 id="al-title" className="panel-title">Organizer sign-in</h1>
          <label className="field">
            <span>Admin password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required aria-invalid={!!loginError} aria-describedby={loginError ? "al-err" : undefined} />
          </label>
          {loginError && <p id="al-err" className="form-error" role="alert"><Icon name="alert" size={16} /> {loginError}</p>}
          <button type="submit" className="btn primary lg" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
        </form>
      </main>
    );
  }

  const active = teams.filter((t) => t.status !== "finished");
  const finished = teams.filter((t) => t.status === "finished").length;
  const errors = teams.reduce((n, t) => n + t.recent_errors, 0);
  const cases = new Set(active.map((t) => t.case_title)).size;
  const avg = teams.length ? Math.round(teams.reduce((n, t) => n + (STAGES.find((s) => s.key === t.state)?.pct ?? 0), 0) / teams.length) : 0;
  const dist = STAGES.map((s) => ({ ...s, n: teams.filter((t) => t.state === s.key).length }));
  const maxN = Math.max(1, teams.length);

  return (
    <main id="main" className="mission grid-bg">
      <header className="mission-head">
        <div>
          <p className="eyebrow"><Icon name="bolt" size={14} /> Mission control</p>
          <h1>Organizer dashboard</h1>
        </div>
        <div className="mission-actions">
          <span className={`conn ${connected ? "live" : "reconnecting"}`} role="status"><i aria-hidden="true" /> {connected ? "Live" : "Reconnecting…"}</span>
          <a className="btn ghost sm" href="/api/admin/export">Export CSV</a>
          <a className="btn ghost sm" href="/leaderboard" target="_blank" rel="noreferrer">Open board</a>
          <button type="button" className="btn ghost sm" onClick={async () => { await post("/api/admin/logout", {}); setAuthed(false); }}>Sign out</button>
        </div>
      </header>

      <section className="tiles" aria-label="Game overview">
        <div className={`tile status ${gamePaused ? "paused" : "running"}`}>
          <span className="tile-label">Game status</span>
          <b className="tile-value">{gamePaused ? "GAME PAUSED" : "Game running"}</b>
          <button
            type="button"
            className={`btn ${gamePaused ? "primary" : "danger"} sm`}
            onClick={() =>
              gamePaused
                ? act("/api/admin/pause", { scope: "global", paused: false }, "Game resumed for every team.")
                : setConfirm({ title: "Pause the whole game?", body: "Every team's timer stops and nobody can query or submit until you resume. Nothing is lost.", label: "Pause all teams", tone: "danger", run: () => act("/api/admin/pause", { scope: "global", paused: true }, "Game paused for every team.") })
            }
          >
            {gamePaused ? "Resume all" : "Pause all"}
          </button>
        </div>
        <div className="tile"><span className="tile-label">Active cases</span><b className="tile-value">{cases}</b></div>
        <div className="tile"><span className="tile-label">Active teams</span><b className="tile-value">{active.length}</b></div>
        <div className="tile"><span className="tile-label">Finished teams</span><b className="tile-value green">{finished}</b></div>
        <div className="tile"><span className="tile-label">Recent errors (5 min)</span><b className={`tile-value ${errors ? "amber" : ""}`}>{errors}</b></div>
        <div className="tile">
          <span className="tile-label">Average progress</span>
          <b className="tile-value">{avg}%</b>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={avg} aria-label="Average progress"><i style={{ width: `${avg}%` }} /></div>
        </div>
      </section>

      <section className="panel" aria-labelledby="dist-title">
        <h2 id="dist-title" className="panel-title">Phase distribution</h2>
        <ul className="dist">
          {dist.map((d) => (
            <li key={d.key}>
              <span className="dist-label">{d.label}</span>
              <span className="dist-bar" aria-hidden="true"><i style={{ width: `${(d.n / maxN) * 100}%` }} /></span>
              <b>{d.n}</b>
              <span className="sr-only"> teams in {d.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="teams-title">
        <h2 id="teams-title" className="panel-title">Teams</h2>
        {teams.length === 0 ? (
          <p className="empty">No teams yet. They appear here the moment a head opens a case.</p>
        ) : (
          <div className="table-wrap">
            <table className="lb admin-table">
              <caption className="sr-only">All investigation teams</caption>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Case</th>
                  <th scope="col">Phase</th>
                  <th scope="col" className="num">Score</th>
                  <th scope="col" className="num">Elapsed</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Errors</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.team_code}>
                    <td><b className="team-name">{t.team_name}</b><span className="case-name mono">{t.team_code} · {t.players} player{t.players === 1 ? "" : "s"}</span></td>
                    <td>{t.case_title}</td>
                    <td>{STAGES.find((s) => s.key === t.state)?.label ?? t.state}</td>
                    <td className="num"><b>{t.total_pts}</b></td>
                    <td className="num mono">{fmtClock(t.elapsed_s)}</td>
                    <td>
                      <StatusPill tone={STATUS_TONE[t.status] ?? "muted"}>{t.status}</StatusPill>
                      {t.status === "idle" && <span className="case-name">{Math.round(t.idle_s / 60)} min quiet</span>}
                    </td>
                    <td className="num">{t.recent_errors > 0 ? <StatusPill tone="amber">{t.recent_errors}</StatusPill> : "0"}</td>
                    <td><div className="row-actions">
                      <button type="button" className="btn ghost sm" onClick={() => inspect(t.team_code)}>Inspect</button>
                      <button type="button" className="btn ghost sm" onClick={() => act("/api/admin/pause", { scope: "team", team_code: t.team_code, paused: !t.paused }, t.paused ? `${t.team_name} resumed.` : `${t.team_name} paused.`)}>
                        {t.paused ? "Resume" : "Pause"}
                      </button>
                      <button type="button" className="btn warn sm" onClick={() => setConfirm({ title: `Reset ${t.team_name}?`, body: "Their progress, answers and score are wiped and the timer restarts. Players and the team code are kept.", label: "Reset team", tone: "danger", run: () => act("/api/admin/reset-team", { team_code: t.team_code, mode: "state" }, `${t.team_name} was reset.`) })}>
                        Reset
                      </button>
                      <button type="button" className="btn danger sm" onClick={() => setConfirm({ title: `Delete ${t.team_name}?`, body: "The team, its players and all progress are removed permanently and their sessions stop working.", label: "Delete team", tone: "danger", run: () => act("/api/admin/reset-team", { team_code: t.team_code, mode: "delete" }, `${t.team_name} was deleted.`) })}>
                        Delete
                      </button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail && (
        <section className="panel inspect" aria-labelledby="insp-title">
          <header className="top">
            <h2 id="insp-title" className="panel-title">{detail.d.team_name} <span className="mono muted">({detail.code})</span></h2>
            <button type="button" className="btn ghost sm" onClick={() => setDetail(null)}>Close</button>
          </header>
          <p className="muted">{detail.d.players.map((p) => `${p.display_name} (${p.role})`).join(", ")}</p>
          <div className="inspect-grid">
            <div>
              <h3 className="block-title">Submitted answers</h3>
              <div className="table-wrap short">
                <table className="lb compact">
                  <tbody>
                    {detail.d.submissions.length === 0 && <tr><td className="muted">No answers yet.</td></tr>}
                    {detail.d.submissions.map((s, i) => (
                      <tr key={i}>
                        <td className="mono">{new Date(s.submitted_at).toLocaleTimeString()}</td>
                        <td>P{s.phase} {s.difficulty}</td>
                        <td>{s.player}</td>
                        <td className="mono">{s.submitted_value}</td>
                        <td>{s.is_correct ? <StatusPill tone="green">correct</StatusPill> : <StatusPill tone="muted">wrong</StatusPill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className="block-title">Recent queries</h3>
              <div className="table-wrap short">
                <table className="lb compact">
                  <tbody>
                    {detail.d.queries.length === 0 && <tr><td className="muted">No queries yet.</td></tr>}
                    {detail.d.queries.map((q, i) => (
                      <tr key={i}>
                        <td className="mono">{new Date(q.created_at).toLocaleTimeString()}</td>
                        <td>{q.player}</td>
                        <td>{q.success ? <StatusPill tone="green">ok</StatusPill> : <StatusPill tone="amber">{q.error_type ?? "error"}</StatusPill>}</td>
                        <td className="mono">{q.row_count ?? ""} rows</td>
                        <td className="mono">{q.execution_time_ms ?? ""} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}

      <Modal open={confirm !== null} title={confirm?.title ?? ""} tone={confirm?.tone} onClose={() => setConfirm(null)}>
        <p>{confirm?.body}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm) return;
              setBusy(true);
              await confirm.run();
              setBusy(false);
              setConfirm(null);
            }}
          >
            {confirm?.label}
          </button>
        </div>
      </Modal>
      <ToastRegion toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </main>
  );
}
