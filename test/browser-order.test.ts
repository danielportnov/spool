/**
 * The order of Build, set the way a person sets it: by dragging a card up or
 * down in a real browser. Skipped where there is no Chrome.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Browser, type Locator } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

test('dragging a card up or down in Build sets the order it is built in', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 'm');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const pause = s.id('task', 'Pause button under the score', '-s', 's');
  const daily = s.id('task', 'A daily challenge level', '-s', 'xs');
  s.sp('build', jump, coins, pause);
  // The order on disk: each thread's place in line, as its file has it.
  const order = (): string[] =>
    [jump, coins, pause, daily]
      .map((id) => ({ id, place: Number(/^place: (\d+)$/m.exec(s.item(id))?.[1] ?? Infinity) }))
      .sort((a, b) => a.place - b.place)
      .map((x) => x.id);

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const column = (key: string): Locator => page.locator(`#board [data-column="${key}"]`);
  const card = (key: string, title: string): Locator => column(key).locator('.card', { hasText: title });
  const titles = async (): Promise<string[]> => column('build').locator('.card .title').allInnerTexts();

  try {
    await page.goto(url);
    await card('build', 'Tighten the jump arc').waitFor();
    assert.deepEqual(await titles(), ['Make coins readable at sunset', 'Pause button under the score', 'Tighten the jump arc']);
    assert.match(await column('build').locator('.hint').innerText(), /Built top first/);

    // Held over the top edge of the first card, the line shows above it; dropped there, the card goes first.
    const top = card('build', 'Make coins readable at sunset');
    await card('build', 'Tighten the jump arc').hover();
    await page.mouse.down();
    const box = (await top.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 4, { steps: 5 });
    await page.mouse.move(box.x + 22, box.y + 4, { steps: 2 });
    const line = column('build').locator('.landing');
    await line.waitFor();
    assert.equal(await line.evaluate((n: { nextElementSibling: { getAttribute(name: string): string } }) => n.nextElementSibling.getAttribute('data-id')), coins, 'the line sits above the card it lands before');
    await page.mouse.up();
    await until('jump is first in line', () => /^place: 1$/m.test(s.item(jump)));
    assert.equal(s.json('next').task.id, jump, 'the top card is the next one built');
    await page.waitForFunction(`document.querySelector('#board [data-column="build"] .card .title')?.textContent === 'Tighten the jump arc'`);
    assert.equal(await column('build').locator('.landing').count(), 0, 'the line is gone once dropped');

    // From the backlog, dropped between two cards: moved to build, and in that place.
    await card('proposed', 'A daily challenge level').dragTo(card('build', 'Make coins readable at sunset'), { targetPosition: { x: 20, y: 3 } });
    await until('daily is in build, second', () => s.json('show', daily).item.state === 'ready' && /^place: 2$/m.test(s.item(daily)));
    await page.waitForFunction(`document.querySelectorAll('#board [data-column="build"] .card').length === 4`);
    assert.deepEqual(await titles(), ['Tighten the jump arc', 'A daily challenge level', 'Make coins readable at sunset', 'Pause button under the score']);
    assert.deepEqual(order(), [jump, daily, coins, pause]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
