/**
 * Settings, in a real browser: a gear in the header opens one panel with every setting, each
 * changed there showing the same in its command, and a command's change showing there. Skipped
 * where there is no Chrome.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test('the gear opens Settings, and each setting changed there is what its command says', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  // A git project, so each agent can have threads of its own side by side.
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.commitAll('start');
  s.id('task', 'Tighten the jump arc', '-s', 's');
  s.exec(['builder', 'chat'], { tty: true });
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const panel = page.locator('#settings');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    await page.locator('#gear').click();
    await panel.waitFor();
    assert.deepEqual(await panel.locator('h3').allInnerTexts(), ['BUILDING', 'USAGE', 'NOTIFICATIONS', 'REPLIES & STYLE']);
    // Each row says the command that does the same.
    assert.ok((await panel.locator('.cmd').allInnerTexts()).includes('spool caveman on'));

    // Headless is greyed until it is offered; offered here, the header's pick can be clicked.
    const headless = page.locator('#builder button[data-builder=headless]');
    assert.equal(await headless.getAttribute('aria-disabled'), 'true');
    await panel.getByRole('switch', { name: 'Offer Headless' }).click();
    await until('headless is offered', () => s.json('settings').headless === true);
    await until('the header follows', async () => (await headless.getAttribute('aria-disabled')) === 'false');

    // Switches, a count and a number, each the same as its command.
    await panel.getByRole('switch', { name: 'Caveman mode' }).click();
    await until('caveman is on', () => s.json('caveman').caveman === true);
    await panel.getByRole('switch', { name: 'Quick replies' }).click();
    await until('quick replies are off', () => s.json('settings')['quick-reply'] === false);
    await panel.getByRole('button', { name: 'One thread fewer for Codex' }).click();
    await until('Codex builds 2 at once', () => s.json('builder').agents.find((a: { name: string }) => a.name === 'Codex').atOnce === 2);
    await panel.getByLabel('Largest size Claude takes').selectOption('m');
    await until('Claude takes up to M', () => s.json('builder').agents.find((a: { name: string }) => a.name === 'Claude').sizes[1] === 'm');
    await panel.getByLabel('Minutes before an agent is quiet').fill('15');
    await page.keyboard.press('Enter');
    await until('quiet after 15 minutes', () => s.json('settings')['quiet-minutes'] === 15);
    await panel.getByRole('switch', { name: 'A thread is done' }).click();
    await until('done notifies', () => s.json('notify').on.includes('done'));
    await panel.getByRole('switch', { name: 'Weekly target' }).click();
    await until('a weekly target is set', () => s.json('target').target.weekly === 80);

    await panel.getByRole('switch', { name: 'Away from keyboard' }).click();
    await until('AFK is on', () => s.json('afk').afk === true);

    // And the other way: a command's change shows in the panel.
    s.exec(['settings', 'rebuild', 'off'], { tty: true });
    await until('the panel shows rebuild off', async () => !(await panel.getByRole('switch', { name: 'Rebuild after each landing' }).isChecked()));

    // From the palette too, and Esc closes it.
    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(), false);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.keyboard.type('Open settings');
    await page.keyboard.press('Enter');
    await panel.waitFor();
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await browser.close();
    await stop();
    s.cleanup();
  }
});
