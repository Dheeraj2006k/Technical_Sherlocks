import type { GameState } from "../types";
import { PHASES } from "../phases";
import { Icon } from "./ui";

const ORDER = ["WAITING", "PHASE_1", "PHASE_2", "PHASE_3", "FINAL_DEDUCTION", "FINISHED"] as const;
const idx = (s: GameState["state"]) => ORDER.indexOf(s);

export function timelineSteps(gs: GameState) {
  const at = idx(gs.state);
  const solvedIn = (p: number) => gs.evidence.filter((e) => e.phase === p).length;
  const p1Cleared = at > 1;
  const steps = [
    { label: "Case opened", done: at >= 1 },
    { label: "Scene analyzed", done: p1Cleared || solvedIn(1) >= 2 },
    { label: "Access verified", done: p1Cleared },
    { label: "Evidence connected", done: at > 2 },
    { label: "Motive established", done: at > 3 },
    { label: "Culprit identified", done: gs.state === "FINISHED" && gs.culprit.correct === true },
  ];
  const current = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ ...s, current: i === current }));
}

// Vertical investigation timeline (case panel).
export function Timeline({ gs }: { gs: GameState }) {
  return (
    <ol className="timeline" aria-label="Investigation timeline">
      {timelineSteps(gs).map((s) => (
        <li key={s.label} className={`${s.done ? "done" : ""} ${s.current ? "current" : ""}`} aria-current={s.current ? "step" : undefined}>
          <i aria-hidden="true">{s.done ? <Icon name="check" size={12} /> : null}</i>
          <span>{s.label}</span>
          <span className="sr-only">{s.done ? " (complete)" : s.current ? " (in progress)" : " (locked)"}</span>
        </li>
      ))}
    </ol>
  );
}

// Compact phase stepper for the top bar.
export function PhaseStepper({ gs }: { gs: GameState }) {
  const at = idx(gs.state);
  const items = [...PHASES.map((p) => ({ key: `p${p.n}`, label: `P${p.n}`, full: p.title, done: at > p.n, current: at === p.n })), { key: "f", label: "★", full: "Final deduction", done: at > 4, current: at === 4 }];
  return (
    <ol className="stepper" aria-label="Phase progress">
      {items.map((it) => (
        <li key={it.key} className={`${it.done ? "done" : ""} ${it.current ? "current" : ""}`} title={it.full} aria-current={it.current ? "step" : undefined}>
          <span aria-hidden="true">{it.label}</span>
          <span className="sr-only">{it.full}{it.done ? ", complete" : it.current ? ", current" : ", locked"}</span>
        </li>
      ))}
    </ol>
  );
}
