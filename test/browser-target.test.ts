/**
 * The usage target in the page's header, in a real browser: shown in Chat mode only, set with its
 * slider or by typing the number, and drawn against the usage the chat last read.
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

test('in Chat mode the header holds the usage target: a slider and a number, against what is used', async (t) => {
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
  const target = (): Record<string, number> => s.json('target').target;

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const chip = page.locator('#target');
  const box = page.locator('#targets');
  const weekly = box.locator('[data-limit="weekly"]');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();

    // Headless, the page's own agents build: no target in the header.
    assert.equal(await chip.isVisible(), false);
    await page.locator('#builder button', { hasText: 'Chat' }).click();
    await chip.waitFor();
    assert.equal(await chip.innerText(), 'Usage target');
    const [runnerBox, chipBox] = [(await page.locator('#runner').boundingBox())!, (await chip.boundingBox())!];
    assert.ok(runnerBox.x + runnerBox.width <= chipBox.x, 'the target sits right of the Agents switch');

    // Opened, each limit is off until it is switched on, and then starts at 80%.
    await chip.click();
    await box.waitFor();
    assert.equal(await chip.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await box.locator('.limit .name').allInnerTexts(), ['Weekly', '5-hour', 'Fable']);
    assert.equal(await weekly.locator('input[type="range"]').isDisabled(), true);
    await weekly.locator('input[type="checkbox"]').check();
    await until('the weekly target is set', () => target().weekly === 80);

    // Typed: the number, then Enter. The slider follows it.
    await weekly.locator('input[type="number"]').fill('70');
    await weekly.locator('input[type="number"]').press('Enter');
    await until('the typed target is kept', () => target().weekly === 70);
    // A look at the board that set out before the change can draw the old number for a moment: the next one puts it right.
    await until('the slider follows the box', async () => (await weekly.locator('input[type="range"]').inputValue()) === '70');

    // Slid: the box follows the slider as it moves, and the target is what it is let go at.
    const slider = weekly.locator('input[type="range"]');
    await slider.focus();
    for (let i = 0; i < 5; i++) await slider.press('ArrowLeft');
    assert.equal(await weekly.locator('input[type="number"]').inputValue(), '65');
    await until('the slid target is kept', () => target().weekly === 65);

    // The chat reads its usage and reports it: the header shows it against the target.
    await box.locator('h3').click();
    s.sp('usage', '--weekly', '52', '--as', 'Claude Opus 5.5');
    await until('the header shows the reading', async () => (await chip.innerText()).replace(/\s+/g, ' ') === 'Weekly 52 / 65%');
    assert.match((await chip.getAttribute('title'))!, /^Weekly usage 52% of your 65% target, read .* by Claude Opus 5\.5\./);
    assert.equal(await weekly.locator('.now').innerText(), 'Used 52%, 13% to go.');
    await shot(page, 'target-open');
    s.sp('usage', '--weekly', '66', '--as', 'Claude Opus 5.5');
    await until('the header says it is reached', async () => /\breached\b/.test((await chip.getAttribute('class')) ?? ''));
    assert.equal(await weekly.locator('.now').innerText(), 'Used 66%: reached, so the chat takes no new thread.');

    // Esc puts the box away; switched off, the limit has no target.
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    await chip.click();
    await weekly.locator('input[type="checkbox"]').uncheck();
    await until('the weekly target is off', () => target().weekly === undefined);
    await until('the header says there is none', async () => (await chip.innerText()) === 'Usage target');
    // A click elsewhere puts it away too.
    await page.locator('#board').click({ position: { x: 5, y: 5 } });
    await box.waitFor({ state: 'hidden' });

    // Headless is off on the board, so the command switches back: the target goes from the header.
    assert.equal(await page.locator('#builder button', { hasText: 'Headless' }).getAttribute('aria-disabled'), 'true');
    s.sp('builder', 'headless');
    await chip.waitFor({ state: 'hidden' });
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});

test('with two agents reading their own plans, the header shows a meter each against its own target, and Settings sets each one', async (t) => {
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
  s.sp('usage', '--weekly', '66', '--as', 'Claude Opus 5.5');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const chip = page.locator('#target');
  try {
    await page.goto(url);
    await chip.waitFor();
    // One agent read: the header is as it always was.
    assert.equal(await chip.locator('.agent').count(), 0);

    // Codex reads its own plan, and has a target of its own: a meter each, Codex's past its line.
    s.sp('target', '--agent', 'Codex', '--weekly', '50');
    s.sp('usage', '--weekly', '52', '--as', 'Codex GPT-6');
    await until('a meter for each agent', async () => (await chip.locator('.agent').count()) === 2);
    assert.match(await chip.innerText(), /Claude\s*66\/80%\s*Codex\s*52\/50%/);
    assert.equal(await chip.locator('.agent.reached').innerText().then((x) => x.split(/\s/)[0]), 'Codex');
    assert.match((await chip.getAttribute('title'))!, /Codex: weekly 52% of its own 50% target, reached/);
    await shot(page, 'agent-targets-header');

    // One that cannot read its usage says so.
    s.sp('usage', '--cannot-read', '--as', 'Codex GPT-6');
    await until('Codex says it cannot read', async () => /Codex\s*can’t read/.test(await chip.innerText()));

    // Settings: each agent's own target, and empty gives it the one for all again.
    await page.locator('#gear').click();
    const codex = page.locator('#settings .count.own[data-agent="Codex"]');
    const weekly = codex.getByLabel('Codex’s own weekly target, in percent; empty for the one for all');
    assert.equal(await weekly.inputValue(), '50');
    await weekly.fill('40');
    await page.keyboard.press('Enter');
    await until('Codex is held to 40%', () => s.json('target', '--agent', 'Codex').own.weekly === 40);
    await weekly.fill('');
    await page.keyboard.press('Enter');
    await until('Codex takes the one for all', () => s.json('target', '--agent', 'Codex').own.weekly === undefined);
    assert.match(await page.locator('#settings').innerText(), /Codex cannot read its usage, so it is not held to a target\./);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
