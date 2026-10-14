"use client";

import { useEffect, useRef, useState } from "react";
import type { GameState } from "../types";
import { Icon, Modal } from "./ui";

// The persistent Help menu (PRD 17.3): reopen the guided tour, read the basic rules, read the Evidence Browser
// instructions (Logic track) and open the SQL Field Guide where the SQL console exists. Static text only.

export function HowToPlay({ track }: { track: "SQL" | "LOGIC" }) {
  return (
    <div className="help-copy">
      <p><b>The goal.</b> Work out who is responsible and how it was done. A case has three phases; each phase has investigation threads, and each thread has questions with exact answers. Finishing the required threads opens the next phase and its evidence.</p>
      <p><b>Evidence.</b> {track === "SQL" ? "Query the evidence tables in the SQL console. Open the Evidence tables list to see what is unlocked." : "Browse the evidence in the Evidence Browser: search, filter, sort and page through the records. No SQL is needed. The SQL console is optional."} Some threads unlock extra evidence when they open or when you complete them.</p>
      <p><b>Scoring.</b> Every question shows how many points it is worth, usually 10. Each hint your team opens lowers what the question still pays, step by step (on a 10-point question: 10, 8, 6, 4, then 2). A wrong committed answer costs 2 points; you may retry. {track === "SQL" ? "SQL errors and exploratory queries are free." : "Browsing and searching are free."} Each question and each part of the final deduction pays out once. The most a case can score is 100: the questions, plus the final deduction (naming the person responsible and choosing the explanation that fits the evidence).</p>
      <p><b>Your team.</b> Everyone on the team shares the same progress, score and hints. Any teammate can answer a question, and the lead can hand threads to teammates. A solo investigator can finish every case.</p>
      <p><b>Help.</b> The guided tour can be replayed from this menu at any time. Neither the tour nor the guides change your score or your progress.</p>
    </div>
  );
}

export function BrowserGuide() {
  return (
    <div className="help-copy">
      <p>The Evidence Browser lets you work through the case records without writing any SQL, and it is enough to solve every Logic case.</p>
      <ol>
        <li><b>Choose the evidence</b> from the list at the top. Only evidence your team has unlocked appears.</li>
        <li><b>Search</b> looks in every column at once. Searching a name, a number or a code is the fastest way to find every record that mentions it.</li>
        <li><b>Filter</b> narrows a table to the exact rows you want: pick a column, an operator (is, is not, contains, greater or less than) and a value, then Apply. Add up to six filters; they all must match.</li>
        <li><b>Sort</b> by clicking a column heading. Click again to reverse. Sorting a time column puts the first or last event on top.</li>
        <li><b>Page</b> through long tables with the page buttons. The row total shows how many rows match your filters, which is how you count.</li>
        <li><b>Cross-check</b> between tables by searching for the same name, number or code in each.</li>
      </ol>
      <p>Browsing never costs points. The optional SQL console and the SQL Field Guide are there if you want them, but you never need them.</p>
    </div>
  );
}

export default function HelpMenu({
  gs,
  sqlAvailable,
  onTour,
  onFieldGuide,
  onCaseFile,
}: {
  gs: GameState;
  sqlAvailable: boolean;
  onTour: () => void;
  onFieldGuide: () => void;
  onCaseFile?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<null | "how" | "browser">(null);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const isLogic = gs.case.track === "LOGIC";

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onKey(e: React.KeyboardEvent) {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  }

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="help-wrap" ref={wrap} onKeyDown={onKey}>
      <button ref={btn} type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={open} aria-controls="help-menu" onClick={() => setOpen((v) => !v)} data-tour="help" data-testid="help-button">
        <Icon name="help" size={15} /> Help
      </button>
      {open && (
        <ul id="help-menu" className="help-menu" role="menu" aria-label="Help">
          {onCaseFile && <li role="none"><button type="button" role="menuitem" onClick={pick(onCaseFile)} data-testid="help-case-file">Read the case file</button></li>}
          <li role="none"><button type="button" role="menuitem" onClick={pick(onTour)} data-testid="help-tour">Take the guided tour</button></li>
          <li role="none"><button type="button" role="menuitem" onClick={pick(() => setModal("how"))}>How to play</button></li>
          {isLogic && <li role="none"><button type="button" role="menuitem" onClick={pick(() => setModal("browser"))}>Evidence Browser guide</button></li>}
          {sqlAvailable && <li role="none"><button type="button" role="menuitem" onClick={pick(onFieldGuide)}>{isLogic ? "SQL Field Guide (optional SQL)" : "SQL Field Guide"}</button></li>}
        </ul>
      )}
      <Modal open={modal === "how"} title="How to play" onClose={() => { setModal(null); btn.current?.focus(); }}>
        <HowToPlay track={gs.case.track} />
        <button type="button" className="btn primary" onClick={() => { setModal(null); btn.current?.focus(); }}>Close</button>
      </Modal>
      <Modal open={modal === "browser"} title="Evidence Browser guide" onClose={() => { setModal(null); btn.current?.focus(); }}>
        <BrowserGuide />
        <button type="button" className="btn primary" onClick={() => { setModal(null); btn.current?.focus(); }}>Close</button>
      </Modal>
    </div>
  );
}

export function FieldGuideLauncher({ onClick, open }: { onClick: () => void; open: boolean }) {
  return (
    <button type="button" className="fg-fab" onClick={onClick} aria-expanded={open} aria-label="Open the SQL Field Guide" data-testid="field-guide-button">
      <Icon name="book" size={20} />
      <span>SQL Field Guide</span>
    </button>
  );
}
