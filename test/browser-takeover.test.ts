/**
 * Taking over the backlog, in the page's header, in a real browser: a switch shown in Chat mode
 * only, that opens a menu of its settings. Skipped where there is no Chrome.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test('in Chat mode the header has a Take over switch, and its menu switches it and shows what it works up to and takes', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.id('task', 'Tighten the jump arc', '-s', 's');
  s.exec(['target', '--weekly', '80'], { tty: true });
  s.sp('usage', '--weekly', '30');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const chip = page.locator('#takeover');
  const menu = page.locator('#takeovers');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    // Headless, there is no chat to take anything over.
    assert.equal(await chip.isVisible(), false);
    await page.locator('#builder button', { hasText: 'Chat' }).click();
    await chip.waitFor();
    assert.equal(await chip.getAttribute('class'), 'takeover');
    const [targetBox, chipBox] = [(await page.locator('#target').boundingBox())!, (await chip.boundingBox())!];
    assert.ok(targetBox.x + targetBox.width <= chipBox.x, 'it sits beside the usage target');

    // Clicked, it opens its menu; switched on there, the command says so and the header follows.
    await chip.click();
    await menu.waitFor();
    assert.match(await menu.locator('.usage .goal').innerText(), /Weekly 30 of 80%/);
    await menu.locator('.switch input').check();
    await until('it is on', () => s.json('takeover').on === true);
    await until('the header shows it on', async () => (await chip.getAttribute('class')) === 'takeover on');
    // What it would do now: the page keeps the real clock, so the sandbox's reading may count as old.
    await until('it says what it takes next, or why not now', async () => /^(Next: Tighten the jump arc|Not now: .+)$/.test(await menu.locator('.takes .now').innerText()));

    // Closed and clicked again, with it on, the menu opens again; Change goes to the usage target.
    await page.locator('#takeovers .shut').click();
    assert.equal(await menu.isVisible(), false);
    await chip.click();
    await menu.waitFor();
    await menu.locator('button.link', { hasText: 'Change' }).click();
    await page.locator('#targets').waitFor();
    assert.equal(await menu.isVisible(), false);

    // Off from the menu, as on.
    await chip.click();
    await menu.locator('.switch input').uncheck();
    await until('it is off', () => s.json('takeover').on === false);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
