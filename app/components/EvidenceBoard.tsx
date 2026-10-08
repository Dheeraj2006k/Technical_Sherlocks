import type { Evidence, GameState } from "../types";
import { KIND_LABEL, PHASES } from "../phases";
import { Avatar, Icon } from "./ui";

const fill = (e: Evidence) => (e.label ?? "{value}").replace("{value}", e.value);

// A visualization of what the team has ALREADY verified (solved tasks only). It never shows anything the
// database has not unlocked: every card here comes from a task this team answered correctly.
export default function EvidenceBoard({ gs }: { gs: GameState }) {
  const reached = gs.state === "WAITING" ? 0 : gs.state === "PHASE_1" ? 1 : gs.state === "PHASE_2" ? 2 : 3;
  const flagged = new Set(gs.evidence.filter((e) => e.kind === "PERSON" || e.kind === "MOTIVE").filter((e) => e.answer_type === "SINGLE_CHARACTER").map((e) => e.value));

  return (
    <section className="board" aria-label="Evidence board">
      <header className="board-head">
        <h2 className="console-title">Evidence board</h2>
        <span className="muted">{gs.evidence.length} item{gs.evidence.length === 1 ? "" : "s"} verified</span>
      </header>

      <div className="suspects" aria-label="Persons of interest">
        {gs.roster.map((c) => (
          <span key={c.id} className={`suspect ${flagged.has(c.name) ? "flag" : ""}`} title={c.role ?? undefined}>
            <Avatar name={c.name} size={28} />
            <span>{c.name}</span>
            {flagged.has(c.name) && <em>flagged</em>}
          </span>
        ))}
      </div>

      {gs.evidence.length === 0 && (
        <p className="board-empty"><Icon name="pin" size={20} /> No evidence verified yet. Solve a task and it is pinned here.</p>
      )}

      <div className="lanes">
        {PHASES.map((p) => {
          const items = gs.evidence.filter((e) => e.phase === p.n);
          const locked = p.n > reached;
          return (
            <div key={p.n} className={`lane ${locked ? "locked" : ""}`}>
              <h3 className="lane-title">
                <span>Phase {p.n}</span> {p.title}
                {locked && <Icon name="lock" size={14} />}
              </h3>
              {locked ? (
                <p className="lane-locked">Locked. Clear the previous phase to unlock this evidence.</p>
              ) : items.length === 0 ? (
                <p className="lane-locked">Nothing verified in this phase yet.</p>
              ) : (
                <ol className="thread">
                  {items.map((e, i) => (
                    <li key={e.task_id} className={`note kind-${(e.kind ?? "OBJECT").toLowerCase()} ${i % 2 ? "alt" : ""}`}>
                      <i className="pin" aria-hidden="true" />
                      <span className="note-kind">{KIND_LABEL[e.kind ?? "OBJECT"]} · {e.title ?? "Evidence"}</span>
                      <p>{fill(e)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
