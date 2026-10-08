import { randomInt } from "node:crypto";

// Crockford base32 (no I, L, O, U). Keep in sync with scripts/lib/codes.mjs.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]+$/;

export function randomCode(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

// Uppercase, strip spaces/hyphens, O->0, I/L->1, then validate length + alphabet.
// Returns null when the input can't be a valid code (callers treat that as a generic failure).
export function normalizeCode(raw: unknown, len: number): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const s = raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return s.length === len && CODE_RE.test(s) ? s : null;
}

export const generateTeamCode = () => randomCode(6);

export function formatCode(raw: string): string {
  const h = raw.length / 2;
  return `${raw.slice(0, h)}-${raw.slice(h)}`;
}
