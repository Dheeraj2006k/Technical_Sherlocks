"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "./ui";
import { post } from "./api";

const REDUCED = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Landing({ onJoined }: { onJoined: () => void }) {
  const [mode, setMode] = useState<"head" | "investigator">("head");
  const [regRef, setRegRef] = useState("");
  const [caseCode, setCaseCode] = useState("");
  const [password, setPassword] = useState("");
  const [teamCode, setTeamCode] = useState("");
  const [headPassword, setHeadPassword] = useState(""); // only needed to rejoin as the team lead
  const [name, setName] = useState("");
  // One key per create attempt: a double-click or retry reuses it, so only one team is made.
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const errId = useId();

  // let the case-file animation play, then enter
  useEffect(() => {
    if (!opening) return;
    const t = setTimeout(onJoined, REDUCED() ? 0 : 950);
    return () => clearTimeout(t);
  }, [opening, onJoined]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || opening) return;
    setBusy(true);
    setError("");
    const body =
      mode === "head"
        ? { registration_ref: regRef, case_code: caseCode, case_password: password, display_name: name, idempotency_key: key }
        : { team_code: teamCode, display_name: name, ...(headPassword ? { case_password: headPassword } : {}) };
    const r = await post("/api/join", body);
    setBusy(false);
    if (!r.ok) {
      const msg = typeof r.data.error === "string" ? r.data.error : "";
      if (r.status === 401) setError("Those credentials were not recognized. Check your registration reference, the case code and the password your organizer gave you.");
      else if (r.status === 409) setError(msg || "That investigation team is full.");
      else if (r.status === 429) setError(`Too many attempts. Wait ${r.retryAfter ?? "a minute"} seconds and try again.`);
      else setError(msg || "Could not reach the investigation server. Try again.");
      return;
    }
    setOpening(true);
  }

  const invalid = error ? { "aria-invalid": true, "aria-describedby": errId } : {};

  return (
    <main id="main" className="landing grid-bg">
      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow"><Icon name="magnifier" size={14} /> Techfest · Investigation</p>
        <h1 id="hero-title" className="hero-title">
          Sherlock&apos;s <span>Last Case</span>
        </h1>
        <p className="hero-sub">Every crime leaves a query.</p>
        <p className="hero-copy">
          Your team gets a live evidence file, three phases of investigation threads and a final deduction. Follow the evidence,
          answer the questions, name who is responsible and explain how. Highest score wins; speed breaks ties.
        </p>
        <ol className="how">
          <li><b>1</b> Form a team of up to three</li>
          <li><b>2</b> Work the investigation threads</li>
          <li><b>3</b> Make the final deduction</li>
        </ol>
        <div className="casefile" aria-hidden="true">
          <div className="casefile-tab">CASE FILE · 0001</div>
          <div className="casefile-card">
            <span className="stamp">CLASSIFIED</span>
            <pre className="code-sample">
              <span className="tok-kw">SELECT</span> name, alibi{"\n"}
              <span className="tok-kw">FROM</span>   suspects{"\n"}
              <span className="tok-kw">WHERE</span>  alibi <span className="tok-kw">IS NULL</span>
              <span className="caret" />
            </pre>
          </div>
        </div>
      </section>

      <section className="panel entry" aria-labelledby="entry-title">
        <h2 id="entry-title" className="panel-title">Enter investigation</h2>
        <div role="tablist" aria-label="How do you want to join?" className="tabs">
          <button type="button" role="tab" id="tab-head" aria-selected={mode === "head"} aria-controls="entry-form" className={mode === "head" ? "on" : ""} onClick={() => { setMode("head"); setError(""); }}>
            Create Investigation
          </button>
          <button type="button" role="tab" id="tab-inv" aria-selected={mode === "investigator"} aria-controls="entry-form" className={mode === "investigator" ? "on" : ""} onClick={() => { setMode("investigator"); setError(""); }}>
            Join Investigation
          </button>
        </div>

        <form id="entry-form" role="tabpanel" aria-labelledby={mode === "head" ? "tab-head" : "tab-inv"} onSubmit={submit} className="stack">
          {mode === "head" ? (
            <>
              <p className="hint">You are the team lead. Enter your registration reference and the case your organizer assigned to your team.</p>
              <label className="field">
                <span>Registration reference</span>
                <input value={regRef} onChange={(e) => setRegRef(e.target.value)} placeholder="XXXX-XXXX" required autoComplete="off" autoCapitalize="characters" spellCheck={false} {...invalid} />
              </label>
              <label className="field">
                <span>Case code</span>
                <input value={caseCode} onChange={(e) => setCaseCode(e.target.value)} placeholder="SQL01 or LOG01" required autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" {...invalid} />
              </label>
              <label className="field">
                <span>Case password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="off" {...invalid} />
              </label>
            </>
          ) : (
            <>
              <p className="hint">Your team lead has a team code on their screen. Type it here.</p>
              <label className="field">
                <span>Team code</span>
                <input value={teamCode} onChange={(e) => setTeamCode(e.target.value)} placeholder="XXX-XXX" required autoComplete="off" autoCapitalize="characters" spellCheck={false} {...invalid} />
              </label>
            </>
          )}
          <label className="field">
            <span>Your codename</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoComplete="off" placeholder="Your name or alias" />
          </label>
          {mode === "investigator" && (
            <label className="field">
              <span>Case password <em>(only if you are rejoining as team lead)</em></span>
              <input type="password" value={headPassword} onChange={(e) => setHeadPassword(e.target.value)} autoComplete="off" />
            </label>
          )}
          {error && <p id={errId} className="form-error" role="alert"><Icon name="alert" size={16} /> {error}</p>}
          <button type="submit" className="btn primary lg" disabled={busy || opening}>
            {busy ? "Verifying credentials…" : opening ? "Opening…" : mode === "head" ? "Open the case file" : "Enter the briefing room"}
          </button>
          {mode === "investigator" && <p className="hint">Rejoining after a crash? Use the same team code and the same codename.</p>}
        </form>
        <p className="panel-foot"><a href="/leaderboard">View the investigation board</a></p>
      </section>

      {opening && (
        <div className="opening" role="status" aria-live="polite">
          <div className="opening-folder"><i /><b /></div>
          <p>Opening case file…</p>
        </div>
      )}
    </main>
  );
}
