# Case authoring standard

A case is a folder `cases/<CODE>-<slug>/`. The pack is the source of truth; the database is a build output.

| File | Public? | Content |
|---|---|---|
| `manifest.json` | no | code, track, title, slug, `content_version`, status, team size, duration, `publication_eligible` |
| `story.md` | yes | `# Hook` and `## Phase 1/2/3 briefing` (each over 120 characters; must not announce the solution) |
| `characters.json` | yes | roster: name, role, profile, `suspect` flag |
| `ground-truth.json` | PRIVATE | culprit, victim, motive, method, timeline, causal chain, resolution |
| `investigation.json` | yes | phases (name, tables), threads (prerequisites, unlocks, intro, outcome), story events |
| `tasks.json` | partly | prompt, answer type (`NUMBER`, `TIME`, `TEXT`, `CHOICE`, `SINGLE_CHARACTER`), answer, `alt_answers`, options, points, private explanation, reference SQL |
| `hints.json` | yes | 2-5 ordered hints per question and the scoring rule |
| `final-deduction.json` | yes | culprit points, 3-4 explanation choices, exactly one correct |
| `solution-map.json` | PRIVATE | evidence-to-solution map and 2-3 red herrings with innocent explanations, each with a verifying query |
| `evidence/schema.sql`, `evidence/seed/*.json` | yes | `create table` only; rows as `{columns, rows}` |
| `tests/expectations.json` | PRIVATE | query results the author expects |
| `review.json`, `answer-key.md` | PRIVATE | review record; human-readable key |

Enforced by `npm run validate:cases`: totals exactly 100; reward ladders strictly decrease; every reference query runs on the unlocked tables and returns the intended answer; every red herring has an innocent explanation backed by data; solution-map evidence exists in the data; no question needs a locked table; hints are distinct; a required thread never depends on an optional one; Logic hints contain no SQL.

Lifecycle: `draft -> review -> tested -> published`. `tested` needs `review.json` to record a human reviewer and a completed blind playtest for the exact content hash. Changing any content file changes the hash and invalidates both. A human review or playtest is never faked.
