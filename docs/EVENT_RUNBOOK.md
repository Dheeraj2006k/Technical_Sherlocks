# Event runbook

## Before the event
1. `npm run check:env` against the target environment (12+ migrations, twelve catalogue codes, published cases, keys).
2. For each case you will run: status `published` in Admin -> Cases, with a human review and a blind playtest recorded for the exact content hash.
3. Generate case passwords once (`node scripts/gen-case-credentials.mjs`) and distribute them out of band. Never regenerate during an event.
4. Smoke test the deployed URL.

## Production smoke checklist (NOT TESTED until run on production)
Landing loads; join; case assignment; lobby shows the case file; start; case file opens first, then the tour; Skip works; story banner visible; SQL console (SQL) / Evidence Browser (Logic); Field Guide opens and keeps the query text; answer, hint, wrong answer (-2); phase unlock; final deduction; leaderboard; admin pause/resume; reassign; Publish/Disable.

## During the event
- Pause per team or globally from Admin; nothing is lost.
- Disable a case to stop new assignments; running teams continue on their pinned version.
- Never run reset-all, TRUNCATE or a reseed against production.

## After
Export the leaderboard; leave data in place.
