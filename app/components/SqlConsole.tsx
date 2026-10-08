"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui";

// ---------- lightweight SQL highlighter (no dependency): tokens rendered as React nodes, never raw HTML
const KEYWORDS = new Set(
  ("select from where and or not in is null like ilike between join inner left right full outer cross on as group by order having limit offset distinct " +
    "union all intersect except with case when then else end asc desc exists any some true false using interval cast over partition")
    .split(" "),
);
const FUNCTIONS = new Set("count sum avg min max to_char date_trunc extract coalesce lower upper length substring trim round now row_number rank string_agg array_agg".split(" "));
const TOKEN_RE = /(--[^\n]*)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;

function highlight(src: string) {
  const out: React.ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    const [t, com, str, num, id] = m;
    let cls = "";
    if (com) cls = "tok-com";
    else if (str) cls = "tok-str";
    else if (num) cls = "tok-num";
    else if (id) {
      const low = id.toLowerCase();
      if (KEYWORDS.has(low)) cls = "tok-kw";
      else if (FUNCTIONS.has(low) && src[TOKEN_RE.lastIndex] === "(") cls = "tok-fn";
    }
    out.push(cls ? <span key={i++} className={cls}>{t}</span> : t);
  }
  return out;
}

function SqlEditor({ value, onChange, onRun, disabled }: { value: string; onChange: (v: string) => void; onRun: () => void; disabled: boolean }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => Math.max(1, value.split("\n").length), [value]);
  const nodes = useMemo(() => highlight(value), [value]);

  function sync() {
    if (!ta.current) return;
    if (pre.current) {
      pre.current.scrollTop = ta.current.scrollTop;
      pre.current.scrollLeft = ta.current.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = ta.current.scrollTop;
  }

  return (
    <div className="editor">
      <div className="gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <span key={i}>{i + 1}</span>)}
      </div>
      <div className="editor-stack">
        <pre className="editor-hl" ref={pre} aria-hidden="true">{nodes}{"\n"}</pre>
        <textarea
          ref={ta}
          className="editor-input"
          aria-label="SQL query"
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              onRun();
            }
          }}
        />
      </div>
    </div>
  );
}

type Result = {
  ok?: boolean;
  error?: string;
  error_type?: string;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  row_count?: number;
  row_cap?: number;
  elapsed_ms?: number;
  notice?: string;
};
type SchemaTable = { name: string; columns: { name: string; type: string }[] };

const cell = (v: unknown) => (v === null ? <i className="null">NULL</i> : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function SqlConsole({ tables, paused }: { tables: string[]; paused: boolean }) {
  const [sql, setSql] = useState(() => `SELECT *\nFROM ${tables[0] ?? "cast_crew"}\nLIMIT 10;`);
  const [res, setRes] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [showSchema, setShowSchema] = useState(true);
  const runningRef = useRef(false);
  const tablesKey = tables.join(",");

  // Column names of unlocked tables (re-read whenever a new phase unlocks more tables).
  useEffect(() => {
    let live = true;
    fetch("/api/schema", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { tables: [] }))
      .then((d) => live && setSchema(d.tables ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tablesKey]);

  async function run() {
    if (runningRef.current || paused || !sql.trim()) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const r = await fetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql }) });
      const data = (await r.json().catch(() => ({}))) as Result;
      if (r.status === 429) setRes({ ok: false, error_type: "rate", error: `You are running queries too fast. Try again in ${r.headers.get("retry-after") ?? "a few"} seconds.` });
      else if (r.status === 423) setRes({ ok: false, error_type: "paused", error: "The investigation is paused by the organizers." });
      else if (r.status === 400 || r.status === 409 || r.status === 503) setRes({ ok: false, error_type: "precheck", error: data.error ?? "That query cannot be run." });
      else if (r.status === 401) setRes({ ok: false, error_type: "session", error: "Your session has ended. Rejoin the investigation." });
      else setRes(data);
    } catch {
      setRes({ ok: false, error_type: "network", error: "Connection interrupted. Check your network and run the query again." });
    }
    runningRef.current = false;
    setRunning(false);
  }

  const failed = res && res.ok === false;
  const cols = res?.columns ?? [];

  return (
    <section className="console" aria-label="SQL console">
      <header className="console-head">
        <h2 className="console-title"><span className="led" aria-hidden="true" /> SQL console</h2>
        <button type="button" className="btn ghost sm" onClick={() => setShowSchema((v) => !v)} aria-expanded={showSchema}>
          {showSchema ? "Hide" : "Show"} evidence tables
        </button>
      </header>

      {showSchema && (
        <div className="schema" aria-label="Unlocked evidence tables">
          {schema.length === 0 ? (
            <span className="muted">Loading evidence tables…</span>
          ) : (
            schema.map((t) => (
              <button
                key={t.name}
                type="button"
                className="schema-table"
                title={`Insert SELECT * FROM ${t.name}`}
                onClick={() => setSql(`SELECT *\nFROM ${t.name}\nLIMIT 10;`)}
              >
                <b>{t.name}</b>
                <span>{t.columns.map((c) => c.name).join(", ")}</span>
              </button>
            ))
          )}
        </div>
      )}

      <SqlEditor value={sql} onChange={setSql} onRun={run} disabled={paused} />

      <div className="console-actions">
        <button type="button" className="btn primary" onClick={run} disabled={running || paused || !sql.trim()}>
          <Icon name="bolt" size={16} /> {running ? "Analyzing evidence…" : "Run query"}
        </button>
        <button type="button" className="btn ghost" onClick={() => { setSql(""); setRes(null); }} disabled={running}>Clear</button>
        <span className="kbd-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run</span>
      </div>

      <div className="output" aria-live="polite">
        {running && (
          <div className="out-state running"><span className="scan" aria-hidden="true" /> Analyzing evidence…</div>
        )}
        {!running && !res && (
          <div className="out-state idle">
            <Icon name="magnifier" size={20} />
            <p>Write a query to examine the evidence. Results appear here.</p>
          </div>
        )}
        {!running && failed && (
          <div className="out-state failed" role="alert">
            <p className="out-title">QUERY FAILED</p>
            <p>{res?.error_type === "sql" ? `Check your SQL: ${res.error}` : res?.error}</p>
          </div>
        )}
        {!running && res && !failed && (
          <>
            <p className="out-title ok">
              QUERY COMPLETE <span>{res.elapsed_ms ?? 0} ms · {res.row_count ?? 0} {res.row_count === 1 ? "row" : "rows"}</span>
            </p>
            {res.notice && <p className="out-notice"><Icon name="lock" size={14} /> {res.notice}</p>}
            {(res.row_count ?? 0) === 0 ? (
              <div className="out-state idle"><p>No rows returned.</p></div>
            ) : (
              <div className="grid-wrap" tabIndex={0} aria-label="Query results">
                <table className="grid">
                  <thead>
                    <tr>
                      <th scope="col" className="rownum">#</th>
                      {cols.map((c, i) => <th scope="col" key={i}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows?.map((r, i) => (
                      <tr key={i}>
                        <td className="rownum">{i + 1}</td>
                        {r.map((v, j) => <td key={j}>{cell(v)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {res.truncated && (
              <p className="out-warn"><Icon name="alert" size={14} /> Showing the first {res.row_cap ?? 200} rows only. Narrow the query to see the rest.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
