"use client";

import { useEffect, useRef, useState } from "react";
import type { Act, GameState, Notify } from "../types";
import { fmtClock } from "../phases";
import { friendlyError } from "./api";
import { Avatar, Icon, Modal } from "./ui";

type Component = "culprit" | "mechanism";

function useSubmitFinal(act: Act, notify: Notify, component: Component) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const keyRef = useRef<string | null>(null);

  async function submit(value: string) {
    if (busy) return;
    setBusy(true);
    keyRef.current ??= crypto.randomUUID();
    const r = await act("/api/submit-final", { component, value, idempotency_key: keyRef.current });
    setBusy(false);
    if (r.status === 0) {
      notify("error", friendlyError(r)); // keep the key: the retry is safe
      return;
    }
    keyRef.current = null;
    if (!r.ok) return notify("error", friendlyError(r));
    if (r.data.correct) {
      setFeedback({ ok: true, text: `Correct! +${r.data.points_awarded} points.` });
      if (r.data.finished) notify("success", "Case closed. Both parts of the deduction are resolved.");
    } else {
      setFeedback({ ok: false, text: `That's not it. ${r.data.points_awarded ? `${r.data.points_awarded} points. ` : ""}Weigh the evidence and try again.` });
    }
  }
  return { busy, feedback, submit };
}

export function FinalDeduction({ gs, act, notify }: { gs: GameState; act: Act; notify: Notify }) {
  const [pick, setPick] = useState<string | null>(null);
  const [option, setOption] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Component | null>(null);
  const culprit = useSubmitFinal(act, notify, "culprit");
  const mechanism = useSubmitFinal(act, notify, "mechanism");
  const chosen = gs.roster.find((c) => c.id === pick);
  const chosenOption = gs.final.mechanism.options.find((o) => o.id === option);

  return (
    <section className="deduction" aria-labelledby="deduction-title">
      <div className="deduction-glow" aria-hidden="true" />
      <p className="eyebrow"><Icon name="scales" size={14} /> All required threads cleared</p>
      <h2 id="deduction-title" className="deduction-title">The final deduction</h2>
      <p className="deduction-sub">Two questions: who is responsible, and how it was done. Each wrong answer costs 2 points, and you can try again. The case closes when both are right.</p>

      <div className="deduction-part">
        <h3 className="part-title">1. Who is responsible? <span className="muted">{gs.final.culprit.resolved ? `Resolved +${gs.final.culprit.points}` : `worth ${gs.final.culprit.max} points`}</span></h3>
        {gs.final.culprit.resolved ? (
          <p className="resolved-line"><Icon name="check" size={16} /> Responsibility established.</p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Choose who is responsible" className="suspect-grid">
              {gs.roster.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className={`suspect-card ${pick === c.id ? "picked" : ""}`} onClick={() => setPick(c.id)}>
                  <Avatar name={c.name} size={56} />
                  <b>{c.name}</b>
                  <span>{c.role ?? "Person of interest"}</span>
                </button>
              ))}
            </div>
            <div className="deduction-actions">
              <button type="button" className="btn danger lg" disabled={!pick || gs.paused} onClick={() => setConfirm("culprit")}>
                Accuse {chosen ? chosen.name : "…"}
              </button>
            </div>
            {culprit.feedback && <p className={`feedback ${culprit.feedback.ok ? "ok" : "bad"}`} role="status">{culprit.feedback.text}</p>}
          </>
        )}
      </div>

      <div className="deduction-part">
        <h3 className="part-title">2. How was it done? <span className="muted">{gs.final.mechanism.resolved ? `Resolved +${gs.final.mechanism.points}` : `worth ${gs.final.mechanism.max} points`}</span></h3>
        {gs.final.mechanism.resolved ? (
          <p className="resolved-line"><Icon name="check" size={16} /> Explanation established.</p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Choose the explanation" className="option-list">
              {gs.final.mechanism.options.map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={option === o.id} className={`option-card ${option === o.id ? "picked" : ""}`} onClick={() => setOption(o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className="deduction-actions">
              <button type="button" className="btn danger lg" disabled={!option || gs.paused} onClick={() => setConfirm("mechanism")}>Submit explanation</button>
            </div>
            {mechanism.feedback && <p className={`feedback ${mechanism.feedback.ok ? "ok" : "bad"}`} role="status">{mechanism.feedback.text}</p>}
          </>
        )}
      </div>

      <Modal open={confirm !== null} title={confirm === "culprit" ? "Submit accusation?" : "Submit explanation?"} tone="danger" onClose={() => setConfirm(null)}>
        {confirm === "culprit" ? (
          <p>You are accusing <b>{chosen?.name}</b>{chosen?.role ? `, ${chosen.role}` : ""}.</p>
        ) : (
          <p>{chosenOption?.label}</p>
        )}
        <p className="warn-line"><Icon name="alert" size={16} /> A wrong answer costs 2 points.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Review again</button>
          <button
            type="button"
            className="btn danger"
            disabled={confirm === "culprit" ? culprit.busy : mechanism.busy}
            onClick={async () => {
              const which = confirm;
              setConfirm(null);
              if (which === "culprit" && pick) await culprit.submit(pick);
              if (which === "mechanism" && option) await mechanism.submit(option);
            }}
          >
            Submit
          </button>
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
  const sol = gs.solution;
  const c = gs.scores.by_component;
  return (
    <section className="resolution solved" aria-labelledby="res-title">
      <p className="eyebrow">Case closed</p>
      <h1 id="res-title" className="resolution-title">Case solved</h1>
      <p className="resolution-sub">You followed the evidence to the right person and explained how it was done.</p>

      <dl className="result-stats">
        <div><dt>Final score</dt><dd><CountUp to={gs.scores.total_pts} /> <small>/ 100</small></dd></div>
        <div><dt>Time</dt><dd>{fmtClock(gs.team.elapsed_s)}</dd></div>
        <div><dt>Questions</dt><dd>{c.tasks ?? 0}</dd></div>
        <div><dt>Responsibility</dt><dd>{c.culprit ?? 0}</dd></div>
        <div><dt>Explanation</dt><dd>{c.mechanism ?? 0}</dd></div>
        <div><dt>Penalties</dt><dd>{c.penalties ?? 0}</dd></div>
      </dl>

      {sol && (
        <div className="reveal">
          <div className="reveal-grid">
            <article className="reveal-card culprit">
              <h3>Responsible</h3>
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
        <a className="btn primary lg" href={`/leaderboard?track=${gs.case.track}`}>View the leaderboard</a>
      </p>
    </section>
  );
}
