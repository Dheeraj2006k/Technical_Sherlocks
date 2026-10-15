"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GameState } from "../types";
import { phaseLabel } from "./CaseFile";

// Guided tour (PRD 17.2). It highlights real interface elements, one step at a time, and adapts to the assigned track and
// to what is on screen: a step whose anchor is missing or hidden is dropped (and re-checked while the tour runs), so it can
// never get stuck. It never blocks play: the highlight ignores the pointer, Esc or Skip always closes it, and it touches no
// game data. Whether the player finished or dismissed it is saved by the parent on the player's own record.

export type TourResult = "completed" | "dismissed";
type Step = { id: string; anchor: string | null; title: string; body: string };

export function buildSteps(gs: GameState): Step[] {
  const sql = gs.case.track === "SQL";
  const phase = gs.state === "FINAL_DEDUCTION" ? "the final deduction" : `phase ${gs.current_phase}, ${phaseLabel(gs, gs.current_phase)}`;
  return [
    {
      id: "story",
      anchor: "story",
      title: "The story of the case",
      body: "Every case is a story. This panel always shows how the case begins and what the current phase is about. Press Read the full case file (or the Case file button above) to see the whole briefing, the people involved and everything your team has uncovered so far.",
    },
    {
      id: "objective",
      anchor: "objective",
      title: "Your objective",
      body: `Case: ${gs.case.title}. Work out who is responsible and how it was done. You are in ${phase}; each phase adds new evidence and new questions, and the briefing under this heading tells you what to look for.`,
    },
    {
      id: "threads",
      anchor: "threads",
      title: "Threads, questions and unlocks",
      body: "The case is split into investigation threads. Each thread has questions with exact answers. Finishing a thread tells part of the story and can unlock more evidence; finishing every required thread opens the next phase. Optional threads can earn extra points.",
    },
    sql
      ? {
          id: "evidence",
          anchor: "workspace",
          title: "The SQL console",
          body: "This is where you examine the evidence. Write a SELECT query, press Run (or Ctrl+Enter) and read the result table. Query errors cost nothing. The SQL Field Guide button explains every SQL idea you need, and you can ignore it if you already know SQL.",
        }
      : {
          id: "evidence",
          anchor: "workspace",
          title: "The Evidence Browser",
          body: "This is where you examine the evidence, with no SQL needed. Pick a table, search every column, add filters, sort by a column and page through the rows. Browsing is free. The SQL console tab is optional; you can solve every Logic case without it.",
        },
    {
      id: "answers",
      anchor: "threads",
      title: "Answers, hints and scoring",
      body: "Type your answer into a question and press Submit. A question shows the points it pays (usually 10); every hint your team opens lowers that, step by step (10, 8, 6, 4, then 2). A wrong committed answer costs 2 points, and you can retry. Each question pays out once. Hints are shared by the whole team.",
    },
    {
      id: "team",
      anchor: "team",
      title: "Your team",
      body: "Everyone on your team shares one case, one score and one set of hints, so work together: split the threads, compare results and answer from any computer. The lead can hand threads to teammates. A solo detective can still finish every case.",
    },
    {
      id: "help",
      anchor: "help",
      title: "Help is always here",
      body: sql
        ? "Open Help any time to replay this tour, read how to play, or open the SQL Field Guide. Your score and progress are never affected by the tour or the guides."
        : "Open Help any time to replay this tour, read how to play, read the Evidence Browser guide, or open the optional SQL Field Guide. Your score and progress are never affected by the tour or the guides.",
    },
  ];
}

const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
};
const find = (anchor: string | null) => (anchor ? document.querySelector(`[data-tour="${anchor}"]`) : null);

// Mounted fresh (key) each time it is opened, so it always starts at the first step.
export default function Tour({ gs, onClose }: { gs: GameState; onClose: (r: TourResult) => void }) {
  const all = useMemo(() => buildSteps(gs), [gs]);
  const [present, setPresent] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string>("story");
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // Which steps can actually be shown right now (anchor present and visible). Re-checked while the tour is open.
  const recompute = useCallback(() => {
    const ids = all.filter((s) => s.anchor === null || visible(find(s.anchor))).map((s) => s.id);
    setPresent((prev) => (prev.join() === ids.join() ? prev : ids));
  }, [all]);

  useLayoutEffect(() => {
    const t0 = setTimeout(recompute, 0);
    const t = setInterval(recompute, 400);
    window.addEventListener("resize", recompute);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  // Steps shown. If nothing is anchored (a hidden or unusual layout) show one plain card so the tour can still be finished.
  const steps = useMemo(() => {
    const list = all.filter((s) => present.includes(s.id));
    return list.length > 0 ? list : [{ id: "fallback", anchor: null, title: "A quick orientation", body: "Read the case briefing, open the evidence, answer the questions in each thread, and use Help whenever you need the guides. You can replay this tour from Help." }];
  }, [all, present]);

  const idx = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const step = steps[idx];

  // (If the current step disappears, idx falls back to the first remaining step instead of sticking.)
  // Spotlight rectangle follows the anchor.
  useLayoutEffect(() => {
    const place = () => {
      const el = find(step.anchor);
      setRect(visible(el) ? el.getBoundingClientRect() : null);
    };
    const el = find(step.anchor);
    if (visible(el)) el.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    place();
    const t = setInterval(place, 250);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [step.anchor, step.id]);

  useEffect(() => {
    card.current?.focus();
  }, [step.id]);

  const go = useCallback(
    (to: number) => {
      const s = steps[Math.min(Math.max(0, to), steps.length - 1)];
      if (s) setCurrentId(s.id);
    },
    [steps],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose("dismissed");
      else if (e.key === "ArrowRight" && idx < steps.length - 1) go(idx + 1);
      else if (e.key === "ArrowLeft" && idx > 0) go(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, steps.length, go, onClose]);

  const last = idx === steps.length - 1;
  const narrow = typeof window !== "undefined" && window.innerWidth < 720;
  const pad = 6;
  const hole = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(360, vw - 24);
  let cardStyle: React.CSSProperties;
  if (!hole || narrow) cardStyle = narrow ? { left: 12, right: 12, bottom: 12 } : { left: Math.max(12, vw / 2 - cardW / 2), top: Math.max(12, vh / 2 - 120), width: cardW };
  else {
    const below = hole.top + hole.height + 12;
    const placeBelow = below + 220 < vh;
    const left = Math.min(Math.max(12, hole.left), vw - cardW - 12);
    cardStyle = placeBelow ? { left, top: below, width: cardW } : { left, top: Math.max(12, hole.top - 12 - 230), width: cardW };
  }

  return (
    <div className="tour-layer" data-testid="tour">
      {hole ? <div className="tour-hole" style={hole} aria-hidden="true" /> : <div className="tour-dim" aria-hidden="true" />}
      <div ref={card} className="tour-card" style={cardStyle} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" tabIndex={-1}>
        <p className="tour-step">Step {idx + 1} of {steps.length}</p>
        <h2 id="tour-title" className="tour-title">{step.title}</h2>
        <p id="tour-body" className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="btn ghost sm" onClick={() => onClose("dismissed")}>Skip tour</button>
          <span className="tour-spacer" />
          <button type="button" className="btn ghost sm" onClick={() => go(idx - 1)} disabled={idx === 0}>Back</button>
          {last ? (
            <button type="button" className="btn primary sm" onClick={() => onClose("completed")}>Finish</button>
          ) : (
            <button type="button" className="btn primary sm" onClick={() => go(idx + 1)}>Next</button>
          )}
        </div>
      </div>
    </div>
  );
}
