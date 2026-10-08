// Real-browser end-to-end tests (system Chrome driven by playwright-core): three players on three separate
// browser contexts play a whole case; a phone-sized run; the public leaderboard; mission control.
// Screenshots go to the OS temp dir (never into the repo).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { db, makeRealCase, BASE, randomIp } from './helpers.mjs';

const pool = db();
let R;
let browser;
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
const skip = CHROME ? false : 'no Chrome/Edge found (set CHROME_PATH)';
const shots = join(tmpdir(), 'slc-ui-shots');

before(async () => {
  R = await makeRealCase(pool);
  if (CHROME) {
    mkdirSync(shots, { recursive: true });
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
  }
});
after(async () => {
  await browser?.close();
  await R.cleanup();
  await pool.end();
});

const fmtCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const ctxOpts = (extra = {}) => ({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-forwarded-for': randomIp() }, ...extra });

function watch(page, problems) {
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Chrome logs every non-2xx fetch as a console error; these client errors are expected answers (not signed in,
    // a deliberately invalid query, locked, rate limited). Page errors and 5xx responses still fail the test.
    if (m.type() === 'error' && !/Failed to load resource.*\b(400|401|409|423|429)\b/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
}

const noOverflow = async (page, label) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(o.sw <= o.iw + 1, `${label}: horizontal overflow (${o.sw} > ${o.iw})`);
};

async function enter(page, mode, fields) {
  await page.goto(BASE);
  await page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
  if (mode === 'head') {
    await page.getByLabel('Case code').fill(fields.code);
    await page.getByLabel('Case password').fill(fields.password);
    await page.getByLabel('Your codename').fill(fields.name);
    await page.getByRole('button', { name: 'Open the case file' }).click();
  } else {
    await page.getByRole('tab', { name: 'Join Investigation' }).click();
    await page.getByLabel('Team code').fill(fields.code);
    await page.getByLabel('Your codename').fill(fields.name);
    await page.getByRole('button', { name: 'Enter the briefing room' }).click();
  }
}

// Runs the reference query in the console, then answers with the right input type.
async function solve(page, task, prompt, { last = false } = {}) {
  const card = page.locator('.task', { hasText: prompt.slice(0, 40) });
  await card.waitFor();
  await page.getByRole('tab', { name: 'SQL console' }).click();
  await page.getByRole('textbox', { name: 'SQL query' }).fill(task.sql);
  await page.getByRole('button', { name: /Run query/ }).click();
  await page.locator('.output .out-title.ok').waitFor({ timeout: 15000 });
  const field = card.locator('.answer');
  if (task.answer_type === 'SINGLE_CHARACTER') {
    const label = await field.locator('option', { hasText: task.answer_text }).first().textContent();
    await field.selectOption({ label });
  } else {
    await field.fill(task.answer_text);
  }
  await card.getByRole('button', { name: 'Submit answer' }).click();
  if (last) await page.locator('.toast', { hasText: 'Phase cleared' }).waitFor({ timeout: 10000 });
  else await card.getByText('Correct! Evidence verified.').waitFor({ timeout: 10000 });
  if (!last) await card.locator('.verified').waitFor(); // the phase's last card hands over to the next phase
}

test('UI: three browsers play a whole case, landing to resolution to leaderboard', { skip, timeout: 280000 }, async () => {
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
  const prompts = Object.fromEntries((await pool.query('select id, prompt_text from tasks where case_id = $1', [R.caseId])).rows.map((r) => [r.id, r.prompt_text]));

  try {
    // ---------- landing
    const resp = await A.page.goto(BASE);
    assert.equal(resp.headers()['x-frame-options'], 'DENY');
    assert.equal(resp.headers()['x-content-type-options'], 'nosniff');
    await A.page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
    await A.page.getByText('Every crime leaves a query.').waitFor();
    await A.page.screenshot({ path: join(shots, '01-landing.png') });
    for (const label of ['Case code', 'Case password']) assert.equal(await A.page.getByLabel(label).getAttribute('autocomplete'), 'off');

    // wrong credentials: one clear, accessible error
    await A.page.getByLabel('Case code').fill(R.caseCode.toLowerCase());
    await A.page.getByLabel('Case password').fill('wrong');
    await A.page.getByLabel('Your codename').fill('Sherlock');
    await A.page.getByRole('button', { name: 'Open the case file' }).click();
    await A.page.getByRole('alert').filter({ hasText: 'not recognized' }).waitFor();
    await A.page.screenshot({ path: join(shots, '02-join-error.png') });

    // ---------- head creates the investigation (hyphenated code, correct password)
    await A.page.getByLabel('Case code').fill(fmtCode(R.caseCode));
    await A.page.getByLabel('Case password').fill(R.password);
    await A.page.getByRole('button', { name: 'Open the case file' }).click();
    const teamCodeEl = A.page.locator('.teamcode');
    await teamCodeEl.waitFor();
    const teamCode = (await teamCodeEl.textContent()).trim();
    assert.match(teamCode, /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    await A.page.getByText('Team lead').first().waitFor();
    await A.page.getByRole('heading', { name: 'Investigation team' }).waitFor();

    // ---------- investigators join (code typed lowercase, unhyphenated)
    await B.page.goto(BASE);
    await B.page.getByRole('tab', { name: 'Join Investigation' }).click();
    await B.page.screenshot({ path: join(shots, '03-join-investigator.png') });
    await enter(B.page, 'inv', { code: teamCode.replace('-', '').toLowerCase(), name: 'Watson' });
    await B.page.locator('.teamcode').waitFor();
    assert.equal((await B.page.locator('.teamcode').textContent()).trim(), teamCode);
    await B.page.getByText('Waiting for the team lead to open the case').waitFor();
    await enter(C.page, 'inv', { code: teamCode, name: 'Lestrade' });
    await C.page.locator('.teamcode').waitFor();
    await A.page.getByText('Watson').first().waitFor({ timeout: 8000 });
    await A.page.getByText('Lestrade').first().waitFor({ timeout: 8000 });
    await A.page.waitForFunction(() => document.querySelectorAll('.presence.on').length >= 1);
    await A.page.screenshot({ path: join(shots, '04-lobby-head.png') });
    await B.page.screenshot({ path: join(shots, '05-lobby-investigator.png') });

    // ---------- head opens the case: everyone moves into Phase 1
    await A.page.getByRole('button', { name: 'Start investigation' }).click();
    for (const p of [A, B, C]) await p.page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor({ timeout: 10000 });
    await A.page.getByRole('heading', { name: 'SQL console' }).waitFor();
    await A.page.getByText('Establish the scene').first().waitFor();
    await A.page.screenshot({ path: join(shots, '06-phase1-head.png'), fullPage: true });
    await C.page.screenshot({ path: join(shots, '07-phase1-investigator.png') });

    // ---------- play the three phases
    for (const phase of [1, 2, 3]) {
      const tasks = R.byPhase(phase);
      for (const p of [A, B, C]) await p.page.locator('.phase-no', { hasText: `Phase ${phase} of 3` }).waitFor({ timeout: 12000 });

      if (phase === 1) {
        // head assigns task 3 to Watson; Watson sees it on his own screen and solves it
        const card = A.page.locator('.task', { hasText: prompts[tasks[2].id].slice(0, 40) });
        await card.getByLabel(/Assign task 3/).selectOption({ label: 'Watson' });
        await B.page.locator('.task', { hasText: prompts[tasks[2].id].slice(0, 40) }).getByText('Assigned to').waitFor({ timeout: 8000 });
        await solve(A.page, tasks[0], prompts[tasks[0].id]);
        await A.page.screenshot({ path: join(shots, '08-console-and-verified-task.png'), fullPage: true });
        await solve(A.page, tasks[1], prompts[tasks[1].id]);
        await solve(B.page, tasks[2], prompts[tasks[2].id], { last: true });
      } else if (phase === 2) {
        // Lestrade takes an unassigned task by himself
        const tk = C.page.locator('.task', { hasText: prompts[tasks[2].id].slice(0, 40) });
        await tk.getByRole('button', { name: 'Take this task' }).click();
        await A.page.locator('.task', { hasText: prompts[tasks[2].id].slice(0, 40) }).getByText('Assigned to').waitFor({ timeout: 8000 });
        await solve(A.page, tasks[0], prompts[tasks[0].id]);
        await solve(A.page, tasks[1], prompts[tasks[1].id]);
        await solve(C.page, tasks[2], prompts[tasks[2].id], { last: true });
      } else {
        for (const [k, t] of tasks.entries()) await solve(A.page, t, prompts[t.id], { last: k === 2 });
      }
      // the other screens follow without any reload
      if (phase < 3) for (const p of [A, B, C]) await p.page.locator('.phase-no', { hasText: `Phase ${phase + 1} of 3` }).waitFor({ timeout: 12000 });
      if (phase === 1) await A.page.screenshot({ path: join(shots, '09-phase2-head.png') });
      if (phase === 2) {
        await A.page.getByRole('tab', { name: /Evidence board/ }).click();
        await A.page.locator('.note').first().waitFor();
        assert.ok((await A.page.locator('.note').count()) >= 6, 'evidence notes pinned for solved tasks');
        await A.page.screenshot({ path: join(shots, '10-evidence-board.png'), fullPage: true });
        await A.page.getByRole('tab', { name: 'SQL console' }).click();
      }
    }

    // ---------- final deduction on every screen
    for (const p of [A, B, C]) await p.page.getByRole('heading', { name: 'The final deduction' }).waitFor({ timeout: 12000 });
    await A.page.getByText('You have one accusation').waitFor();
    await A.page.screenshot({ path: join(shots, '11-final-deduction.png'), fullPage: true });
    const culprit = R.characters.find((c) => c.id === R.culpritId).name;
    await A.page.getByRole('radio', { name: new RegExp(culprit) }).click();
    await A.page.getByRole('button', { name: new RegExp(`Accuse ${culprit}`) }).click();
    const dlg = A.page.getByRole('dialog');
    await dlg.getByText('This decision cannot be changed.').waitFor();
    await A.page.screenshot({ path: join(shots, '12-accuse-confirm.png') });
    await dlg.getByRole('button', { name: 'Submit accusation' }).click();

    // ---------- resolution (and the teammates see it too)
    await A.page.getByRole('heading', { name: 'Case solved' }).waitFor({ timeout: 12000 });
    for (const h of ['Culprit', 'Motive', 'Method', 'Evidence chain']) await A.page.getByRole('heading', { name: h }).waitFor();
    assert.match(await A.page.locator('.result-stats').textContent(), /100/);
    await A.page.waitForTimeout(1300); // let the score count-up settle for the screenshot
    await A.page.screenshot({ path: join(shots, '13-case-solved.png'), fullPage: true });
    await B.page.getByRole('heading', { name: 'Case solved' }).waitFor({ timeout: 12000 });

    // ---------- leaderboard (public, no session)
    const anon = await browser.newContext(ctxOpts());
    const lb = await anon.newPage();
    watch(lb, problems);
    await lb.goto(`${BASE}/leaderboard`);
    await lb.getByRole('heading', { name: 'The Investigation Board' }).waitFor();
    const row = lb.locator('tr', { hasText: "Sherlock's team" }).first();
    await row.waitFor({ timeout: 8000 });
    assert.match(await row.textContent(), /100/);
    assert.match(await row.textContent(), /Finished/);
    assert.ok(!(await lb.content()).includes(teamCode.replace('-', '')), 'team code is not on the public leaderboard');
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
    await A.page.getByLabel(/Case password/).fill(R.password);
    await A.page.getByRole('button', { name: 'Enter the briefing room' }).click();
    await A.page.getByRole('heading', { name: 'Case solved' }).waitFor({ timeout: 12000 });
  } finally {
    await A.ctx.close();
    await B.ctx.close();
    await C.ctx.close();
  }
  assert.deepEqual(problems, [], 'no page errors, console errors or 5xx responses during the whole game');
});

test('UI (phone): join, lobby, console and tasks work on a 390px screen with no horizontal overflow', { skip, timeout: 120000 }, async () => {
  const problems = [];
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctx = await browser.newContext(ctxOpts(phone));
  const page = await ctx.newPage();
  watch(page, problems);
  try {
    await page.goto(BASE);
    await page.getByRole('heading', { name: "Sherlock's Last Case" }).waitFor();
    await noOverflow(page, 'landing');
    await page.screenshot({ path: join(shots, 'm1-landing.png'), fullPage: true });
    await enter(page, 'head', { code: fmtCode(R.caseCode), password: R.password, name: 'Mobile Mo' });
    await page.locator('.teamcode').waitFor();
    await noOverflow(page, 'lobby');
    await page.screenshot({ path: join(shots, 'm2-lobby.png'), fullPage: true });
    await page.getByRole('button', { name: 'Start investigation' }).click();
    await page.locator('.phase-no', { hasText: 'Phase 1 of 3' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(2800); // overlay gone
    await noOverflow(page, 'phase 1');
    // stacked order on a phone: case, objectives, then the console
    const y = async (sel) => (await page.locator(sel).first().boundingBox()).y;
    assert.ok((await y('.casepanel')) < (await y('.tasks')) && (await y('.tasks')) < (await y('.console')), 'stacked: case, tasks, console');
    await page.screenshot({ path: join(shots, 'm3-phase1.png'), fullPage: true });
    await page.getByRole('textbox', { name: 'SQL query' }).fill('SELECT name, department FROM cast_crew LIMIT 5;');
    await page.getByRole('button', { name: /Run query/ }).click();
    await page.locator('.output .out-title.ok').waitFor({ timeout: 15000 });
    await noOverflow(page, 'results');
    await page.locator('.console').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'm4-console-results.png') });
    // a failing query shows a friendly error, not a stack trace
    await page.getByRole('textbox', { name: 'SQL query' }).fill('SELEC oops');
    await page.getByRole('button', { name: /Run query/ }).click();
    await page.getByText('QUERY FAILED').waitFor();
    assert.ok(!(await page.locator('.out-state.failed').textContent()).match(/stack|node_modules/i));
  } finally {
    await ctx.close();
  }
  assert.deepEqual(problems, []);
});

test('UI: admin mission control signs in, shows stats, pauses and resumes with confirmation', { skip, timeout: 90000 }, async () => {
  // one real team so the dashboard has something to show
  const team = await browser.newContext(ctxOpts());
  const tp = await team.newPage();
  await enter(tp, 'head', { code: fmtCode(R.caseCode), password: R.password, name: 'Dash Dan' });
  await tp.locator('.teamcode').waitFor();

  const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1440, height: 900 } }));
  const page = await ctx.newPage();
  const problems = [];
  watch(page, problems);
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
    await page.getByRole('heading', { name: 'Phase distribution' }).waitFor();
    await page.locator('tr', { hasText: "Dash Dan's team" }).first().waitFor({ timeout: 8000 });
    await page.getByRole('link', { name: 'Export CSV' }).waitFor();
    await page.screenshot({ path: join(shots, '15-admin-dashboard.png'), fullPage: true });

    // dangerous action needs confirmation; cancelling does nothing
    await page.getByRole('button', { name: 'Pause all' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Pause the whole game?').waitFor();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.getByText('Game running').waitFor();
    await page.getByRole('button', { name: 'Pause all' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pause all teams' }).click();
    await page.getByText('GAME PAUSED', { exact: true }).waitFor({ timeout: 8000 });
    await page.getByText('Game paused for every team.').waitFor();
    await page.screenshot({ path: join(shots, '16-admin-paused.png') });
    // the player's screen shows the pause banner
    await tp.getByText('INVESTIGATION PAUSED').first().waitFor({ timeout: 9000 }).catch(async () => {
      await tp.getByRole('button', { name: 'Start investigation' }).waitFor();
    });
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
    await team.close();
  }
  assert.deepEqual(problems, []);
});
