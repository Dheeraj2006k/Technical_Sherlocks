// Builds the app, then scans .next/static (the client-delivered output) for secrets.
// Checks: every value in .env.local (without printing it), "service_role", "postgres://".
// Usage: node scripts/check-bundle-leaks.mjs [--no-build] | --self-test
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvLocal } from './lib/env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_LEN = 8;
const REQUIRED = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_PASSWORD'];
const OPTIONAL = ['SUPABASE_SERVICE_ROLE_KEY'];

// Returns { errors, needles, skipped } for an env object.
export function buildNeedles(env) {
  const errors = [];
  const needles = [];
  const skipped = [];
  for (const k of REQUIRED) {
    const v = env[k] ?? '';
    if (v.length < MIN_LEN) errors.push(`${k} must be set and at least ${MIN_LEN} characters`);
    else needles.push({ label: `value of ${k}`, text: v });
  }
  for (const k of OPTIONAL) {
    const v = env[k] ?? '';
    if (v) needles.push({ label: `value of ${k}`, text: v }); // empty: skip silently
  }
  for (const [k, v] of Object.entries(env)) {
    if (REQUIRED.includes(k) || OPTIONAL.includes(k)) continue;
    // Short values (e.g. "true", "3000") would false-positive.
    if (v.length >= MIN_LEN) needles.push({ label: `value of ${k}`, text: v });
    else if (v.length > 0) skipped.push(k);
  }
  needles.push({ label: '"service_role"', text: 'service_role' });
  needles.push({ label: '"postgres://"', text: 'postgres://' });
  needles.push({ label: '"postgresql://"', text: 'postgresql://' });
  return { errors, needles, skipped };
}

function walk(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function scan(dir, needles) {
  const files = walk(dir);
  const leaks = [];
  for (const f of files) {
    const buf = readFileSync(f, 'utf8');
    for (const n of needles) if (buf.includes(n.text)) leaks.push(`${n.label} found in ${relative(root, f)}`);
  }
  return { files: files.length, leaks };
}

function selfTest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
    if (!cond) failed++;
  };
  const good = { DATABASE_URL: 'x'.repeat(12), SESSION_SECRET: 's'.repeat(12), ADMIN_PASSWORD: 'p'.repeat(12) };

  check('valid required secrets pass validation', buildNeedles(good).errors.length === 0);
  check('short required secret is an error', buildNeedles({ ...good, ADMIN_PASSWORD: 'short' }).errors.length === 1);
  check('missing required secret is an error', buildNeedles({ ...good, SESSION_SECRET: undefined }).errors.length === 1);
  const emptyKey = buildNeedles({ ...good, SUPABASE_SERVICE_ROLE_KEY: '' });
  check('empty service key: no error, not scanned, not reported', emptyKey.errors.length === 0 && !emptyKey.needles.some((n) => n.label.includes('SERVICE_ROLE_KEY')) && emptyKey.skipped.length === 0);
  const shortKey = buildNeedles({ ...good, SUPABASE_SERVICE_ROLE_KEY: 'abc' });
  check('set service key (even short) is scanned, no error', shortKey.errors.length === 0 && shortKey.needles.some((n) => n.label.includes('SERVICE_ROLE_KEY')));

  // Plant fake leaks in a throwaway dir and confirm the scanner flags them.
  const dir = join(root, '.next', 'selftest-static');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = { ...good, SUPABASE_SERVICE_ROLE_KEY: 'k-1234' };
  const { needles } = buildNeedles(env);
  try {
    writeFileSync(join(dir, 'clean.js'), 'console.log("hello")');
    check('clean bundle: no leaks', scan(dir, needles).leaks.length === 0);
    for (const [name, text] of [
      ['DATABASE_URL value', env.DATABASE_URL],
      ['service key value (short)', env.SUPABASE_SERVICE_ROLE_KEY],
      ['service_role string', 'service_role'],
      ['postgres:// string', 'postgres://u:p@h/db'],
    ]) {
      writeFileSync(join(dir, 'leak.js'), `var a="${text}";`);
      check(`detects planted ${name}`, scan(dir, needles).leaks.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `SELF-TEST FAILED (${failed})` : 'SELF-TEST PASSED');
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--self-test')) selfTest();

const { errors, needles, skipped } = buildNeedles(parseEnvLocal(root));
if (errors.length) {
  for (const e of errors) console.error(`ENV: ${e}`);
  process.exit(1);
}

if (!process.argv.includes('--no-build')) {
  const b = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
  if (b.status !== 0) {
    console.error('build failed');
    process.exit(1);
  }
}

const { files, leaks } = scan(join(root, '.next', 'static'), needles);
for (const l of leaks) console.error(`LEAK: ${l}`);
console.log(`scanned ${files} files in .next/static against ${needles.length} patterns`);
if (skipped.length) console.log(`skipped short env values (<${MIN_LEN} chars): ${skipped.join(', ')}`);
if (leaks.length) {
  console.error(`FAIL: ${leaks.length} leak(s)`);
  process.exit(1);
}
console.log('PASS: no secrets in client bundle');
