// Registry of the ten supported cases (SQL01-SQL05, LOG01-LOG05), built from the Case Packs under cases/.
// The packs are the canonical source; this module only loads them in catalogue order.
import { createHash } from 'node:crypto';
import { CATALOGUE_CODES, loadAllPacks } from './pack.mjs';

export const PACKS = loadAllPacks().sort((a, b) => CATALOGUE_CODES.indexOf(a.manifest?.case_code) - CATALOGUE_CODES.indexOf(b.manifest?.case_code));
export const DEFINITIONS = PACKS.filter((p) => p.def).map((p) => ({ ...p.def, contentHash: p.hash }));

// Stable id per (code, version): re-seeding the same version always addresses the same row; a new version gets a new row.
export function caseIdFor(code, version) {
  const h = createHash('sha256').update(`slc-case:${code}:${version}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
