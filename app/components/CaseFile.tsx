"use client";

import { useState } from "react";
import type { GameState } from "../types";
import { phaseTitle } from "../phases";
import { Icon, Modal, Prose, proseBlocks } from "./ui";

// The story, made prominent (PRD 17 follow-up): a banner that is always above the workspace, and a full "case file" dialog that
// holds the hook, the people, every revealed phase briefing and the story so far. Both read only what /api/state already
// sends the player (the hook, the revealed briefings, the suspects, the story events the team has earned). Presentation only:
// opening, closing or collapsing them changes no game data.

export const phaseLabel = (gs: GameState, n: number) => gs.narrative.find((x) => x.phase === n)?.name ?? phaseTitle(n);

// A short, prose-only excerpt of the hook for the banner: the first two non-list paragraphs.
export function hookExcerpt(hook: string | null): string {
  if (!hook) return "";
  return proseBlocks(hook)
    .filter((b) => b.kind === "p")
    .slice(0, 2)
    .map((b) => b.lines.join(" "))
    .join("\n\n");
}

export function StoryBanner({ gs, onOpen }: { gs: GameState; onOpen: () => void }) {
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(`slc-story-collapsed:${gs.case.code}`) !== "1";
    } catch {
      return true;
    }
  });
  const phase = gs.state === "FINAL_DEDUCTION" ? 3 : gs.current_phase;
  const current = gs.narrative.find((n) => n.phase === phase);
  const excerpt = hookExcerpt(gs.case.hook_text);
  const toggle = () => {
    setOpen(!open);
    try {
      sessionStorage.setItem(`slc-story-collapsed:${gs.case.code}`, open ? "1" : "0");
    } catch {
      /* the banner works without storage */
    }
  };
  return (
    <section className={`story-banner${open ? "" : " collapsed"}`} aria-label="The case story" data-tour="story" data-testid="story-banner">
      <div className="story-head">
        <p className="story-kicker"><Icon name="folder" size={14} /> The case</p>
        <h2 className="story-title">{gs.case.title}</h2>
        <div className="story-actions">
          <button type="button" className="btn primary sm" onClick={onOpen} data-testid="story-open">Read the full case file</button>
          <button type="button" className="btn ghost sm" onClick={toggle} aria-expanded={open} aria-controls="story-body" data-testid="story-toggle">{open ? "Hide story" : "Show story"}</button>
        </div>
      </div>
      {open && (
        <div id="story-body" className="story-body">
          {excerpt && <Prose className="story-hook" text={excerpt} />}
          {current?.clue_text && (
            <div className="story-now" key={current.phase} aria-label={`Phase ${current.phase} briefing`}>
              <p className="story-kicker">Phase {current.phase} · {phaseLabel(gs, current.phase)}</p>
              <p className="story-briefing">{current.clue_text}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function CaseFile({ open, gs, onClose }: { open: boolean; gs: GameState; onClose: () => void }) {
  const phase = gs.state === "FINAL_DEDUCTION" ? 3 : gs.current_phase;
  return (
    <Modal open={open} title={`Case file: ${gs.case.title}`} onClose={onClose} wide>
      {open && (<>
      <div className="casefile" data-testid="case-file">
        {gs.case.hook_text ? <Prose className="casefile-hook" text={gs.case.hook_text} /> : <p className="muted">The organizers have not added a briefing for this case.</p>}

        {gs.roster.length > 0 && (
          <section aria-labelledby="cf-people">
            <h3 id="cf-people" className="casefile-h">People of interest</h3>
            <ul className="people">
              {gs.roster.map((p) => (
                <li key={p.id}>
                  <b>{p.name}</b>
                  {p.role && <em>{p.role}</em>}
                  {p.profile && <span>{p.profile}</span>}
                </li>
              ))}
            </ul>
            <p className="muted small">Roles show why someone was near the events. They do not show who is responsible.</p>
          </section>
        )}

        {gs.narrative.length > 0 && (
          <section aria-labelledby="cf-briefings">
            <h3 id="cf-briefings" className="casefile-h">Briefings</h3>
            {gs.narrative.map((n) => (
              <article key={n.phase} className={`brief${n.phase === phase ? " now" : ""}`}>
                <p className="story-kicker">Phase {n.phase} · {phaseLabel(gs, n.phase)}{n.phase === phase ? " · current" : ""}</p>
                <p>{n.clue_text}</p>
              </article>
            ))}
          </section>
        )}

        {gs.story.length > 0 && (
          <section aria-labelledby="cf-story">
            <h3 id="cf-story" className="casefile-h">The story so far</h3>
            <ol className="story-so-far">
              {gs.story.map((s, i) => (
                <li key={i}><b>{s.title}</b><p>{s.body}</p></li>
              ))}
            </ol>
          </section>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onClose} data-testid="case-file-close">Close the case file</button>
      </div>
      </>)}
    </Modal>
  );
}
