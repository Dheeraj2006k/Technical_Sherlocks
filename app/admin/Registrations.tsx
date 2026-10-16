"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "../components/ui";

type Reg = {
  id: string;
  registration_ref: string;
  team_ref: string;
  team_size: number;
  registration_status: string;
  assignment_status: string | null;
  case_code: string | null;
  case_title: string | null;
  track: string | null;
  team_code: string | null;
  team_state: string | null;
  players_joined: number | null;
};
type CaseRow = { owner_exception?: boolean; id: string; assignable: boolean; reason: string; case_code: string; title: string; track: string; status: string; content_version: number; validated: boolean; tested: boolean; active_assignments: number; teams_pinned: number };
type Audit = { id: number; created_at: string; action: string; actor: string; team_ref: string | null; case_code: string | null };
type Toast = (tone: "success" | "error" | "info", text: string) => void;

async function call(path: string, body?: unknown) {
  try {
    const r = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { error: "Network error. Is the server reachable?" } as Record<string, unknown> };
  }
}

// Registrations, manual case assignment and the audit trail (PRD 4, 13).
export default function Registrations({ toast }: { toast: Toast }) {
  const [regs, setRegs] = useState<Reg[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [lines, setLines] = useState("");
  const [created, setCreated] = useState<{ team_ref: string; registration_ref: string }[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [r, c, a] = await Promise.all([call("/api/admin/registrations"), call("/api/admin/cases"), call("/api/admin/audit")]);
    if (r.ok) setRegs((r.data.registrations as Reg[]) ?? []);
    if (c.ok) setCases((c.data.cases as CaseRow[]) ?? []);
    if (a.ok) setAudit((a.data.entries as Audit[]) ?? []);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    // one team per line: "Team name", "Team name, 2" or "Team name, 2, ABCD-2345" (a reference you already handed out)
    const registrations = lines
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(.*?)(?:\s*,\s*([1-3])(?:\s*,\s*([0-9A-Za-z-]{8,9}))?)?$/.exec(l)!;
        return { team_ref: m[1], team_size: m[2] ? Number(m[2]) : 3, ...(m[3] ? { registration_ref: m[3] } : {}) };
      });
    if (registrations.length === 0) return;
    setBusy(true);
    const r = await call("/api/admin/registrations", { registrations });
    setBusy(false);
    if (!r.ok) return toast("error", String(r.data.error ?? "Could not create registrations."));
    setCreated((r.data.registrations as { team_ref: string; registration_ref: string }[]) ?? []);
    setLines("");
    toast("success", `${registrations.length} registration${registrations.length === 1 ? "" : "s"} created.`);
    load();
  }

  async function assign(reg: Reg) {
    const chosen = cases.find((c) => c.id === pick[reg.id]);
    if (!chosen) return;
    // the exact version is sent, never just the code: v1 can never be substituted for v2 (or the reverse)
    const r = await call("/api/admin/assign-case", { registration_id: reg.id, case_id: chosen.id });
    if (r.ok) toast("success", `${reg.team_ref} assigned to ${chosen.case_code} v${chosen.content_version}.`);
    else toast("error", String(r.data.error ?? "Could not assign."));
    load();
  }

  const assignable = cases.filter((c) => c.assignable);
  const notYet = cases.filter((c) => !c.assignable && c.status !== "disabled");

  async function setStatus(c: CaseRow, status: "published" | "disabled") {
    const verb = status === "published" ? "publish" : "disable";
    if (!window.confirm(`${verb === "publish" ? "Publish" : "Disable"} ${c.case_code} version ${c.content_version}? ${status === "disabled" ? "Teams already playing it are not affected; it can no longer be assigned." : "Any other published version of this case will be disabled for new assignments."}`)) return;
    const r = await call("/api/admin/case-status", { case_code: c.case_code, content_version: c.content_version, status });
    if (r.ok) toast("success", `${c.case_code} v${c.content_version} is now ${status}.`);
    else toast("error", String(r.data.error ?? `Could not ${verb} that case.`));
    load();
  }

  return (
    <>
      <section className="panel" aria-labelledby="reg-title">
        <h2 id="reg-title" className="panel-title">Registrations and case assignment</h2>
        <form onSubmit={create} className="stack">
          <label className="field">
            <span>Add teams (one per line; optional size 1-3 and your own reference: <em>Team name, 2, ABCD-2345</em>)</span>
            <textarea rows={3} value={lines} onChange={(e) => setLines(e.target.value)} placeholder={"Byte Detectives, 3\nCrime Scene Coders"} />
          </label>
          <button type="submit" className="btn primary" disabled={busy || !lines.trim()}>{busy ? "Creating…" : "Create registrations"}</button>
        </form>
        {created.length > 0 && (
          <div className="created" role="status">
            <p className="muted">Hand these registration references to the team heads. They are shown here as well in the table below.</p>
            <ul>{created.map((c) => <li key={c.registration_ref}><b>{c.team_ref}</b> <code className="mono">{c.registration_ref}</code></li>)}</ul>
          </div>
        )}

        {regs.length === 0 ? (
          <p className="empty">No registrations yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="lb admin-table">
              <caption className="sr-only">Registrations</caption>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Assigned case</th>
                  <th scope="col">Team status</th>
                  <th scope="col">Assign</th>
                </tr>
              </thead>
              <tbody>
                {regs.map((r) => (
                  <tr key={r.id}>
                    <td><b className="team-name">{r.team_ref}</b><span className="case-name">size {r.team_size}{r.players_joined !== null ? ` · ${r.players_joined} joined` : ""}</span></td>
                    <td className="mono">{r.registration_ref}</td>
                    <td>{r.case_code ? <><b>{r.case_code}</b> <span className="case-name">{r.case_title}</span></> : <span className="muted">Not assigned</span>}</td>
                    <td>
                      {r.team_state ? <StatusPill tone={r.team_state === "FINISHED" ? "green" : r.team_state === "WAITING" ? "muted" : "cyan"}>{r.team_state}</StatusPill> : <span className="muted">not joined</span>}
                      {r.team_code && <span className="case-name mono">{r.team_code}</span>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <select aria-label={`Case for ${r.team_ref}`} value={pick[r.id] ?? ""} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                          <option value="">Choose a case…</option>
                          {assignable.map((c) => <option key={c.id} value={c.id}>{c.case_code} · {c.title} (v{c.content_version})</option>)}
                        </select>
                        <button type="button" className="btn ghost sm" disabled={!pick[r.id]} onClick={() => assign(r)}>{r.case_code ? "Reassign" : "Assign"}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="cases-title">
        <h2 id="cases-title" className="panel-title">Case catalogue and publication</h2>
        <p className="muted" data-testid="review-only-note">{notYet.length > 0 ? `${notYet.length} version${notYet.length === 1 ? " is" : "s are"} not assignable yet (see the Why column). The assignment list shows only published, eligible versions, so a new case appears there only after its human review, blind playtest and publication.` : "Every listed version is assignable or disabled."}</p>
        <p className="muted">Lifecycle: draft, review, tested, published. Only a tested version can be published, and only a published version can be assigned. A version a team has started stays pinned to it.</p>
        <div className="table-wrap">
          <table className="lb admin-table" data-testid="case-catalogue">
            <caption className="sr-only">Case versions</caption>
            <thead>
              <tr><th scope="col">Case</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Checks</th><th scope="col">In use</th><th scope="col">Assignable</th><th scope="col">Action</th></tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={`${c.case_code}-${c.content_version}`}>
                  <td><b>{c.case_code}</b> <span className="case-name">{c.track} · {c.title}</span></td>
                  <td className="mono">v{c.content_version}</td>
                  <td><StatusPill tone={c.status === "published" ? "green" : c.status === "disabled" ? "muted" : "cyan"}>{c.status}</StatusPill></td>
                  <td className="case-name">{c.validated ? "validated" : "not validated"} · {c.tested ? (c.owner_exception ? "OWNER EXCEPTION: no review or playtest done" : "human-tested") : "not human-tested"}</td>
                  <td className="case-name">{c.active_assignments} assigned · {c.teams_pinned} team{c.teams_pinned === 1 ? "" : "s"}</td>
                  <td className="case-name" data-testid={`assignable-${c.case_code}-v${c.content_version}`}><b>{c.assignable ? "Yes" : "No"}</b> · {c.reason}</td>
                  <td>
                    <div className="row-actions">
                      {c.status === "tested" && <button type="button" className="btn ghost sm" onClick={() => setStatus(c, "published")}>Publish</button>}
                      {c.status !== "disabled" && <button type="button" className="btn ghost sm" onClick={() => setStatus(c, "disabled")}>Disable</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="audit-title">
        <h2 id="audit-title" className="panel-title">Audit log</h2>
        {audit.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <div className="table-wrap short">
            <table className="lb compact">
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{new Date(a.created_at).toLocaleString()}</td>
                    <td>{a.action}</td>
                    <td>{a.team_ref ?? ""}</td>
                    <td className="mono">{a.case_code ?? ""}</td>
                    <td>{a.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
