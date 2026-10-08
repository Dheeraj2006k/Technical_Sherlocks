"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtClock } from "../phases";
import { Icon, StatusPill } from "../components/ui";

type Row = {
  ref: string;
  rank: number;
  team_name: string;
  case_title: string;
  state: string;
  total_pts: number;
  phases_cleared: number;
  finished: boolean;
  elapsed_s: number;
};

const MEDAL = ["gold", "silver", "bronze"];

export default function LeaderboardView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ok, setOk] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const tops = useRef(new Map<string, number>());
  const els = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/api/leaderboard", { cache: "no-store" });
        if (!r.ok) throw new Error("bad status");
        const d = await r.json();
        if (live) {
          setRows(d.teams);
          setOk(true);
          setUpdated(new Date());
        }
      } catch {
        if (live) setOk(false);
      }
    };
    const first = setTimeout(load, 0);
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  // FLIP: when ranks change, rows glide from their old position to the new one.
  useLayoutEffect(() => {
    if (!rows) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const r of rows) {
      const el = els.current.get(r.ref);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      next.set(r.ref, top);
      const was = tops.current.get(r.ref);
      if (!reduce && was !== undefined && Math.abs(was - top) > 2 && el.animate) {
        el.animate([{ transform: `translateY(${was - top}px)`, background: "rgba(227,171,63,.18)" }, { transform: "none", background: "transparent" }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }
    tops.current = next;
  }, [rows]);

  return (
    <main id="main" className="board-page grid-bg">
      <header className="board-title">
        <p className="eyebrow"><Icon name="trophy" size={14} /> Live standings</p>
        <h1>The Investigation Board</h1>
        <p className="muted">Highest score wins. Ties go to the earliest correct accusation.</p>
        <p className="board-status" role="status">
          <span className={`conn ${ok ? "live" : "reconnecting"}`}><i aria-hidden="true" /> {ok ? "Live" : "Connection interrupted — retrying…"}</span>
          {updated && ok && <span className="muted"> Updated {updated.toLocaleTimeString()}</span>}
        </p>
      </header>

      {rows === null ? (
        <p className="empty">Connecting to the investigation server…</p>
      ) : rows.length === 0 ? (
        <p className="empty">No investigation teams have formed yet. The board fills up as teams open their cases.</p>
      ) : (
        <div className="table-wrap">
          <table className="lb">
            <caption className="sr-only">Team standings, best first</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col" className="num">Score</th>
                <th scope="col" className="num">Time</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.ref}
                  ref={(el) => {
                    if (el) els.current.set(r.ref, el);
                    else els.current.delete(r.ref);
                  }}
                  className={r.rank <= 3 && r.total_pts > 0 ? `medal ${MEDAL[r.rank - 1]}` : ""}
                >
                  <td className="rank"><span>{r.rank}</span></td>
                  <td>
                    <b className="team-name">{r.team_name}</b>
                    <span className="case-name">{r.case_title}</span>
                  </td>
                  <td className="num">
                    <b className="score-big">{r.total_pts}</b>
                    <span className="pips" aria-label={`${r.phases_cleared} of 3 phases cleared`}>
                      {[0, 1, 2].map((i) => <i key={i} className={i < r.phases_cleared ? "on" : ""} />)}
                    </span>
                  </td>
                  <td className="num mono">{fmtClock(r.elapsed_s)}</td>
                  <td>
                    {r.finished ? <StatusPill tone="green">Finished</StatusPill> : r.state === "WAITING" ? <StatusPill tone="muted">Waiting</StatusPill> : <StatusPill tone="cyan">Investigating</StatusPill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="board-foot"><Link href="/">Back to the investigation</Link></p>
    </main>
  );
}
