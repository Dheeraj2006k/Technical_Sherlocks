"use client";

import { useId, useRef, useState } from "react";
import type { Act, GameState, Notify, OutcomeType, Question, Thread } from "../types";
import { friendlyError } from "./api";
import { Avatar, Icon } from "./ui";
import { KIND_LABEL } from "../phases";
import { phaseLabel } from "./CaseFile";

const OUTCOME_LABEL: Record<OutcomeType, string> = {
  CLEARED: "Person cleared",
  LEAD_DISCOVERED: "New lead",
  REMAINS_PERSON_OF_INTEREST: "Remains a person of interest",
  COMPLETED: "Thread complete",
};

function AnswerInput({ q, value, onChange, roster, labelId }: { q: Question; value: string; onChange: (v: string) => void; roster: GameState["roster"]; labelId: string }) {
  const common = { "aria-labelledby": labelId, className: "answer" } as const;
  if (q.answer_type === "SINGLE_CHARACTER") {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a person…</option>
        {roster.map((c) => <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ""}</option>)}
      </select>
    );
  }
  if (q.answer_type === "CHOICE") {
    return (
      <fieldset className="choice" aria-labelledby={labelId}>
        {(q.options ?? []).map((o) => (
          <label key={o.key} className={`choice-opt${value === o.key ? " on" : ""}`}>
            <input type="radio" name={`choice-${q.id}`} value={o.key} checked={value === o.key} onChange={() => onChange(o.key)} />
            <b>{o.key}</b> <span>{o.text}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (q.answer_type === "TIME") return <input {...common} type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (q.answer_type === "NUMBER") return <input {...common} type="number" step="any" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Enter a number" />;
  return <input {...common} type="text" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} placeholder="Enter the exact text" autoComplete="off" />;
}

function QuestionCard({ q, index, gs, act, notify }: { q: Question; index: number; gs: GameState; act: Act; notify: Notify }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [hintBusy, setHintBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  // One idempotency key per answer attempt: a retry after a dropped connection reuses it, so the server counts it once.
  const keyRef = useRef<string | null>(null);
  const labelId = useId();

  const hintsUsed = q.hints.length;
  const rewardNow = q.reward_schedule[Math.min(hintsUsed, q.reward_schedule.length - 1)] ?? 0;
  const canHint = !q.completed && q.hints_total > hintsUsed;
  const nextReward = q.reward_schedule[Math.min(hintsUsed + 1, q.reward_schedule.length - 1)] ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !value) return;
    setBusy(true);
    keyRef.current ??= crypto.randomUUID();
    const r = await act("/api/submit-task", { task_id: q.id, value, idempotency_key: keyRef.current });
    setBusy(false);
    if (r.status === 0) return setFeedback({ ok: false, text: friendlyError(r) }); // keep the key: retry is safe
    keyRef.current = null;
    if (!r.ok) return setFeedback({ ok: false, text: friendlyError(r) });
    if (r.data.correct) {
      setFeedback({ ok: true, text: `Correct! +${r.data.points_awarded} points.` });
      setValue("");
      if (r.data.thread_completed) notify("success", "Thread complete. The story moves on.");
      if (r.data.phase_cleared) notify("success", "Phase cleared! New threads and evidence are open.");
    } else {
      setFeedback({ ok: false, text: `Not quite. ${r.data.points_awarded ? `${r.data.points_awarded} points. ` : ""}Re-check the evidence and try again.` });
    }
  }

  async function reveal() {
    if (hintBusy) return;
    setHintBusy(true);
    const r = await act("/api/hint", { task_id: q.id, position: hintsUsed + 1 });
    setHintBusy(false);
    if (!r.ok) notify("error", friendlyError(r));
  }

  return (
    <article className={`task ${q.completed ? "solved" : ""}`} aria-labelledby={`${labelId}-t`}>
      <header className="task-head">
        <span className="task-no">Q{index + 1}</span>
        <span className="pill muted">{q.completed ? `${q.points_awarded} pts` : `worth ${rewardNow} pts`}</span>
        {q.completed && <span className="verified"><Icon name="check" size={14} /> VERIFIED</span>}
      </header>
      <h4 id={`${labelId}-t`} className="task-title">{q.title ?? "Question"}</h4>
      {q.kind && <p className="task-kind">{KIND_LABEL[q.kind]} evidence</p>}
      <p className="task-q" id={labelId}>{q.prompt_text}</p>

      {q.completed && q.answer && <p className="verified-value"><Icon name="check" size={15} /> Verified answer: <b>{q.answer}</b></p>}

      {q.hints.length > 0 && (
        <ol className="hints" aria-label="Hints opened by your team">
          {q.hints.map((h) => <li key={h.position}><b>Hint {h.position}</b> {h.text}</li>)}
        </ol>
      )}

      {!q.completed && (
        <>
          <form onSubmit={submit} className="answer-row">
            <AnswerInput q={q} value={value} onChange={setValue} roster={gs.roster} labelId={labelId} />
            <button type="submit" className="btn primary" disabled={!value || busy || gs.paused}>{busy ? "Checking…" : "Submit answer"}</button>
          </form>
          <div className="hint-row">
            {canHint ? (
              <button type="button" className="btn ghost sm" onClick={reveal} disabled={hintBusy || gs.paused} aria-label={`Reveal hint ${hintsUsed + 1} of ${q.hints_total}. The reward drops to ${nextReward} points for your whole team.`}>
                <Icon name="bolt" size={14} /> {hintBusy ? "Opening…" : `Reveal hint ${hintsUsed + 1}/${q.hints_total} (reward drops to ${nextReward})`}
              </button>
            ) : (
              <span className="muted">No more hints for this question.</span>
            )}
            <span className="muted">A wrong answer costs 2 points.{q.wrong_attempts > 0 ? ` ${q.wrong_attempts} wrong so far.` : ""}</span>
          </div>
        </>
      )}
      {feedback && <p className={`feedback ${feedback.ok ? "ok" : "bad"}`} role="status">{feedback.text}</p>}
    </article>
  );
}

function ThreadCard({ t, gs, act, notify }: { t: Thread; gs: GameState; act: Act; notify: Notify }) {
  const isHead = gs.me.role === "head";
  const assignee = gs.players.find((p) => p.id === t.assigned_to);
  const subject = gs.roster.find((c) => c.id === t.subject_character_id);
  const done = t.questions.filter((q) => q.completed).length;
  const [open, setOpen] = useState(!t.done);

  return (
    <section className={`thread ${t.done ? "done" : ""}`} aria-label={`Thread: ${t.title}`}>
      <header className="thread-head">
        <button type="button" className="thread-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="thread-title">{t.title}</span>
          <span className="muted">{done}/{t.questions.length}</span>
        </button>
        <span className={`pill ${t.required ? "cyan" : "muted"}`}>{t.required ? "Required" : "Optional"}</span>
        {t.done && t.outcome_type && <span className={`pill ${t.outcome_type === "CLEARED" ? "green" : t.outcome_type === "REMAINS_PERSON_OF_INTEREST" ? "amber" : "cyan"}`}>{OUTCOME_LABEL[t.outcome_type]}</span>}
      </header>

      {open && (
        <>
          {subject && <p className="thread-subject"><Avatar name={subject.name} size={22} /> Subject: <b>{subject.name}</b></p>}
          {t.intro_text && <p className="thread-intro">{t.intro_text}</p>}
          {t.done && t.outcome_text && <p className="thread-outcome" role="status"><Icon name="pin" size={14} /> {t.outcome_text}</p>}

          {!t.done && (
            <div className="assign">
              {assignee ? <span className="assignee"><Avatar name={assignee.display_name} size={22} /> Assigned to <b>{assignee.display_name}</b></span> : <span className="muted">Unassigned (anyone can take it)</span>}
              {isHead ? (
                <select
                  aria-label={`Assign thread ${t.title}`}
                  className="assign-select"
                  value={t.assigned_to ?? ""}
                  onChange={async (e) => {
                    if (!e.target.value) return;
                    const r = await act("/api/assign-thread", { thread_id: t.id, player_id: e.target.value });
                    if (!r.ok) notify("error", friendlyError(r));
                  }}
                >
                  <option value="">Assign to…</option>
                  {gs.players.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </select>
              ) : (
                !t.assigned_to && (
                  <button type="button" className="btn ghost sm" onClick={async () => { const r = await act("/api/assign-thread", { thread_id: t.id }); if (!r.ok) notify("error", friendlyError(r)); }}>
                    Take this thread
                  </button>
                )
              )}
            </div>
          )}

          {t.questions.map((q, i) => <QuestionCard key={q.id} q={q} index={i} gs={gs} act={act} notify={notify} />)}
        </>
      )}
    </section>
  );
}

export default function Threads({ gs, act, notify }: { gs: GameState; act: Act; notify: Notify }) {
  const all = gs.threads.flatMap((t) => t.questions);
  const answered = all.filter((q) => q.completed).length;
  const phases = [...new Set(gs.threads.map((t) => t.phase))].sort();

  return (
    <section className="tasks" aria-label="Investigation threads" data-tour="threads">
      <header className="side-head">
        <h2>Investigation threads</h2>
        {all.length > 0 && <span className="progress-count" aria-label={`${answered} of ${all.length} questions answered`}>{answered}/{all.length} answered</span>}
      </header>
      {all.length > 0 && (
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={answered} aria-label="Question progress">
          <i style={{ width: `${(answered / all.length) * 100}%` }} />
        </div>
      )}
      {gs.state === "FINAL_DEDUCTION" && <p className="hint">All required threads are done. Optional threads stay open; they can only add points.</p>}
      {phases.map((p) => (
        <div key={p} className="phase-group">
          <h3 className="phase-group-title">Phase {p}: {phaseLabel(gs, p)}</h3>
          {gs.threads.filter((t) => t.phase === p).map((t) => <ThreadCard key={t.id} t={t} gs={gs} act={act} notify={notify} />)}
        </div>
      ))}
    </section>
  );
}
