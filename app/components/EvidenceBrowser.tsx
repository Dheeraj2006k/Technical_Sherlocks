"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { friendlyError, post } from "./api";
import { Icon, Spinner } from "./ui";

type Col = { name: string; type: string };
type TableMeta = { name: string; columns: Col[] };
type Filter = { column: string; op: string; value: string };
type Page = { columns: string[]; rows: unknown[][]; total: number; page: number; pages: number };

const OPS: [string, string][] = [
  ["eq", "is"],
  ["neq", "is not"],
  ["contains", "contains"],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
];

const cell = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));

// Evidence Browser (PRD 10): browse, search, filter, sort and page through the unlocked evidence without writing SQL.
// All filtering happens on the server against an allow-list of the real columns; nothing here is ever sent as SQL.
export default function EvidenceBrowser({ unlocked, paused }: { unlocked: string[]; paused: boolean }) {
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [table, setTable] = useState<string>("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]); // being edited
  const [active, setActive] = useState<Filter[]>([]); // applied (sent to the server)
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const unlockedKey = unlocked.join(",");

  // catalogue of unlocked tables (refreshes whenever the unlocked set changes)
  useEffect(() => {
    let live = true;
    (async () => {
      const r = await post("/api/evidence", {});
      if (!live || !r.ok) return;
      const list = (r.data.tables as TableMeta[]) ?? [];
      setTables(list);
      setTable((cur) => (list.some((t) => t.name === cur) ? cur : (list[0]?.name ?? "")));
    })();
    return () => {
      live = false;
    };
  }, [unlockedKey]);

  const meta = useMemo(() => tables.find((t) => t.name === table), [tables, table]);

  const load = useCallback(async () => {
    if (!table) return;
    setLoading(true);
    const r = await post("/api/evidence", { table, search: applied, filters: active, sort, page, page_size: 25 });
    setLoading(false);
    if (!r.ok) {
      setError(friendlyError(r));
      return;
    }
    setError("");
    setData(r.data as unknown as Page);
  }, [table, applied, active, sort, page]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  function changeTable(name: string) {
    setTable(name);
    setFilters([]);
    setActive([]);
    setSort(null);
    setSearch("");
    setApplied("");
    setPage(1);
    setData(null);
  }

  function toggleSort(column: string) {
    setPage(1);
    setSort((s) => (s?.column === column ? (s.dir === "asc" ? { column, dir: "desc" } : null) : { column, dir: "asc" }));
  }

  if (tables.length === 0) {
    return (
      <section className="console" aria-label="Evidence Browser">
        <h2 className="console-title">Evidence Browser</h2>
        <p className="muted">No evidence is open yet.</p>
      </section>
    );
  }

  return (
    <section className="console browser" aria-label="Evidence Browser">
      <header className="console-head">
        <h2 className="console-title">Evidence Browser</h2>
        <span className="muted">Search, filter and sort the records. No SQL needed.</span>
      </header>

      <div className="browser-bar">
        <label className="field inline">
          <span>Evidence</span>
          <select value={table} onChange={(e) => changeTable(e.target.value)} aria-label="Evidence table">
            {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        <form
          className="browser-search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setApplied(search);
          }}
        >
          <input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} placeholder="Search every column…" aria-label="Search the evidence" />
          <button type="submit" className="btn ghost sm"><Icon name="magnifier" size={14} /> Search</button>
        </form>
      </div>

      <div className="filters" aria-label="Filters">
        {filters.map((f, i) => (
          <div key={i} className="filter-row">
            <select aria-label="Filter column" value={f.column} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
              {meta?.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <select aria-label="Filter operator" value={f.op} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
              {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input aria-label="Filter value" value={f.value} maxLength={100} onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" />
            <button type="button" className="btn ghost sm" aria-label="Remove filter" onClick={() => { const next = filters.filter((_, j) => j !== i); setPage(1); setFilters(next); setActive(next.filter((x) => x.column && x.value !== "")); }}>×</button>
          </div>
        ))}
        <div className="filter-actions">
          <button
            type="button"
            className="btn ghost sm"
            disabled={filters.length >= 6 || !meta}
            onClick={() => meta && setFilters([...filters, { column: meta.columns[0]?.name ?? "", op: "eq", value: "" }])}
          >
            + Add filter
          </button>
          {filters.length > 0 && <button type="button" className="btn primary sm" onClick={() => { setPage(1); setActive(filters.filter((x) => x.column && x.value !== "")); }}>Apply filters</button>}
        </div>
      </div>

      {error && <p className="form-error" role="alert"><Icon name="alert" size={16} /> {error}</p>}
      {paused && <p className="muted">The game is paused. You can still read the evidence.</p>}

      <div className="results" role="region" aria-label="Evidence records" tabIndex={0}>
        {loading && !data && <Spinner label="Loading evidence…" />}
        {data && (
          <table>
            <thead>
              <tr>
                {data.columns.map((c) => (
                  <th key={c} scope="col" aria-sort={sort?.column === c ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className="th-btn" onClick={() => toggleSort(c)}>
                      {c} {sort?.column === c ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{cell(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.rows.length === 0 && <p className="empty">No records match.</p>}
      </div>

      {data && (
        <footer className="result-foot">
          <span>{data.total} record{data.total === 1 ? "" : "s"}</span>
          <span className="pager">
            <button type="button" className="btn ghost sm" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {data.page} of {data.pages}</span>
            <button type="button" className="btn ghost sm" disabled={page >= data.pages || loading} onClick={() => setPage(page + 1)}>Next</button>
          </span>
        </footer>
      )}
    </section>
  );
}
