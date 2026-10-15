// The per-pack seeding decision and action, shared by scripts/seed-cases.mjs and the tests.
//   plan   = what would happen to one (case code, content version) given what the database holds
//   apply  = do it inside the caller's open transaction
// Seeding loads configuration AND evidence for ONE content version. It never touches teams, players, scores, attempts,
// hints used, registrations or assignments, never publishes, never resets, and refuses to change content that a team is
// pinned to or that has been tested or published (a changed pack must bump content_version).
import { provisionCase } from './provision.mjs';
import { caseIdFor } from '../cases/index.mjs';
import { deleteCaseContent, installCase, verifyDefinition } from '../cases/engine.mjs';

export async function planSeed(client, pack) {
  const code = pack.manifest.case_code;
  const version = pack.manifest.content_version;
  const ex = (await client.query('select id, status, content_hash, password_hash from cases where case_code = $1 and content_version = $2', [code, version])).rows[0];
  const teams = ex ? (await client.query('select count(*)::int n from teams where case_id = $1', [ex.id])).rows[0].n : 0;
  const same = Boolean(ex) && ex.content_hash === pack.hash;
  const action = !ex ? 'install' : same ? 'unchanged' : teams > 0 || ['tested', 'published'].includes(ex.status) ? 'blocked' : 'replace';
  return { code, version, existing: ex ?? null, teams, action };
}

export async function applySeed(client, pack, plan) {
  const { code, version, existing: ex, action } = plan;
  if (action === 'blocked') throw new Error(`content of ${code} v${version} changed but it is ${plan.teams > 0 ? 'pinned by live teams' : ex.status}; bump content_version`);
  if (action === 'unchanged') {
    await provisionCase(client, ex.id); // re-applies the RLS gate without rotating any key
    return { action, checks: 0, failed: [] };
  }
  const prev = (await client.query('select password_hash from cases where case_code = $1 and content_version < $2 order by content_version desc limit 1', [code, version])).rows[0];
  const passwordHash = ex?.password_hash ?? prev?.password_hash;
  const id = ex?.id ?? caseIdFor(code, version);
  if (action === 'replace') await deleteCaseContent(client, ex.id);
  const r = await installCase(client, pack.def, { id, status: 'draft', passwordHash, contentHash: pack.hash, version });
  const results = await verifyDefinition(client, pack.def, r);
  const failed = results.filter((c) => !c.ok);
  if (failed.length === 0) {
    await client.query('update cases set validated_hash = content_hash where id = $1', [id]);
    await client.query("select transition_case_status($1, 'review', 'seed-cases')", [id]);
  }
  return { action, checks: results.length, failed, caseId: id };
}
