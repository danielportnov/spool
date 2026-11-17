/**
 * The bell on the board, in a real browser: what notifies the human, each event on or off, and how
 * it is sent. It uses the Chrome already on the machine, and is skipped where there is none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test('the bell picks what notifies him: one click an event, kept for every project', async (t) => {
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
  const on = (): string[] => s.json('notify').on;
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const bell = page.locator('#notifier');
  const box = page.locator('#notices');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    // It sits by the gear and the theme, right of what says who builds.
    const [themer, bellBox, runner] = [(await page.locator('#themer').boundingBox())!, (await bell.boundingBox())!, (await page.locator('#runner').boundingBox())!];
    assert.ok(runner.x + runner.width <= bellBox.x && bellBox.x + bellBox.width <= themer.x, 'the bell is between the status and the theme');
    assert.match((await bell.getAttribute('title'))!, /^Notifications: a question is asked, build is empty, an agent is stuck or refused, a run stops at its usage target\./);

    await bell.click();
    await box.waitFor();
    const picked = async (): Promise<string[]> => box.locator('input:checked').evaluateAll((all) => all.map((i) => (i as unknown as { dataset: Record<string, string> }).dataset.event!));
    assert.deepEqual(await picked(), ['question', 'empty', 'stuck', 'budget']);
    await box.locator('input[data-event="started"]').check();
    await until('started is kept', () => on().includes('started'));
    for (const quiet of ['empty', 'stuck', 'budget']) await box.locator(`input[data-event="${quiet}"]`).uncheck();
    await until('only started and question', () => on().join() === 'started,question');
    // Headless with no notifier, it says nothing is sent; in Chat mode, the chat sends them.
    assert.match(await box.locator('.via').innerText(), /no notifier is set/);
    // A click anywhere else puts the box away.
    await page.locator('#board').click({ position: { x: 5, y: 5 } });
    assert.equal(await box.isVisible(), false);
    s.sp('builder', 'chat');
    await page.locator('#status .agentchip').first().waitFor();
    await bell.click();
    await until('the box says the chat sends them', async () => /a Claude notification/.test(await box.locator('.via').innerText()));
    // Defaults puts it back, and the box follows.
    await box.locator('.reset').click();
    await until('back to the defaults', () => s.json('notify').default === true);
    await until('the box shows the defaults', async () => (await picked()).join() === 'question,empty,stuck,budget');
    await page.keyboard.press('Escape');
    assert.equal(await box.isVisible(), false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await browser.close();
    await stop();
    s.cleanup();
  }
});
