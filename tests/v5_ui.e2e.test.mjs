// Real-browser end-to-end tests (system Chrome driven by playwright-core): three players on three separate browser
// contexts play a whole SQL case; a Logic case with the Evidence Browser; a phone-sized run; the leaderboards; mission
// control with registrations and assignment. Screenshots go to the OS temp dir (never into the repo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { db, makeGame, defByCode, BASE, randomIp } from './helpers.mjs';

const pool = db();
let S; // SQL case
let L; // Logic case
let browser;
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
const skip = CHROME ? false : 'no Chrome/Edge found (set CHROME_PATH)';
const shots = join(tmpdir(), 'slc-ui-shots-v5');

before(async () => {
  S = await makeGame(pool, defByCode('SQL01'));
  L = await makeGame(pool, defByCode('LOG01'));
  if (CHROME) {
    mkdirSync(shots, { recursive: true });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  }
});
after(async () => {
  await browser?.close();
  await pool.query("delete from registrations where team_ref like 'E2E %'");
  await S.cleanup();
  await L.cleanup();
  await pool.end();
});

const fmt4 = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const ctxOpts = (extra = {}) => ({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': randomIp() }, ...extra });

function watch(page, problems) {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chrome logs every non-2xx fetch as a console error; these client errors are expected answers (not signed in,
    // a deliberately invalid query, locked, rate limited). Page errors and 5xx responses still fail the test.
    if (m.type() === 'error' && !/Failed to load resource.*\b(400|401|404|409|423|429)\b/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
}

const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(o.sw <= o.iw + 1, `${label}: horizontal overflow (${o.sw} > ${o.iw})`);
};

const questionsOf = (game) => game.def.threads.flatMap((t) => t.questions);

// On first entry the case file opens, then the guided tour: close both so the test can play (their own behaviour is in the onboarding tests).
async function dismissIntro(page) {
  const close = page.getByTestId('case-file-close');
  if (await close.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    // the story is the first thing a player sees: the case file opens with the hook, and the banner stays on screen afterwards
    assert.ok((await page.getByTestId('case-file').innerText()).length > 150, 'the case file shows the story');
    await close.click();
    await page.getByTestId('story-banner').waitFor();
  }
  const skip = page.getByRole('button', { name: /Skip tour/ });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await page.keyboard.press('Escape'); // Esc always closes the tour
}

async function enterHead(page, game, reg, name) {
  await page.goto(BASE);
  await page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
  await page.getByLabel('Registration reference').fill(fmt4(reg.ref));
  await page.getByLabel('Case code').fill(game.caseCode);
  await page.getByLabel('Case password').fill(game.password);
  await page.getByLabel('Your codename').fill(name);
  await page.getByRole('button', { name: 'Open the case file' }).click();
}

async function enterInvestigator(page, teamCode, name) {
  await page.goto(BASE);
  await page.getByRole('tab', { name: 'Join Investigation' }).click();
  await page.getByLabel('Team code').fill(teamCode);
  await page.getByLabel('Your codename').fill(name);
  await page.getByRole('button', { name: 'Enter the briefing room' }).click();
}

// Types the right answer into the question's card and submits it. Returns the card.
async function answerInUi(page, game, index, { hint = false } = {}) {
  const q = questionsOf(game)[index];
  const task = game.tasks[index];
  const card = page.locator('article.task').filter({ hasText: q.prompt });
  await card.waitFor({ timeout: 15000 });
  if (hint) {
    await card.getByRole('button', { name: /Reveal hint 1/ }).click();
    await card.locator('.hints li').first().waitFor();
  }
  const field = card.locator('.answer');
  if (task.answer_type === 'SINGLE_CHARACTER') {
    const label = await field.locator('option', { hasText: q.answer }).first().textContent();
    await field.selectOption({ label });
  } else {
    await field.fill(q.answer);
  }
  await card.getByRole('button', { name: 'Submit answer' }).click();
  await card.getByText(/Correct! \+\d+ points/).waitFor({ timeout: 10000 });
  return card;
}

test('UI: three browsers play a whole SQL case, landing to resolution to leaderboard', { skip, timeout: 290000 }, async () => {
  const problems = [];
  const mk = async (extra) => {
    const ctx = await browser.newContext(ctxOpts(extra));
    const page = await ctx.newPage();
    watch(page, problems);
    return { ctx, page };
  };
  const A = await mk();
  const B = await mk();
  const C = await mk();
  const reg = await S.register({ teamRef: 'E2E Baker Street Irregulars', size: 3 });
  const culpritName = S.def.culpritName;

  try {
    // ---------- landing: the head enters registration credentials
    const resp = await A.page.goto(BASE);
    assert.equal(resp.headers()['x-frame-options'], 'DENY');
    assert.equal(resp.headers()['x-content-type-options'], 'nosniff');
    await A.page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
    await A.page.screenshot({ path: join(shots, '01-landing.png') });
    for (const label of ['Registration reference', 'Case code', 'Case password']) assert.equal(await A.page.getByLabel(label).getAttribute('autocomplete'), 'off');
    // wrong credentials: one clear, accessible error
    await A.page.getByLabel('Registration reference').fill(fmt4(reg.ref).toLowerCase());
    await A.page.getByLabel('Case code').fill(S.caseCode.toLowerCase());
    await A.page.getByLabel('Case password').fill('wrong');
    await A.page.getByLabel('Your codename').fill('Sherlock');
    await A.page.getByRole('button', { name: 'Open the case file' }).click();
    await A.page.getByRole('alert').filter({ hasText: 'not recognized' }).waitFor();
    await A.page.screenshot({ path: join(shots, '02-join-error.png') });
    await A.page.getByLabel('Case password').fill(S.password);
    await A.page.getByRole('button', { name: 'Open the case file' }).click();
    const teamCodeEl = A.page.locator('.teamcode');
    await teamCodeEl.waitFor();
    const teamCode = (await teamCodeEl.textContent()).trim();
    assert.match(teamCode, /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    await A.page.getByRole('heading', { name: S.def.title }).waitFor();
    await A.page.getByText('SQL investigation').waitFor();

    // ---------- investigators join; the team size cap holds
    await enterInvestigator(B.page, teamCode.replace('-', '').toLowerCase(), 'Watson');
    await B.page.getByText('Waiting for the team lead to open the case').waitFor();
    await enterInvestigator(C.page, teamCode, 'Lestrade');
    await C.page.locator('.teamcode').waitFor();
    await A.page.getByText('Watson').first().waitFor({ timeout: 8000 });
    await A.page.getByText('Lestrade').first().waitFor({ timeout: 8000 });
    await A.page.screenshot({ path: join(shots, '04-lobby-head.png') });

    // ---------- start: everyone moves into phase 1, SQL console is the main tool
    await A.page.getByRole('button', { name: 'Start investigation' }).click();
    for (const p of [A, B, C]) await p.page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor({ timeout: 10000 });
    for (const p of [A, B, C]) await dismissIntro(p.page);
    await A.page.getByRole('heading', { name: 'SQL console' }).waitFor();
    assert.equal(await A.page.getByRole('tab', { name: 'Evidence browser' }).count(), 0, 'the SQL track keeps the SQL console as its tool');
    await A.page.locator('.thread-title', { hasText: S.def.threads[0].title }).first().waitFor();
    await A.page.screenshot({ path: join(shots, '06-phase1-head.png'), fullPage: true });

    // the console works: run a real query
    await A.page.getByRole('textbox', { name: 'SQL query' }).fill(S.def.threads[0].questions[0].sql);
    await A.page.getByRole('button', { name: /Run query/ }).click();
    await A.page.locator('.output .out-title.ok').waitFor({ timeout: 15000 });

    // ---------- threads: head hands the first thread to Watson, who sees it; hints are shared and cost 2 points
    const t1 = A.page.locator('section.thread', { hasText: S.def.threads[0].title });
    await t1.getByLabel(/Assign thread/).selectOption({ label: 'Watson' });
    await B.page.locator('section.thread', { hasText: S.def.threads[0].title }).getByText('Assigned to').waitFor({ timeout: 8000 });
    // Watson reveals a hint; the head's screen shows the same hint without a reload
    const bCard = B.page.locator('article.task').filter({ hasText: questionsOf(S)[0].prompt });
    await bCard.getByRole('button', { name: /Reveal hint 1/ }).click();
    await bCard.locator('.hints li').first().waitFor();
    await A.page.locator('article.task').filter({ hasText: questionsOf(S)[0].prompt }).locator('.hints li').first().waitFor({ timeout: 8000 });
    assert.match(await bCard.locator('.hints li').first().textContent(), new RegExp(S.tasks[0].hints[0].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // the first question now pays 8; Watson answers it
    const card1 = await answerInUi(B.page, S, 0);
    assert.match(await card1.textContent(), /Correct! \+8 points/);
    await A.page.screenshot({ path: join(shots, '08-hint-and-verified.png'), fullPage: true });

    // a wrong answer is rejected with the penalty note, and the right one is accepted afterwards
    const q2 = questionsOf(S)[1];
    const c2 = A.page.locator('article.task').filter({ hasText: q2.prompt });
    await c2.locator('.answer').fill(S.tasks[1].answer_type === 'NUMBER' ? '9999' : '03:33');
    await c2.getByRole('button', { name: 'Submit answer' }).click();
    await c2.getByText(/Not quite/).waitFor();
    await answerInUi(A.page, S, 1);

    // thread complete: outcome text appears and the phase advances for everybody; the optional thread opens up
    for (const p of [A, B, C]) await p.page.locator('.phase-no', { hasText: 'Phase 2 of 3' }).waitFor({ timeout: 12000 });
    await A.page.locator('.thread-outcome', { hasText: S.def.threads[0].outcomeText }).first().waitFor();
    await A.page.locator('.thread .pill', { hasText: 'Optional' }).first().waitFor();
    await A.page.screenshot({ path: join(shots, '09-phase2-head.png') });

    // ---------- the rest of the case, played by rotating teammates
    const pages = [A, B, C];
    for (let i = 2; i < S.tasks.length; i++) {
      const who = pages[i % 3].page;
      await answerInUi(who, S, i);
      // the phase labels follow on every screen without a reload
    }
    for (const p of pages) await p.page.getByRole('heading', { name: 'The final deduction' }).waitFor({ timeout: 15000 });
    await A.page.getByRole('tab', { name: /Evidence board/ }).click();
    await A.page.getByText('The story so far').waitFor();
    assert.ok((await A.page.locator('.note').count()) >= 8, 'evidence notes pinned for answered questions');
    await A.page.screenshot({ path: join(shots, '10-evidence-board.png'), fullPage: true });

    // ---------- final deduction: wrong accusation costs 2, retry works, then the explanation
    await A.page.screenshot({ path: join(shots, '11-final-deduction.png'), fullPage: true });
    const wrongName = S.def.rosterNames.find((n) => n !== culpritName);
    await A.page.locator('.suspect-grid').getByRole('radio', { name: new RegExp(wrongName) }).click();
    await A.page.getByRole('button', { name: new RegExp(`Accuse ${wrongName}`) }).click();
    const dlg = A.page.getByRole('dialog');
    await dlg.getByText('A wrong answer costs 2 points.').waitFor();
    await dlg.getByRole('button', { name: 'Submit', exact: true }).click();
    await A.page.getByText(/That's not it/).waitFor({ timeout: 10000 });
    await A.page.locator('.suspect-grid').getByRole('radio', { name: new RegExp(culpritName) }).click();
    await A.page.getByRole('button', { name: new RegExp(`Accuse ${culpritName}`) }).click();
    await A.page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();
    await A.page.getByText('Responsibility established.').waitFor({ timeout: 10000 });
    assert.equal(await A.page.getByRole('heading', { name: 'Case solved' }).count(), 0, 'one part is not enough to close the case');
    // teammates see the resolved part live
    await B.page.getByText('Responsibility established.').waitFor({ timeout: 12000 });

    const correct = S.def.finalOptions.find((o) => o.correct).label;
    await C.page.locator('.option-list').getByRole('radio', { name: correct }).click();
    await C.page.getByRole('button', { name: 'Submit explanation' }).click();
    await C.page.getByRole('dialog').getByRole('button', { name: 'Submit', exact: true }).click();

    // ---------- resolution on every screen: 100 - 2 (hint) - 2 (wrong answer, made after 8 points were earned) - 2 (wrong accusation) = 94
    for (const p of pages) await p.page.getByRole('heading', { name: 'Case solved' }).waitFor({ timeout: 15000 });
    for (const h of ['Responsible', 'Motive', 'Method', 'Evidence chain']) await A.page.getByRole('heading', { name: h }).waitFor();
    assert.match(await A.page.locator(".result-stats").textContent(), /94/);
    await A.page.waitForTimeout(1300);
    await A.page.screenshot({ path: join(shots, '13-case-solved.png'), fullPage: true });

    // ---------- leaderboard (public): the SQL tab lists the team, the Logic tab does not
    const anon = await browser.newContext(ctxOpts());
    const lb = await anon.newPage();
    watch(lb, problems);
    await lb.goto(`${BASE}/leaderboard`);
    await lb.getByRole('heading', { name: 'The Investigation Board' }).waitFor();
    const row = lb.locator('tr', { hasText: 'E2E Baker Street Irregulars' }).first();
    await row.waitFor({ timeout: 8000 });
    assert.match(await row.textContent(), /94/);
    assert.match(await row.textContent(), /Finished/);
    assert.ok(!(await lb.content()).includes(teamCode.replace('-', '')), 'team code is not on the public leaderboard');
    await lb.getByRole('tab', { name: 'Logic track' }).click();
    await lb.waitForTimeout(600);
    assert.equal(await lb.locator('tr', { hasText: 'E2E Baker Street Irregulars' }).count(), 0, 'tracks are separate boards');
    await lb.screenshot({ path: join(shots, '14-leaderboard.png') });
    await anon.close();

    // ---------- leave and rejoin: the head needs the case password, state is restored
    await A.page.getByRole('button', { name: 'Leave' }).click();
    await A.page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
    await A.page.getByRole('tab', { name: 'Join Investigation' }).click();
    await A.page.getByLabel('Team code').fill(teamCode);
    await A.page.getByLabel('Your codename').fill('sherlock');
    await A.page.getByRole('button', { name: 'Enter the briefing room' }).click();
    await A.page.getByRole('alert').filter({ hasText: 'not recognized' }).waitFor();
    await A.page.getByLabel(/Case password/).fill(S.password);
    await A.page.getByRole('button', { name: 'Enter the briefing room' }).click();
    await A.page.getByRole('heading', { name: 'Case solved' }).waitFor({ timeout: 12000 });
  } finally {
    await A.ctx.close();
    await B.ctx.close();
    await C.ctx.close();
  }
  assert.deepEqual(problems, [], 'no page errors, console errors or 5xx responses during the whole game');
});

test('UI (Logic track): the Evidence Browser searches, filters, sorts and pages; the SQL console is optional; thread unlocks open tables', { skip, timeout: 200000 }, async () => {
  const problems = [];
  const ctx = await browser.newContext(ctxOpts());
  const page = await ctx.newPage();
  watch(page, problems);
  const reg = await L.register({ teamRef: 'E2E Logic Lions', size: 1 });
  const names = Object.fromEntries(L.def.tables.map((t) => [t.name.replace(/^[a-z]+_/, ''), t.name]));
  try {
    await enterHead(page, L, reg, 'Asha');
    await page.locator('.teamcode').waitFor();
    await page.getByText('Logic investigation').waitFor();
    await page.getByRole('button', { name: 'Start investigation' }).click();
    await page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor({ timeout: 10000 });
    await dismissIntro(page);

    // the browser is the default tool; the console is labelled optional
    await page.getByRole('heading', { name: 'Evidence Browser' }).waitFor();
    await page.getByRole('tab', { name: 'SQL console (optional)' }).waitFor();
    const select = page.getByLabel('Evidence table', { exact: true });
    await page.waitForFunction(() => (document.querySelector('select[aria-label="Evidence table"]')?.options.length ?? 0) >= 2, null, { timeout: 15000 });
    assert.deepEqual((await select.locator('option').allTextContents()).sort(), [names.people, names.sightings].sort(), 'only the unlocked tables are listed');
    await select.selectOption(names.sightings);
    await page.locator('.results tbody tr').first().waitFor({ timeout: 10000 });
    const total = await page.locator('.result-foot').first().textContent();
    assert.match(total, /\d+ records/);
    await page.screenshot({ path: join(shots, 'l1-browser.png'), fullPage: true });

    // search
    await page.getByLabel('Search the evidence').fill('CCTV');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.results tbody tr')].every((r) => /cctv/i.test(r.textContent)) && document.querySelectorAll('.results tbody tr').length > 0);
    await page.getByLabel('Search the evidence').fill('');
    await page.getByRole('button', { name: 'Search' }).click();
    // filter + sort
    await page.getByRole('button', { name: '+ Add filter' }).click();
    await page.getByLabel('Filter column').selectOption('source');
    await page.getByLabel('Filter value').fill('BADGE');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.results tbody tr')].every((r) => /BADGE/.test(r.textContent)) && document.querySelectorAll('.results tbody tr').length > 0);
    await page.getByRole('button', { name: /^seen_at/ }).click();
    await page.getByRole('columnheader', { name: /seen_at/ }).waitFor();
    assert.equal(await page.getByRole('columnheader', { name: /seen_at/ }).getAttribute('aria-sort'), 'ascending');
    // pagination on the unfiltered people table
    await select.selectOption(names.people);
    await page.locator('.results tbody tr').first().waitFor();
    assert.match(await page.locator('.result-foot').textContent(), /Page 1 of 1/);

    // the locked statements table appears only after the first thread is finished
    assert.equal(await select.locator(`option[value="${names.statements}"]`).count(), 0);
    await page.getByRole('tab', { name: 'SQL console (optional)' }).click();
    await page.getByRole('textbox', { name: 'SQL query' }).fill(`select count(*) from ${names.sightings}`);
    await page.getByRole('button', { name: /Run query/ }).click();
    await page.locator('.output .out-title.ok').waitFor({ timeout: 15000 });
    await page.getByRole('tab', { name: 'Evidence browser' }).click();

    await answerInUi(page, L, 0);
    await answerInUi(page, L, 1);
    await page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor();
    await select.locator(`option[value="${names.statements}"]`).waitFor({ state: 'attached', timeout: 12000 });
    await page.screenshot({ path: join(shots, 'l2-unlocked.png'), fullPage: true });
  } finally {
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

test('UI (phone): join, lobby, threads, browser and final deduction work on a 390px screen with no horizontal overflow', { skip, timeout: 150000 }, async () => {
  const problems = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctx = await browser.newContext(ctxOpts(phone));
  const page = await ctx.newPage();
  watch(page, problems);
  const reg = await L.register({ teamRef: 'E2E Mobile Mo', size: 1 });
  try {
    await page.goto(BASE);
    await page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
    await noOverflow(page, 'landing');
    await page.screenshot({ path: join(shots, 'm1-landing.png'), fullPage: true });
    await enterHead(page, L, reg, 'Mobile Mo');
    await page.locator('.teamcode').waitFor();
    await noOverflow(page, 'lobby');
    await page.screenshot({ path: join(shots, 'm2-lobby.png'), fullPage: true });
    await page.getByRole('button', { name: 'Start investigation' }).click();
    await page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor({ timeout: 10000 });
    await dismissIntro(page);
    await page.waitForTimeout(2800);
    await noOverflow(page, 'phase 1');
    const y = async (sel) => (await page.locator(sel).first().boundingBox()).y;
    assert.ok((await y('.casepanel')) < (await y('.tasks')) && (await y('.tasks')) < (await y('.console')), 'stacked: case, threads, tools');
    await page.screenshot({ path: join(shots, 'm3-phase1.png'), fullPage: true });
    // the browser table scrolls inside its own container instead of widening the page
    await page.locator('.results tbody tr').first().waitFor({ timeout: 10000 });
    await noOverflow(page, 'browser results');
    await page.locator('.console').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'm4-browser.png') });
    // answer a question and reveal a hint on the phone
    const q = questionsOf(L)[0];
    const card = page.locator('article.task').filter({ hasText: q.prompt });
    await card.getByRole('button', { name: /Reveal hint 1/ }).click();
    await card.locator('.hints li').first().waitFor();
    await noOverflow(page, 'hint open');
    // a failing console query shows a friendly error, not a stack trace
    await page.getByRole('tab', { name: 'SQL console (optional)' }).click();
    await page.getByRole('textbox', { name: 'SQL query' }).fill('SELEC oops');
    await page.getByRole('button', { name: /Run query/ }).click();
    await page.getByText('QUERY FAILED').waitFor();
    assert.ok(!(await page.locator('.out-state.failed').textContent()).match(/stack|node_modules/i));
    await noOverflow(page, 'console error');
  } finally {
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

test('UI: mission control creates registrations, assigns a case, shows the team, pauses and resumes with confirmation', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1440, height: 1000 } }));
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
  let teamCtx;
  try {
    await page.goto(`${BASE}/admin`);
    await page.getByRole('heading', { name: 'Organizer sign-in' }).waitFor();
    await page.getByLabel('Admin password').fill('definitely-not-it');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').filter({ hasText: 'not accepted' }).waitFor();
    await page.getByLabel('Admin password').fill(process.env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Organizer dashboard' }).waitFor();
    await page.getByText('Game running').waitFor();
    for (const label of ['Active teams', 'Finished teams', 'Recent errors (5 min)', 'Average progress', 'Active cases']) await page.getByText(label).first().waitFor();

    // registrations: create one, assign it a case from the dropdown
    await page.getByRole('heading', { name: 'Registrations and case assignment' }).waitFor();
    await page.getByLabel(/Add teams/).fill('E2E Admin Squad, 2');
    await page.getByRole('button', { name: 'Create registrations' }).click();
    const created = page.locator('.created');
    await created.waitFor();
    const ref = (await created.locator('code').first().textContent()).trim();
    assert.match(ref, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const row = page.locator('tr', { hasText: 'E2E Admin Squad' }).first();
    await row.waitFor({ timeout: 8000 });
    await row.getByText('Not assigned').waitFor();
    await row.getByLabel(/Case for/).selectOption({ value: S.caseCode });
    await row.getByRole('button', { name: 'Assign' }).click();
    await page.getByText(new RegExp(`E2E Admin Squad assigned to ${S.caseCode}`)).waitFor();
    await page.locator('tr', { hasText: 'E2E Admin Squad' }).first().getByText(S.caseCode).first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: join(shots, '15-admin-registrations.png'), fullPage: true });

    // the head can now join with exactly those credentials, and shows up on the dashboard with track and case
    teamCtx = await browser.newContext(ctxOpts());
    const tp = await teamCtx.newPage();
    await enterHead(tp, S, { ref: ref.replace('-', '') }, 'Dash Dan');
    await tp.locator('.teamcode').waitFor();
    const trow = page.locator('tr', { hasText: 'E2E Admin Squad' }).filter({ hasText: S.caseCode }).first();
    await trow.waitFor({ timeout: 8000 });
    await page.getByRole('heading', { name: 'Audit log' }).waitFor();
    await page.getByText('case_assigned').first().waitFor();
    await page.getByRole('link', { name: 'SQL CSV' }).waitFor();

    // dangerous action needs confirmation; cancelling does nothing
    await page.getByRole('button', { name: 'Pause all' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Pause the whole game?').waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.getByText('Game running').waitFor();
    await page.getByRole('button', { name: 'Pause all' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pause all teams' }).click();
    await page.getByText('GAME PAUSED', { exact: true }).waitFor({ timeout: 8000 });
    await page.screenshot({ path: join(shots, '16-admin-paused.png') });
    await page.getByRole('button', { name: 'Resume all' }).click();
    await page.getByText('Game running').waitFor({ timeout: 8000 });
  } finally {
    await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) })
      .then(async (r) => {
        const set = r.headers.getSetCookie().find((c) => c.startsWith('slc_admin='));
        if (set) await fetch(`${BASE}/api/admin/pause`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: set.split(';')[0] }, body: JSON.stringify({ scope: 'global', paused: false }) });
      })
      .catch(() => {});
    await ctx.close();
    await teamCtx?.close();
  }
  assert.deepEqual(problems, []);
});
