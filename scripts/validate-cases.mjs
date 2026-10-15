// The validation gate for case packs (PRD Addendum 1, section 6). Exits non-zero when ANY check fails.
//
//   node scripts/validate-cases.mjs              structural checks, then database checks on an isolated LOCAL Postgres
//   node scripts/validate-cases.mjs --no-db      structural checks only (no database needed)
//   node scripts/validate-cases.mjs --only SQL03
//
// Structural: files, fields, identifiers, references, prerequisites (no cycles), answer types, hint order, score totals
// (exactly 100), final choices, solution map, red herrings. Database (rolled back, never keeps anything): reference queries
// return exactly the canonical answer using only evidence unlocked by then, solution-map and red-herring evidence exists,
// expected results match, per-table RLS keys exist. The whole set must also cover exactly the ten catalogue codes.
import { PACKS } from './cases/index.mjs';
import { CATALOGUE_CODES, structuralChecks } from './cases/pack.mjs';
import { runScript, startLocalPg } from './lib/localpg.mjs';

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx > -1 ? args[onlyIdx + 1]?.toUpperCase() : null;
let failed = 0;

const codes = PACKS.map((p) => p.manifest?.case_code);
const missing = CATALOGUE_CODES.filter((c) => !codes.includes(c));
const extra = codes.filter((c) => !CATALOGUE_CODES.includes(c));
if (!only && (missing.length || extra.length || new Set(codes).size !== codes.length)) {
  console.log(`FAIL catalogue: missing [${missing}] unexpected [${extra}] duplicates ${new Set(codes).size !== codes.length}`);
  failed++;
} else if (!only) console.log(`ok   catalogue: ${codes.length} packs, exactly ${CATALOGUE_CODES.join(' ')}`);

for (const pack of PACKS) {
  const code = pack.manifest?.case_code ?? pack.folder;
  if (only && code !== only) continue;
  const results = structuralChecks(pack);
  const bad = results.filter((r) => !r.ok);
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${code} v${pack.manifest?.content_version} ${pack.manifest?.title ?? ''} (${results.length} structural checks)`);
  for (const b of bad) console.log(`       - ${b.label}${b.detail ? `: ${b.detail}` : ''}`);
  failed += bad.length;
}

if (!args.includes('--no-db') && failed === 0) {
  console.log('\nDatabase checks on an isolated local Postgres (nothing is kept)...');
  const { stop } = await startLocalPg();
  try {
    runScript(['scripts/migrate.mjs']);
    runScript(['scripts/verify-case.mjs', ...(only ? ['--only', only] : [])]);
  } catch (e) {
    console.log(`FAIL database checks: ${e.message}`);
    failed++;
  } finally {
    await stop().catch(() => {});
  }
}
console.log(failed ? `\n${failed} problem(s) found` : '\nall case packs valid');
process.exit(failed ? 1 : 0);
