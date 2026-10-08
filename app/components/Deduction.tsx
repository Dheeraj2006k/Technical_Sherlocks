"use client";

import { useEffect, useState } from "react";
import type { Act, GameState, Notify } from "../types";
import { fmtClock } from "../phases";
import { friendlyError } from "./api";
import { Avatar, Icon, Modal } from "./ui";

export function FinalDeduction({ gs, act, notify }: { gs: GameState; act: Act; notify: Notify }) {
  const [pick, setPick] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const chosen = gs.roster.find((c) => c.id === pick);

  async function accuse() {
    if (!pick || busy) return;
    setBusy(true);
    const r = await act("/api/submit-culprit", { character_id: pick });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) notify("error", friendlyError(r));
  }

  return (
    <section className="deduction" aria-labelledby="deduction-title">
      <div className="deduction-glow" aria-hidden="true" />
      <p className="eyebrow"><Icon name="scales" size={14} /> All three phases cleared</p>
      <h2 id="deduction-title" className="deduction-title">The final deduction</h2>
      <p className="deduction-sub">You have one accusation. Choose carefully.</p>

      <div role="radiogroup" aria-label="Choose the culprit" className="suspect-grid">
        {gs.roster.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={pick === c.id}
            className={`suspect-card ${pick === c.id ? "picked" : ""}`}
            onClick={() => setPick(c.id)}
          >
            <Avatar name={c.name} size={56} />
            <b>{c.name}</b>
            <span>{c.role ?? "Person of interest"}</span>
          </button>
        ))}
      </div>

      <div className="deduction-actions">
        <button type="button" className="btn danger lg" disabled={!pick} onClick={() => setConfirm(true)}>
          Accuse {chosen ? chosen.name : "…"}
        </button>
        <p className="hint">Use the console and evidence board below to check your reasoning before you decide.</p>
      </div>

      <Modal open={confirm} title="Submit accusation?" tone="danger" onClose={() => setConfirm(false)}>
        <p>You are accusing <b>{chosen?.name}</b>{chosen?.role ? `, ${chosen.role}` : ""}.</p>
        <p className="warn-line"><Icon name="alert" size={16} /> This decision cannot be changed.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Review again</button>
          <button type="button" className="btn danger" onClick={accuse} disabled={busy}>{busy ? "Submitting…" : "Submit accusation"}</button>
        </div>
      </Modal>
    </section>
  );
}

function CountUp({ to }: { to: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => setN(to), 0);
      return () => clearTimeout(t);
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 1100);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{n}</>;
}

export function Resolution({ gs }: { gs: GameState }) {
  const solved = gs.culprit.correct === true;
  const accused = gs.roster.find((c) => c.id === gs.culprit.chosen_character_id);
  const sol = gs.solution;
  return (
    <section className={`resolution ${solved ? "solved" : "unsolved"}`} aria-labelledby="res-title">
      <p className="eyebrow">{solved ? "Case closed" : "Case file closed"}</p>
      <h1 id="res-title" className="resolution-title">{solved ? "Case solved" : "Case remains unsolved"}</h1>
      <p className="resolution-sub">
        {solved ? "You followed the evidence to the right person." : "The accusation did not hold. The culprit remains at large."}
      </p>

      <dl className="result-stats">
        <div><dt>Final score</dt><dd><CountUp to={gs.scores.total_pts} /> <small>/ 100</small></dd></div>
        <div><dt>Time</dt><dd>{fmtClock(gs.team.elapsed_s)}</dd></div>
        <div><dt>You accused</dt><dd className="accused">{accused ? <><Avatar name={accused.name} size={30} /> {accused.name}</> : "—"}</dd></div>
      </dl>

      {solved && sol && (
        <div className="reveal">
          <div className="reveal-grid">
            <article className="reveal-card culprit">
              <h3>Culprit</h3>
              {sol.culprit && <p className="culprit-name"><Avatar name={sol.culprit} size={46} /> <b>{sol.culprit}</b></p>}
            </article>
            <article className="reveal-card"><h3>Motive</h3><p>{sol.motive}</p></article>
            <article className="reveal-card"><h3>Method</h3><p>{sol.method}</p></article>
          </div>
          <article className="reveal-card chain">
            <h3>Evidence chain</h3>
            <ol>{sol.chain.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </article>
        </div>
      )}

      <p className="resolution-actions">
        <a className="btn primary lg" href="/leaderboard">View the investigation board</a>
      </p>
    </section>
  );
}
