/**
 * The status in the page's header, in a real browser: in Chat mode each agent is its logo in a ring
 * of its usage, greyed while it is not watching, and a click on it opens its own settings under it:
 * its usage target, threads at once, sizes and lean. Headless, one line says whether the page builds.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where there
 * is none. Set SPOOL_SHOTS to a folder for pictures.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('in Chat mode each agent is a logo in a ring of its usage, and a click on it sets that agent’s own target, count and sizes', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  // A git project, so each agent can have threads of its own side by side.
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.commitAll('start');
  s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('target', '--weekly', '80');

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const claude = page.locator('#status .agentchip[data-agent="Claude"]');
  const codex = page.locator('#status .agentchip[data-agent="Codex"]');
  const box = page.locator('#agentbox');
  const weekly = box.locator('[data-limit="weekly"]');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();

    // Headless, the page's own agents build: one line, no logos, and a click opens Settings where it is switched.
    assert.equal(await page.locator('#runner').innerText(), 'Agents: off');
    assert.equal(await claude.count(), 0);
    await page.locator('#runner').click();
    await page.locator('#settings').waitFor();
    const agentsOn = page.locator('#settings').getByRole('switch', { name: 'Agents on' });
    assert.equal(await agentsOn.isVisible(), true);

    // Chat, picked in Settings: a logo each, greyed while it is not watching, with no text label.
    await page.locator('#settings .seg button', { hasText: 'Chat' }).click();
    await claude.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await agentsOn.count(), 0, 'Settings is closed');
    assert.equal(await page.locator('#runner').count(), 0);
    assert.match((await claude.getAttribute('class'))!, /\boff\b/);
    assert.equal((await claude.innerText()).trim(), '–', 'nothing read yet: no number');
    assert.equal(await claude.locator('.mark svg').count(), 1, 'Claude’s own mark');
    assert.equal(await codex.locator('.mark svg').count(), 1, 'the ChatGPT mark for Codex');

    // Its reading: the ring fills, the number is beside it, warm once past its target.
    s.sp('usage', '--weekly', '52', '--as', 'Claude Opus 5.5');
    await until('the logo shows the reading', async () => (await claude.innerText()).trim() === '52%');
    assert.match((await claude.getAttribute('aria-label'))!, /^Claude: not watching, weekly 52% of 80%\. Opens its settings\.$/);
    assert.equal(await claude.locator('.ring .used').getAttribute('stroke-dasharray'), '52 100');
    assert.equal(await claude.locator('.ring .goal').count(), 1, 'a dot where the target is');

    // Clicked: its own settings, under it.
    await claude.click();
    await box.waitFor();
    assert.equal(await claude.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await box.locator('.limit .lname').allInnerTexts(), ['Weekly', '5-hour', 'Fable']);
    assert.equal(await weekly.locator('.now').innerText(), '52%');
    assert.equal(await weekly.locator('input').getAttribute('placeholder'), '80', 'empty, it takes the target for all');
    const [chipBox, boxBox] = [(await claude.boundingBox())!, (await box.boundingBox())!];
    assert.ok(boxBox.y >= chipBox.y + chipBox.height, 'the box is under its logo');
    assert.ok(boxBox.x + boxBox.width <= 1440, 'and inside the page');
    await shot(page, 'agent-box');

    // Its own weekly target, typed: the logo is measured against it.
    await weekly.locator('input').fill('60');
    await weekly.locator('input').press('Enter');
    await until('Claude is held to 60%', () => s.json('target', '--agent', 'Claude').own.weekly === 60);
    await until('the ring’s aria says so', async () => /weekly 52% of 60%/.test((await claude.getAttribute('aria-label'))!));
    // Fable is Claude's alone: its box is the target for all.
    await box.locator('[data-limit="fable"] input').fill('30');
    await box.locator('[data-limit="fable"] input').press('Enter');
    await until('the Fable target is set', () => s.json('target').target.fable === 30);

    // Threads at once and sizes, here as in Settings.
    const had = Number(await box.locator('.count .n').innerText());
    await box.getByRole('button', { name: 'One thread more for Claude' }).click();
    await until('Claude builds one more at once', async () => Number(await box.locator('.count .n').innerText()) === had + 1);
    await box.getByLabel('Largest size Claude takes').selectOption('m');
    const claudeIs = () => s.json('builder').agents.find((a: { name: string }) => a.name === 'Claude');
    await until('the command says so too', () => claudeIs().atOnce === had + 1);
    await until('Claude takes up to M', () => claudeIs().sizes[1] === 'm');

    // Esc puts it away and gives the logo the focus back; a click elsewhere does too.
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate('document.activeElement && document.activeElement.getAttribute("data-agent")'), 'Claude');
    await codex.click();
    await box.waitFor();
    // Codex has no Fable; it cannot read its usage yet, and says so without a number.
    assert.deepEqual(await box.locator('.limit .lname').allInnerTexts(), ['Weekly', '5-hour']);
    s.sp('usage', '--cannot-read', '--as', 'Codex GPT-6');
    await until('Codex says it cannot read', async () => /can’t read its usage/.test((await codex.getAttribute('aria-label'))!));
    assert.equal((await codex.innerText()).trim(), '–');
    await until('its box says so', async () => (await weekly.locator('.now').innerText()) === 'can’t read');
    await page.locator('#board').click({ position: { x: 5, y: 5 } });
    await box.waitFor({ state: 'hidden' });

    // A time to work is a short line after the logos, and opens Settings at Usage.
    s.sp('for', '2h');
    const clock = page.locator('#status .clockchip');
    await clock.waitFor();
    await clock.click();
    await page.locator('#settings').waitFor();
    assert.ok(await page.locator('#settings [data-section="usage"]').evaluate((n) => {
      const panel = n.closest('#settings')!.getBoundingClientRect();
      const r = n.getBoundingClientRect();
      return r.top >= panel.top && r.top < panel.top + 200;
    }), 'Settings opens at Usage');
    await page.keyboard.press('Escape');

    // The palette opens an agent's settings by name.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.keyboard.type('Open Codex');
    await page.keyboard.press('Enter');
    await box.waitFor();
    assert.equal(await box.getAttribute('aria-label'), 'Codex’s settings');
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});

test('the header is one tidy line at 1440px with two meters and a time set, and two short rows on a phone', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.id('task', 'Tighten the jump arc', '-s', 's');
  s.exec(['builder', 'chat'], { tty: true });
  s.sp('target', '--weekly', '80');
  s.sp('target', '--five-hour', '90');
  s.sp('usage', '--weekly', '46', '--five-hour', '30', '--as', 'Claude Opus 5.5');
  s.sp('target', '--agent', 'Codex', '--weekly', '50');
  s.sp('usage', '--weekly', '22', '--as', 'Codex GPT-6');
  s.sp('for', '3h');
  const { url, stop } = await startPage(s);
  // Every control in the bar that is shown: none past the edge, and the rows they sit on.
  interface Rows { out: { id: string; left: number; right: number; mid: number }[]; mids: number[]; wide: number; view: number; deciders: number }
  const rows = (page: Page): Promise<Rows> => page.evaluate(`(() => {
    const bar = document.querySelector('.bar');
    const shown = [...bar.querySelectorAll('.brand, .tab, #search, #searchbtn, .agentchip, .clockchip, #notifier, #gear, #themer')]
      .filter((n) => n.offsetParent !== null && getComputedStyle(n).display !== 'none');
    const out = shown.map((n) => { const r = n.getBoundingClientRect(); return { id: n.id || n.className, left: r.left, right: r.right, mid: Math.round(r.top + r.height / 2) }; });
    return { out, mids: [...new Set(out.map((o) => o.mid))], wide: document.documentElement.scrollWidth, view: innerWidth, deciders: bar.querySelectorAll('#builder, #roster, #target, #takeover').length };
  })()`);
  try {
    for (const [name, width, most] of [['desktop', 1440, 1], ['phone', 390, 2]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.goto(url);
      await page.locator('#status .agentchip').nth(1).waitFor();
      await page.locator('#status .clockchip').waitFor();
      const r = await rows(page);
      assert.equal(r.deciders, 0, `${name}: no decider is left in the header`);
      assert.ok(r.wide <= r.view, `${name}: nothing runs off the edge (${r.wide} > ${r.view})`);
      for (const o of r.out) assert.ok(o.right <= width && o.left >= 0, `${name}: ${o.id} is inside the page`);
      // Within a few pixels a row: a tab and a button are not the same height.
      const lines = r.mids.sort((a, z) => a - z).reduce<number[]>((acc, m) => (acc.length && m - acc[acc.length - 1] < 12 ? acc : [...acc, m]), []);
      assert.ok(lines.length <= most, `${name}: the header is ${lines.length} rows, at most ${most}`);
      for (const id of ['#gear', '#notifier']) assert.equal(await page.locator(id).isVisible(), true, `${name}: ${id} shows`);
      await shot(page, `header-${name}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
