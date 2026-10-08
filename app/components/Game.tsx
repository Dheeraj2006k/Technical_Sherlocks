"use client";

import { useEffect, useState } from "react";
import type { Act, ConnectionMode, GameState, Notify } from "../types";
import { fmtClock, PHASES, phaseTitle } from "../phases";
import { Avatar, Icon } from "./ui";
import Lobby from "./Lobby";
import SqlConsole from "./SqlConsole";
import Tasks from "./Tasks";
import EvidenceBoard from "./EvidenceBoard";
import { PhaseStepper, Timeline } from "./Timeline";
import { FinalDeduction, Resolution } from "./Deduction";

export type Overlay = { id: number; kind: "open" | "phase" | "final"; phase: number; tables: string[] };

function useElapsed(gs: GameState, at: number) {
  const running = !gs.paused && gs.state !== "FINISHED" && gs.state !== "WAITING";
  const [now, setNow] = useState(at);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return gs.team.elapsed_s + (running ? Math.max(0, Math.floor((Math.max(now, at) - at) / 1000)) : 0);
}

export function ConnectionBadge({ mode }: { mode: ConnectionMode }) {
  const text = mode === "live" ? "Live" : mode === "polling" ? "Synced" : "Reconnecting…";
  return (
    <span className={`conn ${mode}`} role="status" aria-label={`Connection: ${text}`}>
      <i aria-hidden="true" /> {text}
    </span>
  );
}

function TopBar({ gs, at, mode, delta, onLeave }: { gs: GameState; at: number; mode: ConnectionMode; delta: { n: number; id: number } | null; onLeave: () => void }) {
  const elapsed = useElapsed(gs, at);
  return (
    <header className="topbar">
      <div className="brand"><Icon name="magnifier" size={18} /> <span>Sherlock&apos;s Last Case</span></div>
      <div className="topbar-case" title={gs.case.title}>{gs.case.title}</div>
      <PhaseStepper gs={gs} />
      <div className="topbar-stats">
        <span className="stat" title="Elapsed time"><Icon name="clock" size={15} /> <b className="mono">{fmtClock(elapsed)}</b></span>
        <span className="stat score" title="Team score">
          <Icon name="trophy" size={15} /> <b className="mono">{gs.scores.total_pts}</b>
          {delta && <span key={delta.id} className="score-pop" aria-hidden="true">+{delta.n}</span>}
        </span>
        <ConnectionBadge mode={mode} />
        <button type="button" className="btn ghost sm" onClick={onLeave}>Leave</button>
      </div>
    </header>
  );
}

function CasePanel({ gs }: { gs: GameState }) {
  const phase = gs.state === "FINAL_DEDUCTION" ? 4 : gs.current_phase;
  const meta = PHASES.find((p) => p.n === phase);
  const current = gs.narrative.find((n) => n.phase === gs.current_phase);
  const older = gs.narrative.filter((n) => n.phase < gs.current_phase);
  return (
    <aside className="casepanel" aria-label="Case panel">
      <header className="phase-banner">
        <p className="phase-no">{phase === 4 ? "Final deduction" : `Phase ${phase} of 3`}</p>
        <h2 className="phase-name">{meta ? meta.title : "Name the culprit"}</h2>
        <p className="phase-focus">{meta ? meta.focus : "Weigh every verified clue"}</p>
      </header>

      {current?.clue_text && (
        <article className="narrative paper" aria-label={`Phase ${current.phase} briefing`}>
          <p className="paper-label">Briefing · Phase {current.phase}</p>
          <p>{current.clue_text}</p>
        </article>
      )}
      {older.map((n) => (
        <details key={n.phase} className="narrative-old">
          <summary>Phase {n.phase} briefing · {phaseTitle(n.phase)}</summary>
          <p>{n.clue_text}</p>
        </details>
      ))}

      <div className="block">
        <h3 className="block-title">Unlocked evidence tables</h3>
        <ul className="chips">{gs.unlocked_tables.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>

      <div className="block">
        <h3 className="block-title">Investigation team</h3>
        <ul className="mini-roster">
          {gs.players.map((p) => (
            <li key={p.id}>
              <Avatar name={p.display_name} size={28} online={p.online} />
              <span>{p.display_name}{p.id === gs.me.player_id ? " (you)" : ""}</span>
              <em>{p.role === "head" ? "Lead" : "Inv."}</em>
            </li>
          ))}
        </ul>
      </div>

      <div className="block">
        <h3 className="block-title">Investigation timeline</h3>
        <Timeline gs={gs} />
      </div>
    </aside>
  );
}

export function UnlockOverlay({ overlay, onDone }: { overlay: Overlay | null; onDone: () => void }) {
  useEffect(() => {
    if (!overlay) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [overlay, onDone]);
  if (!overlay) return null;
  const meta = PHASES.find((p) => p.n === overlay.phase);
  return (
    <div className="unlock" role="status" aria-live="assertive" key={overlay.id}>
      <div className="unlock-card">
        <p className="unlock-kicker">{overlay.kind === "open" ? "Case opened" : overlay.kind === "final" ? "All evidence gathered" : "New evidence unlocked"}</p>
        <p className="unlock-title">{overlay.kind === "final" ? "The final deduction" : `Phase ${overlay.phase}: ${meta?.title}`}</p>
        {overlay.tables.length > 0 && (
          <ul className="chips center">{overlay.tables.map((t) => <li key={t}>{t}</li>)}</ul>
        )}
      </div>
    </div>
  );
}

export default function Game({ gs, at, mode, delta, act, notify, onLeave }: { gs: GameState; at: number; mode: ConnectionMode; delta: { n: number; id: number } | null; act: Act; notify: Notify; onLeave: () => void }) {
  const [tab, setTab] = useState<"console" | "evidence">("console");
  const inGame = gs.state === "PHASE_1" || gs.state === "PHASE_2" || gs.state === "PHASE_3" || gs.state === "FINAL_DEDUCTION";

  return (
    <div className="shell grid-bg">
      <TopBar gs={gs} at={at} mode={mode} delta={delta} onLeave={onLeave} />
      {gs.paused && (
        <div className="paused-banner" role="alert">
          <Icon name="alert" size={18} /> <b>INVESTIGATION PAUSED</b> <span>The organizers have frozen the game. Your timer is stopped and nothing is lost.</span>
        </div>
      )}
      {mode === "reconnecting" && (
        <div className="conn-banner" role="status">Connection interrupted. Attempting to reconnect…</div>
      )}

      <main id="main" className="stage">
        {gs.state === "WAITING" && <Lobby gs={gs} act={act} notify={notify} />}
        {gs.state === "FINISHED" && <Resolution gs={gs} />}
        {inGame && (
          <>
            {gs.state === "FINAL_DEDUCTION" && <FinalDeduction gs={gs} act={act} notify={notify} />}
            <div className="workspace">
              <CasePanel gs={gs} />
              <div className="center">
                <div role="tablist" aria-label="Workspace" className="tabs inline">
                  <button type="button" role="tab" id="tab-console" aria-selected={tab === "console"} aria-controls="pane-console" className={tab === "console" ? "on" : ""} onClick={() => setTab("console")}>SQL console</button>
                  <button type="button" role="tab" id="tab-evidence" aria-selected={tab === "evidence"} aria-controls="pane-evidence" className={tab === "evidence" ? "on" : ""} onClick={() => setTab("evidence")}>
                    Evidence board <span className="count">{gs.evidence.length}</span>
                  </button>
                </div>
                <div role="tabpanel" id="pane-console" aria-labelledby="tab-console" hidden={tab !== "console"}>
                  <SqlConsole tables={gs.unlocked_tables} paused={gs.paused} />
                </div>
                <div role="tabpanel" id="pane-evidence" aria-labelledby="tab-evidence" hidden={tab !== "evidence"}>
                  <EvidenceBoard gs={gs} />
                </div>
              </div>
              <Tasks gs={gs} act={act} notify={notify} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
