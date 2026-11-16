/**
 * What a finished thread changed, read on its ticket the way a pull request is read: files in a
 * list, numbered and coloured lines, each file folding open and shut.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where
 * there is none. Set SPOOL_SHOTS to a folder for pictures, light and dark.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { Sandbox, openChrome, startPage } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('a change reads like a pull request: rows, counts, folds, numbered and coloured lines', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  t.after(() => browser.close());

  const s = new Sandbox();
  s.gitInit();
  const body = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`);
  s.write('src/engine.ts', `${body.join('\n')}\n`);
  s.write('old/legacy.txt', 'the old way\nof doing it\n');
  s.commitAll('init');
  s.sp('init', '--name', 'skyhop', '--gate');
  s.commitAll('set up spool');
  const id = s.id('task', 'Rework the engine');
  s.sp('build', id);
  s.sp('start', id);
  // Two hunks in one file, far enough apart not to join; a long line with a tab; a new file; a deleted one.
  const changed = [...body];
  changed[2] = `line 3, now longer\twith a tab and a very long tail ${'that goes on and on '.repeat(14)}`;
  changed[20] = 'line 21 changed';
  s.write('src/engine.ts', `${changed.join('\n')}\n`);
  s.write('src/new.ts', 'export const answer = 42;\n');
  s.commitAll(`Rework the engine\n\nSpool: ${id}`);
  fs.rmSync(path.join(s.root, 'old/legacy.txt'));
  s.commitAll(`Drop the legacy file\n\nSpool: ${id}`);
  s.sp('done', id, '-m', 'Reworked');

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  try {
    await page.goto(`${url}#${id}`);
    const ticket = page.locator('#thread');
    await ticket.getByRole('button', { name: 'Show what changed' }).click();
    const rows = ticket.locator('.changes .file');
    await rows.first().waitFor();

    assert.equal(await rows.count(), 3);
    assert.match(await ticket.locator('.changes .sum').innerText(), /3 files changed\s+\+3\s+−4/);
    assert.equal(await ticket.locator('.changes .commits > div').count(), 2);
    const row = (name: string) => rows.filter({ hasText: name });
    // Small: every file starts open. The folder part is its own muted span.
    assert.equal(await ticket.locator('.changes .file.open').count(), 3);
    assert.equal(await row('engine.ts').locator('.dir').innerText(), 'src/');
    assert.equal(await row('new.ts').locator('.word').innerText(), 'new');
    assert.equal(await row('legacy.txt').locator('.word').innerText(), 'deleted');
    assert.match(await row('engine.ts').locator('.filehead').innerText(), /\+2\s+−2/);
    assert.equal(await row('engine.ts').locator('.stat i').count(), 5);
    assert.equal(await row('engine.ts').locator('tr.at').count(), 2, 'two hunks, two separators');

    // Numbered, and coloured by kind: the added line is new line 3 and the removed one old line 3.
    const added = row('engine.ts').locator('tr.plus').first();
    assert.equal(await added.locator('td.num').nth(1).innerText(), '3');
    const removed = row('engine.ts').locator('tr.minus').first();
    assert.equal(await removed.locator('td.num').nth(0).innerText(), '3');
    assert.match(await added.locator('td.code').textContent() ?? '', /now longer\twith a tab/);
    const ground = (loc: typeof added) => loc.evaluate((n) => (globalThis as any).getComputedStyle(n).backgroundColor as string);
    assert.notEqual(await ground(added), await ground(removed));
    assert.notEqual(await ground(added), 'rgba(0, 0, 0, 0)');

    // A long line scrolls inside its file's box, not the ticket.
    const box = row('engine.ts').locator('.scroll');
    assert.ok(await box.evaluate((n) => n.scrollWidth > n.clientWidth));
    assert.ok(await ticket.evaluate((n) => n.scrollWidth <= n.clientWidth));
    await box.evaluate((n) => (n.scrollLeft = 120));

    await shot(page, 'diff-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'diff-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Fold one shut; it stays shut and the scrolled box stays scrolled while the page redraws.
    await row('new.ts').locator('.filehead').click();
    assert.equal(await row('new.ts').locator('tr.plus').count(), 0);
    assert.equal(await ticket.locator('.changes .file.open').count(), 2);
    await page.waitForTimeout(2500);
    assert.equal(await row('new.ts').locator('tr.plus').count(), 0, 'folded state survives the redraws');
    assert.equal(await box.evaluate((n) => n.scrollLeft), 120, 'the scroll position survives them too');
    await row('new.ts').locator('.filehead').click();
    assert.equal(await row('new.ts').locator('tr.plus').count(), 1);
    assert.equal(await row('legacy.txt').locator('tr.minus').count(), 2);
    assert.deepEqual(problems, []);
  } finally {
    await stop();
    await page.close();
  }
});
