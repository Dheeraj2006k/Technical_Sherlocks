import { randomInt } from 'node:crypto';

// Crockford base32 (no I, L, O, U). Keep in sync with lib/codes.ts.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// Readable password alphabet: no 0/O, 1/I/L.
export const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomFrom(alphabet, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

export const randomCaseCode = () => randomFrom(CODE_ALPHABET, 8);
export const randomPassword = () => randomFrom(PASSWORD_ALPHABET, 12);
export const formatCode = (raw) => `${raw.slice(0, raw.length / 2)}-${raw.slice(raw.length / 2)}`;

export function normalizeCode(raw, len) {
  if (typeof raw !== 'string') return null;
  const s = raw.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === len && /^[0-9A-HJKMNP-TV-Z]+$/.test(s) ? s : null;
}
