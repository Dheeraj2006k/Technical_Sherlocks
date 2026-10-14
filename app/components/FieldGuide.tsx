"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GUIDE_INTRO, searchTopics, TOPICS, type Cell, type Example, type Topic } from "../fieldguide/content";
import { Icon } from "./ui";

// SQL Field Guide (PRD 17.1): a static reference drawer. It makes no network request, calls no model and writes nothing:
// it cannot change a score, a hint count, an unlock or the query text sitting in the console, because it never touches them.

const show = (v: Cell) => (v === null ? <i className="null">NULL</i> : String(v));

function ResultTable({ example }: { example: Example }) {
  if (!example.columns) return null;
  const rows = example.rows ?? [];
  return (
    <div className="fg-result" role="group" aria-label="Expected result">
      <p className="fg-result-head">Result · {rows.length} {rows.length === 1 ? "row" : "rows"}</p>
      {rows.length === 0 ? (
        <p className="fg-empty">No rows returned.</p>
      ) : (
        <div className="grid-wrap" tabIndex={0} aria-label="Example result table">
          <table className="grid">
            <thead><tr>{example.columns.map((c) => <th scope="col" key={c}>{c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{show(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExampleBlock({ title, example, note }: { title: string; example: Example; note?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(example.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked: the query is plain text on screen anyway */
    }
  }
  return (
    <figure className="fg-example">
      <figcaption>{title}</figcaption>
      <div className="fg-code">
        <pre><code>{example.sql}</code></pre>
        <button type="button" className="btn ghost sm" onClick={copy} aria-label={`Copy query: ${title}`}><Icon name="copy" size={14} /> {copied ? "Copied" : "Copy"}</button>
      </div>
      {example.refused && <p className="fg-refused" role="note">The console refuses this one. It is shown so you know what is not supported.</p>}
      {example.errorCode && <p className="fg-error" role="note">This query fails with an error (SQLSTATE {example.errorCode}). Errors are free.</p>}
      <ResultTable example={example} />
      {note && <p className="fg-note">{note}</p>}
    </figure>
  );
}

function TopicView({ t }: { t: Topic }) {
  return (
    <article className="fg-topic" aria-labelledby={`fg-t-${t.id}`}>
      <h3 id={`fg-t-${t.id}`}>{t.title}</h3>
      {t.blocks.map((b, i) => {
        if (b.type === "p") return <p key={i}>{b.text}</p>;
        if (b.type === "tip") return <p key={i} className="fg-tip"><b>Tip.</b> {b.text}</p>;
        if (b.type === "list") return <ul key={i} className="fg-list">{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>;
        return <ExampleBlock key={i} title={b.title} example={b.example} note={b.note} />;
      })}
    </article>
  );
}

export default function FieldGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [topicId, setTopicId] = useState(TOPICS[0].id);
  const searchRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchTopics(query), [query]);
  const current = TOPICS.find((t) => t.id === topicId) ?? TOPICS[0];
  const idx = TOPICS.findIndex((t) => t.id === current.id);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // The drawer stays mounted while closed (hidden) so the player's place in the guide survives closing and reopening.
  return (
    <aside className={`fg-drawer${open ? " open" : ""}`} aria-label="SQL Field Guide" hidden={!open} data-testid="field-guide">
      <header className="fg-head">
        <h2><Icon name="book" size={18} /> SQL Field Guide</h2>
        <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close the SQL Field Guide">Close</button>
      </header>
      <p className="fg-intro">{GUIDE_INTRO}</p>
      <label className="field fg-search">
        <span className="sr-only">Search the guide</span>
        <input ref={searchRef} type="search" placeholder="Search the guide (join, null, error…)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the guide" />
      </label>
      <div className="fg-body">
        <nav className="fg-nav" aria-label="Guide topics">
          {matches.length === 0 ? (
            <p className="fg-empty">No topic matches. Try a shorter word such as join or null.</p>
          ) : (
            <ul>
              {matches.map((t) => (
                <li key={t.id}>
                  <button type="button" className={t.id === current.id ? "on" : ""} aria-current={t.id === current.id ? "page" : undefined} onClick={() => setTopicId(t.id)}>
                    <b>{t.title}</b>
                    <span>{t.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="fg-content" tabIndex={-1}>
          <TopicView t={current} />
          <div className="fg-pager">
            <button type="button" className="btn ghost sm" disabled={idx <= 0} onClick={() => setTopicId(TOPICS[idx - 1].id)}>Previous topic</button>
            <button type="button" className="btn ghost sm" disabled={idx >= TOPICS.length - 1} onClick={() => setTopicId(TOPICS[idx + 1].id)}>Next topic</button>
          </div>
        </div>
      </div>
    </aside>
  );
}
