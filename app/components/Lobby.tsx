"use client";

import { useState } from "react";
import type { Act, GameState, Notify } from "../types";
import { friendlyError } from "./api";
import { Avatar, Icon, StatusPill } from "./ui";

export default function Lobby({ gs, act, notify }: { gs: GameState; act: Act; notify: Notify }) {
  const isHead = gs.me.role === "head";
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    const r = await act("/api/start");
    setBusy(false);
    if (!r.ok) notify("error", friendlyError(r));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(gs.team.team_code);
      notify("success", "Team code copied.");
    } catch {
      notify("info", "Select the code and copy it manually.");
    }
  }

  return (
    <div className="lobby">
      <section className="file-card" aria-labelledby="case-title">
        <p className="eyebrow dark"><Icon name="folder" size={14} /> Case file</p>
        <h1 id="case-title" className="file-title">{gs.case.title}</h1>
        {gs.case.hook_text && <p className="file-hook">{gs.case.hook_text}</p>}
        <div className="file-meta">
          <span>Status: <b>awaiting briefing</b></span>
          <span>Phases: <b>3 + final deduction</b></span>
        </div>
      </section>

      <section className="panel team" aria-labelledby="team-title">
        <h2 id="team-title" className="panel-title">Investigation team</h2>
        <div className="teamcode-box">
          <p className="muted-label">Team code · share it with your teammates</p>
          <div className="teamcode-row">
            <span className="teamcode" aria-label={`Team code ${gs.team.team_code.split("").join(" ")}`}>{gs.team.team_code}</span>
            <button type="button" className="btn ghost sm" onClick={copy}><Icon name="copy" size={15} /> Copy</button>
          </div>
        </div>
        <ul className="roster" aria-label="Team members">
          {gs.players.map((p) => (
            <li key={p.id} className="player-card">
              <Avatar name={p.display_name} size={44} online={p.online} />
              <div className="player-meta">
                <b>{p.display_name}{p.id === gs.me.player_id ? " (you)" : ""}</b>
                <span>{p.role === "head" ? "Team lead" : "Investigator"}</span>
              </div>
              <StatusPill tone={p.online ? "green" : "muted"}>{p.online ? "Online" : "Offline"}</StatusPill>
            </li>
          ))}
          {gs.players.length < 3 && (
            <li className="player-card empty" aria-label="Open seat">
              <span className="avatar ghost" aria-hidden="true"><Icon name="user" size={20} /></span>
              <div className="player-meta"><b>Open seat</b><span>Teammates can still join with the code</span></div>
            </li>
          )}
        </ul>
        {isHead ? (
          <div className="stack">
            <button type="button" className="btn primary lg" onClick={start} disabled={busy}>
              {busy ? "Opening the case…" : "Start investigation"}
            </button>
            <p className="hint">You can start now or wait for teammates. Teams of 1 to 3 are fine.</p>
          </div>
        ) : (
          <p className="waiting" role="status">
            Waiting for the team lead to open the case<span className="dots" aria-hidden="true"><i /><i /><i /></span>
          </p>
        )}
      </section>
    </div>
  );
}
