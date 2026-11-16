/**
 * Three small oddities of the page, in a real browser: what a thread finished twice shows under its
 * conversation, the keyboard's x when the archive fails, and what an agent wrote on a card. Skipped where
 * there is no Chrome.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { type Browser } from 'playwright-core';
import { Sandbox, openChrome, startPage } from './helpers.ts';

let browser: Browser | undefined;
let stop: (() => Promise<void>) | undefined;
let url = '';
const s = new Sandbox();
s.gitInit();
fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\n');
s.sp('init', '--name', 'skyhop');
s.write('physics.txt', 'gravity 9\n');
s.commitAll('start');
s.write(path.join('.home', '.config', 'spool', 'config.json'), JSON.stringify({ checks: { [s.root]: 'true' } }));
const twice = s.id('task', 'Tighten the jump arc');
s.write('physics.txt', 'gravity 12\n');
const sha = s.commitAll(`Raise gravity\n\nSpool: ${twice}`);
s.sp('done', twice, '-m', 'First try');
s.sp('edit', twice, '--reopen');
s.sp('done', twice, '-m', 'Second try, with `gravity` and **jump**');
const first = s.id('task', 'Make coins readable at sunset');
const second = s.id('task', 'A pause menu that keeps the music');
s.sp('propose', first);
s.sp('propose', second);

before(async () => {
  try {
    browser = await openChrome();
  } catch {
    return;
  }
  ({ url, stop } = await startPage(s));
});

after(async () => {
  await browser?.close();
  await stop?.();
  s.cleanup();
});

test('a thread finished twice shows its check and commits under the last Shipped post only', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  try {
    await page.goto(`${url}?view=board`);
    await page.locator(`#board .card[data-id="${twice}"] .title`).click();
    await page.locator('#thread .feed .post .badge', { hasText: 'Shipped' }).last().waitFor();
    assert.equal(await page.locator('#thread .feed .post .badge', { hasText: 'Shipped' }).count(), 2, 'it shipped twice');
    assert.equal(await page.locator('#thread .feed', { hasText: 'Check passed' }).count(), 1);
    assert.equal(await page.locator('#thread .feed .post', { hasText: 'Check passed' }).count(), 1, 'the check is shown once');
    assert.equal(await page.locator('#thread .feed .post', { hasText: sha.slice(0, 7) }).count(), 1, 'and the commits once');
    assert.ok(await page.locator('#thread .feed .post', { hasText: 'Second try' }).filter({ hasText: 'Check passed' }).count(), 'under the last');
  } finally {
    await page.context().close();
  }
});

test('x moves the focus on only once the archive has gone through', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const focus = async (): Promise<string[]> => page.locator('.kfocus').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-id')!));
  try {
    await page.goto(`${url}?view=board`);
    await page.locator('#board [data-column="proposed"] .card').first().waitFor();
    await page.keyboard.press('j');
    const [at] = await focus();
    assert.ok(at);
    await page.route('**/api/archive', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, text: 'Not now' }) }));
    await page.keyboard.press('x');
    await page.getByText('Not now').first().waitFor();
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(await focus(), [at], 'a failed archive leaves the focus where it was');
    await page.unroute('**/api/archive');
    await page.keyboard.press('x');
    await page.locator(`#board .card[data-id="${at}"]`).waitFor({ state: 'detached' });
    const [now] = await focus();
    assert.ok(now && now !== at, 'a good one moves it on');
  } finally {
    await page.context().close();
  }
});

test('what an agent wrote on a card shows its code and bold as the brief does', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  try {
    // The board is asked for as usual, and its first backlog card carries an agent's words.
    await page.route('**/api/board', async (route) => {
      const res = await route.fetch();
      const board = await res.json();
      board.columns.proposed[0].note = 'Fixed `gravity` and **jump**';
      await route.fulfill({ response: res, json: board });
    });
    await page.goto(`${url}?view=board`);
    const note = page.locator('#board [data-column="proposed"] .card .note').first();
    await note.waitFor();
    assert.equal(await note.locator('code', { hasText: 'gravity' }).count(), 1);
    assert.equal(await note.locator('strong', { hasText: 'jump' }).count(), 1);
    assert.doesNotMatch(await note.innerText(), /\*\*|`/);
  } finally {
    await page.context().close();
  }
});
