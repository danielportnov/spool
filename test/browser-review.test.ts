/**
 * A sprint's review, driven in a real browser: opened from the Roadmap, each thread with its result,
 * its steps to tick and the calls made on it; a tick kept across a reload; and Approve the sprint.
 * Skipped where there is no Chrome. SPOOL_SHOTS=<folder> leaves a picture of it there, light and dark.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { openChrome, startPage, until } from './helpers.ts';
import { roadmapSandbox } from './roadmap-sandbox.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('a reached sprint opens its review: its threads with their steps, a tick that lasts, and one approval for it all', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const r = roadmapSandbox();
  const { s } = r;
  const show = (id: string) => s.json('show', id).item;
  const page = await startPage(s);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const problems: string[] = [];
  tab.on('pageerror', (error) => problems.push(String(error)));
  tab.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const roadmap = tab.locator('#roadmap');
  const lane = (id: string) => roadmap.locator(`.lane[data-sprint="${id}"]`);

  try {
    await tab.goto(`${page.url}?view=roadmap`);
    await roadmap.locator('.lane').first().waitFor();
    // The sprint being played offers its review so far; a planned one has nothing to review.
    await lane(r.worlds).getByRole('button', { name: 'Review so far' }).waitFor();
    assert.equal(await lane(r.later).getByRole('button', { name: /Review/ }).count(), 0);

    // The review of the reached sprint: each thread with its result and its steps to check, the call made, what was undone.
    await lane(r.polish).getByRole('button', { name: 'Review' }).click();
    const review = roadmap.locator('.review');
    await review.locator('.rthread').first().waitFor();
    const text = await review.innerText();
    assert.match(text, /Polish\nReached/i);
    assert.match(text, /Done when nothing looks placeholder\s+✓ every thread in it is done/);
    assert.match(text, /2 threads shipped(, over \d+m)? · 3 files changed/);
    assert.deepEqual(await review.locator('.rthread .rtop .title').allInnerTexts(), ['Tighten the jump arc', 'Make coins readable at sunset']);
    const jump = review.locator('.rthread', { hasText: 'Tighten the jump arc' });
    assert.deepEqual(await jump.locator('ol.ticks li').allInnerTexts(), ['Open level 1', 'Jump the first gap: you land on it']);
    assert.match(await review.locator('.rthread', { hasText: 'Make coins readable' }).innerText(), /Decided: Outline them[\s\S]*Why: teal clashes with water[\s\S]*Fine/);
    assert.match(text, /Undone or stopped along the way\nTighten the jump arc: reverted 1 commit\(s\): still floaty/i);
    assert.match(text, /It has no version yet: the loop cuts one when a sprint is reached\./);

    // A tick is his, kept in this browser: it is still there after a reload.
    await jump.getByRole('checkbox', { name: 'Open level 1' }).click();
    assert.equal(await jump.getByRole('checkbox', { name: 'Open level 1' }).getAttribute('aria-checked'), 'true');
    await shot(tab, 'review-1-wide');
    await tab.emulateMedia({ colorScheme: 'dark' });
    await shot(tab, 'review-2-wide-dark');
    await tab.emulateMedia({ colorScheme: 'light' });
    await tab.reload();
    await review.locator('.rthread').first().waitFor();
    assert.equal(await jump.getByRole('checkbox', { name: 'Open level 1' }).getAttribute('aria-checked'), 'true', 'the tick survived the reload');
    assert.equal(await jump.getByRole('checkbox', { name: 'Jump the first gap: you land on it' }).getAttribute('aria-checked'), 'false');
    assert.ok(!show(r.jump).reviewed, 'a tick is not an approval');

    // The thread's changes open on its ticket.
    await jump.getByRole('button', { name: 'Changes · 1 file' }).click();
    await tab.locator('#thread .changes .sum', { hasText: '1 file changed' }).waitFor();
    await tab.keyboard.press('Escape');

    // Approve the sprint: every finished thread in it marked complete, and the call made on it accepted.
    await review.getByRole('button', { name: 'Approve the sprint' }).click();
    await until('the sprint is approved', () => show(r.jump).reviewed && show(r.coins).reviewed && show(r.call).status === 'decided');
    await review.getByText('✓ Everything finished in it is approved').waitFor();
    assert.ok(!show(r.map).reviewed, 'nothing outside the sprint');


    // At a phone's width the review is one column; its back link goes to the roadmap.
    await tab.setViewportSize({ width: 390, height: 844 });
    assert.ok(await tab.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'nothing scrolls sideways');
    await shot(tab, 'review-3-390');
    await review.getByRole('button', { name: '‹ Roadmap' }).click();
    await roadmap.locator('.lane').first().waitFor();
    assert.ok(!tab.url().includes('review='), 'the address no longer names the review');
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await browser.close();
    await page.stop();
    s.cleanup();
  }
});
