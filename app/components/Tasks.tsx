"use client";

import { useId, useState } from "react";
import type { Act, GameState, Notify, Task } from "../types";
import { friendlyError } from "./api";
import { Avatar, Icon } from "./ui";
import { KIND_LABEL, phaseTitle } from "../phases";

function AnswerInput({ task, value, onChange, roster, labelId }: { task: Task; value: string; onChange: (v: string) => void; roster: GameState["roster"]; labelId: string }) {
  const common = { "aria-labelledby": labelId, className: "answer" } as const;
  if (task.answer_type === "SINGLE_CHARACTER") {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a person…</option>
        {roster.map((c) => <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ""}</option>)}
      </select>
    );
  }
  if (task.answer_type === "TIME") return <input {...common} type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (task.answer_type === "NUMBER") return <input {...common} type="number" step="any" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Enter a number" />;
  return <input {...common} type="text" value={value} maxLength={200} onChange={(e) => onChange(e.target.value)} placeholder="Enter the exact text" autoComplete="off" />;
}

const DIFF_TONE: Record<string, string> = { easy: "green", medium: "amber", hard: "red" };

function TaskCard({ task, index, gs, act, notify, verified }: { task: Task; index: number; gs: GameState; act: Act; notify: Notify; verified: string | null }) {
  const isHead = gs.me.role === "head";
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Persistent inline feedback: lives outside the "unsolved" block so it can never vanish when the task flips to solved.
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const labelId = useId();
  const assignee = gs.players.find((p) => p.id === task.assigned_to);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !value) return;
    setBusy(true);
    const r = await act("/api/submit-task", { task_id: task.id, value });
    setBusy(false);
    if (!r.ok) return setFeedback({ ok: false, text: friendlyError(r) });
    if (r.data.correct) {
      setFeedback({ ok: true, text: "Correct! Evidence verified." });
      setValue("");
      if (r.data.phase_cleared) notify("success", "Phase cleared! +20 points. New clues and tables are unlocked.");
    } else {
      setFeedback({ ok: false, text: "Not quite. Re-check the evidence and try again." });
    }
  }

  return (
    <article className={`task ${task.solved ? "solved" : ""}`} aria-labelledby={`${labelId}-t`}>
      <header className="task-head">
        <span className="task-no">TASK {String(index + 1).padStart(2, "0")}</span>
        {task.difficulty && <span className={`pill ${DIFF_TONE[task.difficulty] ?? "muted"}`}>{task.difficulty}</span>}
        {task.solved && <span className="verified"><Icon name="check" size={14} /> VERIFIED</span>}
      </header>
      <h3 id={`${labelId}-t`} className="task-title">{task.title ?? "Case objective"}</h3>
      {task.kind && <p className="task-kind">{KIND_LABEL[task.kind]} evidence</p>}
      <p className="task-q" id={labelId}>{task.prompt_text}</p>

      <div className="assign">
        {assignee ? (
          <span className="assignee"><Avatar name={assignee.display_name} size={22} /> Assigned to <b>{assignee.display_name}</b></span>
        ) : (
          <span className="muted">Unassigned</span>
        )}
        {!task.solved &&
          (isHead ? (
            <select
              aria-label={`Assign task ${index + 1} to an investigator`}
              className="assign-select"
              value={task.assigned_to ?? ""}
              onChange={async (e) => {
                if (!e.target.value) return;
                const r = await act("/api/assign-task", { task_id: task.id, player_id: e.target.value });
                if (!r.ok) notify("error", friendlyError(r));
              }}
            >
              <option value="">Assign to…</option>
              {gs.players.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          ) : (
            !task.assigned_to && (
              <button type="button" className="btn ghost sm" onClick={async () => { const r = await act("/api/assign-task", { task_id: task.id }); if (!r.ok) notify("error", friendlyError(r)); }}>
                Take this task
              </button>
            )
          ))}
      </div>

      {task.solved && verified && (
        <p className="verified-value"><Icon name="check" size={15} /> Verified answer: <b>{verified}</b></p>
      )}

      {!task.solved && (
        <form onSubmit={submit} className="answer-row">
          <AnswerInput task={task} value={value} onChange={setValue} roster={gs.roster} labelId={labelId} />
          <button type="submit" className="btn primary" disabled={!value || busy || gs.paused}>{busy ? "Checking…" : "Submit answer"}</button>
        </form>
      )}
      {feedback && <p className={`feedback ${feedback.ok ? "ok" : "bad"}`} role="status">{feedback.text}</p>}
    </article>
  );
}

export default function Tasks({ gs, act, notify }: { gs: GameState; act: Act; notify: Notify }) {
  const verifiedBy = (id: string) => gs.evidence.find((e) => e.task_id === id)?.value ?? null;
  const solved = gs.tasks.filter((t) => t.solved).length;
  const earlier = gs.evidence.filter((e) => e.phase < gs.current_phase || gs.state === "FINAL_DEDUCTION" || gs.state === "FINISHED");
  const earlierPhases = [...new Set(earlier.map((e) => e.phase))].filter((p) => gs.state === "FINAL_DEDUCTION" || gs.state === "FINISHED" || p < gs.current_phase);

  return (
    <section className="tasks" aria-label="Case objectives">
      <header className="side-head">
        <h2>Case objectives</h2>
        {gs.tasks.length > 0 && <span className="progress-count" aria-label={`${solved} of ${gs.tasks.length} verified`}>{solved}/{gs.tasks.length} verified</span>}
      </header>
      {gs.tasks.length > 0 && (
        <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={gs.tasks.length} aria-valuenow={solved} aria-label="Phase progress">
          <i style={{ width: `${(solved / gs.tasks.length) * 100}%` }} />
        </div>
      )}
      {gs.tasks.map((t, i) => <TaskCard key={t.id} task={t} index={i} gs={gs} act={act} notify={notify} verified={verifiedBy(t.id)} />)}

      {earlierPhases.map((p) => (
        <details key={p} className="earlier" open>
          <summary><Icon name="check" size={14} /> Phase {p}: {phaseTitle(p)} — verified</summary>
          <ul>
            {gs.evidence.filter((e) => e.phase === p).map((e) => (
              <li key={e.task_id}><b>{e.title ?? "Objective"}</b><span>{e.value}</span></li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
