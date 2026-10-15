import { HttpError } from "./http";

export type AnswerType = "SINGLE_CHARACTER" | "NUMBER" | "TIME" | "TEXT" | "CHOICE";

export const MAX_PLAYERS = 3;

// Canonical form for exact-match grading; null = not a valid value of that type.
export function normalize(type: string, raw: string): string | null {
  const v = raw.trim();
  switch (type) {
    case "SINGLE_CHARACTER":
      return v.toLowerCase();
    case "NUMBER": {
      // tolerate a currency mark, thousands commas and a trailing unit word ("₹42,000", "42000 rupees"): same number, same answer
      const n0 = v.replace(/^(₹|rs\.?\s*|inr\s*)/i, "").replace(/\s*(rupees|inr|rs)$/i, "").replace(/,/g, "").trim();
      if (!/^[+-]?\d+(\.\d+)?$/.test(n0)) return null;
      const n = Number(n0);
      return Number.isFinite(n) ? String(n === 0 ? 0 : n) : null;
    }
    case "TIME": {
      // 21:32, 9:32 PM and 21:32:00 are the same time
      const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i.exec(v);
      if (!m) return null;
      let h = Number(m[1]);
      const min = Number(m[2]);
      if (m[3]) {
        if (h < 1 || h > 12) return null;
        h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      }
      if (h > 23 || min > 59) return null;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    case "TEXT":
      return v.toLowerCase().replace(/\s+/g, " ");
    case "CHOICE":
      return /^[A-Za-z0-9]{1,8}$/.test(v) ? v.toLowerCase() : null;
    default:
      return null;
  }
}

// Exact-match grading only. `alts` are other wordings the author accepts for the same answer (same normalisation, no fuzzy matching).
export function grade(type: string, submitted: string, correct: string, alts: string[] = []): boolean {
  const a = normalize(type, submitted);
  if (a === null) return false;
  return [correct, ...alts].some((c) => normalize(type, c) === a);
}

export function cleanName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "display_name is required");
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "display_name is required");
  if (/[\x00-\x1f\x7f]/.test(s)) throw new HttpError(400, "display_name contains invalid characters");
  if (s.length > 40) throw new HttpError(400, "display_name is too long (40 max)");
  return s;
}
