# Seeding specification

`node scripts/seed-cases.mjs [--dry-run] [--only CODE,...]`

For each pack the planner compares the pack content hash with the database:

- INSTALL: no row for (code, version). Installed as `review` after the automated gate passes, in a transaction (a failed check leaves nothing behind). The password hash is inherited from the previous version of the code, so credentials never rotate by accident.
- UNCHANGED: same hash. Nothing is written (a second run changes no row, key or team).
- REPLACE: same version, different hash, and no team or assignment references it. The unreferenced version is rebuilt.
- BLOCKED: referenced by a team or assignment. Nothing is touched; bump `content_version`.

Seeding never updates team state, never deletes a referenced case, and refuses a remote database unless `SLC_ALLOW_REMOTE_DB=1`. `--dry-run` prints the plan and writes nothing. Output has codes, versions and statuses only (no passwords, hashes or answers).

Related: `scripts/case-lifecycle.mjs CODE VERSION status|tested|published`; `scripts/retire-legacy-cases.mjs [--apply]` (disables, never deletes, cases outside the catalogue); `scripts/gen-case-credentials.mjs` (new password per case, hash only in the database, published cases only).
