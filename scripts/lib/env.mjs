import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Parses .env.local into a plain object (does not touch process.env).
export function parseEnvLocal(root) {
  const p = join(root, '.env.local');
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Loads .env.local into process.env without overriding existing vars.
export function loadEnvLocal(root) {
  for (const [k, v] of Object.entries(parseEnvLocal(root))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
