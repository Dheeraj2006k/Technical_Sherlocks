// ENGINE TEST FIXTURES ONLY: the old machine-generated cases, kept so the engine, evidence, security and UI suites keep a stable shape to test.
// They are never seeded, never assignable and are not part of the catalogue (see cases/ for the real cases).
// Registry of all 20 cases: SQL01-SQL10 (SQL track) and LOG01-LOG10 (Logic track).
import { definition as openingNight } from './opening-night.mjs';
import { buildSkeletonA } from './skeleton-a.mjs';
import { buildSkeletonB } from './skeleton-b.mjs';
import { THEMES } from './themes.mjs';
import { THEMES_B } from './themes-b.mjs';
import { toV5Sql } from './to-v5.mjs';

const sqlSources = [openingNight, ...THEMES.map(buildSkeletonA)];
export const DEFINITIONS = [
  ...sqlSources.map((d, i) => toV5Sql(d, i + 1)),
  ...THEMES_B.map((t, i) => buildSkeletonB(t, i + 1)),
];

// Stable ids so reseeding replaces a case in place: SQL cases ...00a1-..00aa (as in earlier versions), Logic ...00b1-..00ba.
export const caseIdFor = (index) => {
  const nn = (index % 10) + 1;
  return `00000000-0000-4000-8000-0000000000${index < 10 ? 'a' : 'b'}${nn.toString(16)}`;
};
