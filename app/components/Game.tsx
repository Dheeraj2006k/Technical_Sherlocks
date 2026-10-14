"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Act, ConnectionMode, GameState, Notify } from "../types";
import { fmtClock, PHASES } from "../phases";
import { Avatar, Icon } from "./ui";
import { post } from "./api";
import CaseFile, { StoryBanner, phaseLabel } from "./CaseFile";
import FieldGuide from "./FieldGuide";
import HelpMenu, { FieldGuideLauncher } from "./Help";
import Tour, { type TourResult } from "./Tour";
import Lobby from "./Lobby";
import SqlConsole from "./SqlConsole";
import Threads from "./Threads";
import EvidenceBrowser from "./EvidenceBrowser";
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

function TopBar({ gs, at, mode, delta, onLeave, help, onCaseFile }: { gs: GameState; at: number; mode: ConnectionMode; delta: { n: number; id: number } | null; onLeave: () => void; help: ReactNode; onCaseFile: () => void }) {
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
        <button type="button" className="btn ghost sm casefile-btn" onClick={onCaseFile} data-tour="casefile" data-testid="case-file-button"><Icon name="folder" size={15} /> Case file</button>
        {help}
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
      <header className="phase-banner" data-tour="objective">
        <p className="phase-no">{phase === 4 ? "Final deduction" : `Phase ${phase} of 3`}</p>
        <h2 className="phase-name">{phase === 4 ? "Name who and how" : phaseLabel(gs, phase)}</h2>
        <p className="phase-focus">{meta ? meta.focus : "Who is responsible, and how"}</p>
      </header>

      {current?.clue_text && (
        <article className="narrative paper" aria-label={`Phase ${current.phase} briefing`}>
          <p className="paper-label">Briefing · Phase {current.phase}</p>
          <p>{current.clue_text}</p>
        </article>
      )}
      {older.map((n) => (
        <details key={n.phase} className="narrative-old">
          <summary>Phase {n.phase} briefing · {phaseLabel(gs, n.phase)}</summary>
          <p>{n.clue_text}</p>
        </details>
      ))}

      <div className="block">
        <h3 className="block-title">Open evidence</h3>
        <ul className="chips">{gs.unlocked_tables.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>

      <div className="block" data-tour="team">
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
  const isLogic = gs.case.track === "LOGIC";
  const [tabChoice, setTab] = useState<"browser" | "console" | "evidence" | null>(null);
  const tab = tabChoice ?? (isLogic ? "browser" : "console");
  const answeredCount = gs.threads.flatMap((t) => t.questions).filter((q) => q.completed).length;
  const inGame = gs.state === "PHASE_1" || gs.state === "PHASE_2" || gs.state === "PHASE_3" || gs.state === "FINAL_DEDUCTION";

  // Help, the SQL Field Guide and the guided tour. All three are presentation only: they hold their own UI state and call no
  // game endpoint. The only server write is the player's own tour flag (completed / dismissed), saved best-effort.
  const [guideOpen, setGuideOpen] = useState(false);
  const [tourRun, setTourRun] = useState(0); // 0 = closed; each open mounts a fresh tour at its first step
  const openTour = useCallback(() => setTourRun((n) => n + 1), []);
  const guideBtn = useRef<HTMLDivElement>(null);
  const autoTried = useRef(false);
  const tourKey = `slc-tour:${gs.me.player_id}`;
  const serverTour = gs.me.tour_state;

  // First visit in this browser tab: the case file opens first so the story is read before anything else; the guided tour
  // follows when the player has neither finished nor dismissed it. Both are shown at most once per tab (sessionStorage) and the
  // case file can be reopened any time from the top bar or the Help menu.
  const [fileOpen, setFileOpen] = useState(false);
  const openFile = useCallback(() => setFileOpen(true), []);
  const tourAfterFile = useRef(false);
  const storyKey = `slc-story:${gs.me.player_id}:${gs.case.code}`;
  useEffect(() => {
    if (autoTried.current || !inGame) return;
    autoTried.current = true;
    let seenStory = false;
    let seenTour = false;
    try {
      seenStory = sessionStorage.getItem(storyKey) !== null;
      seenTour = sessionStorage.getItem(tourKey) !== null;
    } catch {
      /* storage may be blocked; the server flag is the real record of the tour */
    }
    const wantTour = serverTour === null && !seenTour;
    if (!seenStory) {
      try {
        sessionStorage.setItem(storyKey, "1");
      } catch {
        /* ignore */
      }
      tourAfterFile.current = wantTour;
      openFile();
    } else if (wantTour) {
      openTour();
    }
  }, [inGame, serverTour, tourKey, storyKey, openTour, openFile]);
  const closeFile = useCallback(() => {
    setFileOpen(false);
    if (tourAfterFile.current) {
      tourAfterFile.current = false;
      openTour();
    }
  }, [openTour]);

  const closeTour = useCallback(
    async (result: TourResult) => {
      setTourRun(0); // never keep the player behind the tour, whatever happens next
      try {
        sessionStorage.setItem(tourKey, result);
      } catch {
        /* ignore */
      }
      const r = await post("/api/tour", { state: result });
      if (!r.ok) notify("info", "Your tour progress could not be saved. You can keep playing; replay the tour from Help any time.");
    },
    [notify, tourKey],
  );
  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    guideBtn.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  return (
    <div className="shell grid-bg">
      <TopBar gs={gs} at={at} mode={mode} delta={delta} onLeave={onLeave} onCaseFile={openFile} help={<HelpMenu gs={gs} sqlAvailable={inGame} onTour={openTour} onFieldGuide={() => setGuideOpen(true)} onCaseFile={openFile} />} />
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
            <StoryBanner gs={gs} onOpen={openFile} />
            {gs.state === "FINAL_DEDUCTION" && <FinalDeduction gs={gs} act={act} notify={notify} />}
            <div className="workspace">
              <CasePanel gs={gs} />
              <div className="center">
                <div role="tablist" aria-label="Workspace" className="tabs inline" data-tour="workspace">
                  {isLogic && (
                    <button type="button" role="tab" id="tab-browser" aria-selected={tab === "browser"} aria-controls="pane-browser" className={tab === "browser" ? "on" : ""} onClick={() => setTab("browser")}>Evidence browser</button>
                  )}
                  <button type="button" role="tab" id="tab-console" aria-selected={tab === "console"} aria-controls="pane-console" className={tab === "console" ? "on" : ""} onClick={() => setTab("console")}>{isLogic ? "SQL console (optional)" : "SQL console"}</button>
                  <button type="button" role="tab" id="tab-evidence" aria-selected={tab === "evidence"} aria-controls="pane-evidence" className={tab === "evidence" ? "on" : ""} onClick={() => setTab("evidence")}>
                    Evidence board <span className="count">{answeredCount}</span>
                  </button>
                </div>
                {isLogic && (
                  <div role="tabpanel" id="pane-browser" aria-labelledby="tab-browser" hidden={tab !== "browser"}>
                    <EvidenceBrowser unlocked={gs.unlocked_tables} paused={gs.paused} />
                  </div>
                )}
                <div role="tabpanel" id="pane-console" aria-labelledby="tab-console" hidden={tab !== "console"}>
                  <SqlConsole tables={gs.unlocked_tables} paused={gs.paused} />
                </div>
                <div role="tabpanel" id="pane-evidence" aria-labelledby="tab-evidence" hidden={tab !== "evidence"}>
                  <EvidenceBoard gs={gs} />
                </div>
              </div>
              <Threads gs={gs} act={act} notify={notify} />
            </div>
          </>
        )}
      </main>
      {inGame && (isLogic ? tab === "console" : true) && (
        <div ref={guideBtn}>
          <FieldGuideLauncher open={guideOpen} onClick={() => setGuideOpen((v) => !v)} />
        </div>
      )}
      <FieldGuide open={guideOpen} onClose={closeGuide} />
      <CaseFile open={fileOpen} gs={gs} onClose={closeFile} />
      {tourRun > 0 && inGame && <Tour key={tourRun} gs={gs} onClose={closeTour} />}
    </div>
  );
}
