// Presentation copy for the investigation phases. Purely cosmetic: the server owns all game state.
export const PHASES = [
  { n: 1, title: "Establish the scene", focus: "Access · Presence · Opportunity", step: "Scene analyzed" },
  { n: 2, title: "Connect the evidence", focus: "Objects · Actions · Timeline", step: "Evidence connected" },
  { n: 3, title: "Identify the motive", focus: "Messages · Relationships · Contradictions", step: "Motive established" },
] as const;

export const phaseTitle = (n: number) => PHASES.find((p) => p.n === n)?.title ?? "Final deduction";

export const KIND_LABEL: Record<string, string> = {
  PERSON: "Person",
  ACCESS: "Access log",
  OBJECT: "Object",
  MESSAGE: "Message",
  TIME: "Time",
  MOTIVE: "Motive",
};

export const TABLE_HINT: Record<string, string> = {};

export function fmtClock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
