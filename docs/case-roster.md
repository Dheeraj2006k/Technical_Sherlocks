# Case roster

The twelve cases supplied in `docs/*.zip`, packaged as Case Packs under `cases/<CODE>-<slug>/`. Public facts only: culprits, answers and explanations live in each pack's private files (`ground-truth.json`, `answer-key.md`) and are never shipped to the browser (`npm run check:leaks`).

| Code | Title | Track | Team | Minutes | Questions (answer types) | Points: questions + culprit + explanation | Version, status |
|---|---|---|---|---|---|---|---|
| LOG01 | The Locked Room That Wasn't | Logic | 1 | 18 | 9 (CHOICE) | 45 + 35 + 20 | v2 review |
| LOG02 | The Vanishing Trophy | Logic | 1 | 18 | 9 (CHOICE) | 45 + 35 + 20 | v2 review |
| LOG03 | The Silent Call | Logic | 2 | 15 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| LOG04 | The Rainy-Day Alibi | Logic | 2 | 18 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| LOG05 | The Duplicate Invitation | Logic | 1 | 15 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| LOG06 | The Last Render | Logic | 1 | 15 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| SQL01 | Seven Minutes Late | SQL | 3 | 20 | 6 (NUMBER, TEXT, TIME) | 60 + 25 + 15 | v2 review |
| SQL02 | The Last Show | SQL | 3 | 20 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| SQL03 | The Missing Batch | SQL | 2 | 20 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| SQL04 | The Borrowed Badge | SQL | 2 | 20 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| SQL05 | The Wrong Parcel | SQL | 1 | 20 | 6 (CHOICE) | 60 + 25 + 15 | v2 review |
| SQL06 | The Empty Account | SQL | 1 | 20 | 6 (NUMBER, TEXT) | 60 + 25 + 15 | v2 review |

Every case totals exactly 100. All are `review`: no human review or blind playtest is recorded, so none may be marked tested or published until both are recorded against the exact content hash (see case-authoring-standard.md).
