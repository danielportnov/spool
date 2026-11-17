/**
 * New activity on a card, in a real browser: a thread shows how many posts it has that you have
 * not seen, and opening it clears them. It uses the Chrome already on the machine, and is skipped
 * where there is none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test("a card says what is new on its thread since you last opened it, and opening it clears that", async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const id = s.id('task', 'Tighten the jump arc', '-s', 's');
  const other = s.id('task', 'Fix the score font', '-s', 'xs');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const mark = (of: string) => page.locator(`.card[data-id="${of}"] .new`);
  try {
    await page.goto(url);
    await page.locator(`.card[data-id="${id}"]`).waitFor();
    // A board met for the first time is all read: nothing is lit up.
    assert.equal(await page.locator('.card .new').count(), 0);

    s.sp('log', id, 'The jump is shorter now.', '--as', 'Claude');
    s.sp('log', id, 'Tried it on a phone: it feels right.', '--as', 'Claude');
    await until('two new on the thread', async () => (await mark(id).count()) === 1 && (await mark(id).innerText()) === '2 new');
    assert.match((await mark(id).getAttribute('title'))!, /Latest: Claude: Tried it on a phone/);
    assert.equal(await mark(other).count(), 0, 'nothing new on the other');

    // What you do yourself is not news to you.
    s.sp('log', other, 'a note of mine', '--as', 'human');
    await page.reload();
    await mark(id).waitFor();
    assert.equal(await mark(other).count(), 0);

    // Opening the thread reads it; the mark is gone once it is closed, and after a reload.
    await page.locator(`.card[data-id="${id}"] .title`).click();
    await page.locator('#thread').waitFor();
    await page.keyboard.press('Escape');
    await until('the mark is gone', async () => (await mark(id).count()) === 0);
    await page.reload();
    await page.locator(`.card[data-id="${id}"]`).waitFor();
    assert.equal(await mark(id).count(), 0);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await browser.close();
    await stop();
    s.cleanup();
  }
});
