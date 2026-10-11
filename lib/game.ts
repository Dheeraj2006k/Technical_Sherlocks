import { HttpError } from "./http";

export type AnswerType = "SINGLE_CHARACTER" | "NUMBER" | "TIME" | "TEXT";

export const MAX_PLAYERS = 3;

// Canonical form for exact-match grading; null = not a valid value of that type.
export function normalize(type: string, raw: string): string | null {
  const v = raw.trim();
  switch (type) {
    case "SINGLE_CHARACTER":
      return v.toLowerCase();
    case "NUMBER": {
      if (!/^[+-]?\d+(\.\d+)?$/.test(v)) return null;
      const n = Number(v);
      return Number.isFinite(n) ? String(n === 0 ? 0 : n) : null;
    }
    case "TIME": {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return null;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
    case "TEXT":
      return v.toLowerCase();
    default:
      return null;
  }
}

export function grade(type: string, submitted: string, correct: string): boolean {
  const a = normalize(type, submitted);
  const b = normalize(type, correct);
  return a !== null && b !== null && a === b;
}

export function cleanName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "display_name is required");
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) throw new HttpError(400, "display_name is required");
  if (/[\x00-\x1f\x7f]/.test(s)) throw new HttpError(400, "display_name contains invalid characters");
  if (s.length > 40) throw new HttpError(400, "display_name is too long (40 max)");
  return s;
}
