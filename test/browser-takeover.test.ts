/**
 * Taking over the backlog, in a real browser: a switch in Settings, behind the gear, live in Chat
 * mode only, that says what the chat would take next. The header has no switch of its own. Skipped
 * where there is no Chrome.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test('Take over is a switch in Settings: off headless, and in Chat mode it switches the chat on and says what it takes next', async (t) => {
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
  const settings = page.locator('#settings');
  const take = settings.getByRole('switch', { name: 'Take over the backlog' });
  const row = settings.locator('.srow', { has: page.getByRole('switch', { name: 'Take over the backlog' }) });
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    // Nothing in the header takes over: it is behind the gear.
    assert.equal(await page.locator('.bar').getByText('Take over').count(), 0);

    // Headless, there is no chat to take anything over: the switch is greyed.
    await page.locator('#gear').click();
    await settings.waitFor();
    assert.equal(await take.isDisabled(), true);
    await settings.locator('.seg button', { hasText: 'Chat' }).click();
    await until('the switch can be used', async () => !(await take.isDisabled()));

    // Switched on: the command says so, and the row says what it takes next, or why not now.
    await take.check();
    await until('it is on', () => s.json('takeover').on === true);
    await until('it says what it takes next, or why not now', async () => /(Next: Tighten the jump arc|Not now: .+)\.$/.test(await row.locator('p').innerText()));

    // Off, as on.
    await take.uncheck();
    await until('it is off', () => s.json('takeover').on === false);
    await until('it no longer says what it would take', async () => !/Next:|Not now:/.test(await row.locator('p').innerText()));
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
