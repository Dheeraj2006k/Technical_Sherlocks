import type { GameState, Question } from "../types";
import { KIND_LABEL, PHASES } from "../phases";
import { Avatar, Icon } from "./ui";

// What the team has ALREADY verified (answered questions) and the story that unfolded from it. Every card comes from a
// question this team answered correctly, so the board never shows anything the investigation has not earned.
export default function EvidenceBoard({ gs }: { gs: GameState }) {
  const reached = gs.state === "WAITING" ? 0 : gs.state === "PHASE_1" ? 1 : gs.state === "PHASE_2" ? 2 : 3;
  const done = gs.threads.flatMap((t) => t.questions.filter((q) => q.completed).map((q) => ({ q, phase: t.phase })));
  const flagged = new Set(done.filter((d) => d.q.answer_type === "SINGLE_CHARACTER" && d.q.answer).map((d) => d.q.answer as string));
  const noteText = (q: Question) => `${q.title ?? "Finding"}: ${q.answer}`;

  return (
    <section className="board" aria-label="Evidence board">
      <header className="board-head">
        <h2 className="console-title">Evidence board</h2>
        <span className="muted">{done.length} finding{done.length === 1 ? "" : "s"} verified</span>
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

      {gs.story.length > 0 && (
        <div className="story" aria-label="How the story has unfolded">
          <h3 className="lane-title">The story so far</h3>
          <ol>
            {gs.story.map((s) => (
              <li key={s.title}><b>{s.title}</b><p>{s.body}</p></li>
            ))}
          </ol>
        </div>
      )}

      {done.length === 0 && <p className="board-empty"><Icon name="pin" size={20} /> Nothing verified yet. Answer a question and it is pinned here.</p>}

      <div className="lanes">
        {PHASES.map((p) => {
          const items = done.filter((d) => d.phase === p.n);
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
                <ol className="thread-notes">
                  {items.map(({ q }, i) => (
                    <li key={q.id} className={`note kind-${(q.kind ?? "OBJECT").toLowerCase()} ${i % 2 ? "alt" : ""}`}>
                      <i className="pin" aria-hidden="true" />
                      <span className="note-kind">{KIND_LABEL[q.kind ?? "OBJECT"]}</span>
                      <p>{noteText(q)}</p>
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
