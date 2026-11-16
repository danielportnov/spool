/**
 * The brief leaves room for the board, in a real browser: at 1440 by 900, after a night with five
 * threads shipped and a question, the board's columns start on the first screen; at a phone's
 * width it is one column and about a screen at most. SPOOL_SHOTS=<folder> leaves pictures of it.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { startPage } from './helpers.ts';
import { chrome, tipNight } from './tip-sandbox.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string, whole = false): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: whole });
}

test('the brief is a third of the first screen at most, and the board starts on it', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  t.after(() => browser.close());
  const s = tipNight();
  const page = await startPage(s);
  const problems: string[] = [];
  const open = async (options: Parameters<Browser['newPage']>[0]): Promise<Page> => {
    const tab = await browser.newPage(options);
    tab.on('pageerror', (error) => problems.push(String(error)));
    tab.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    await tab.goto(`${page.url}?view=board`);
    await tab.locator('#brief').getByText('Accept a tip written with a percent sign').waitFor();
    return tab;
  };

  try {
    for (const scheme of ['light', 'dark'] as const) {
      const tab = await open({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await shot(tab, `brief-1440-${scheme}`);
      const heading = (await tab.locator('#board .col h2').first().boundingBox())!;
      assert.ok(heading.y >= 0 && heading.y + heading.height <= 900, `${scheme}: the first column's heading is on the first screen (at ${heading.y})`);
      const brief = (await tab.locator('#brief').boundingBox())!;
      assert.ok(brief.height <= 900 * 0.36, `${scheme}: the brief is ${brief.height}px tall`);
      await tab.close();
    }

    const wide = await open({ viewport: { width: 1440, height: 900 } });
    const panel = wide.locator('#brief');
    // Approving everything is at the end of the headline's line.
    const head = (await panel.locator('.bhead').boundingBox())!;
    const approve = (await panel.getByRole('button', { name: 'All good: approve everything' }).boundingBox())!;
    assert.ok(Math.abs(approve.y + approve.height / 2 - (head.y + head.height / 2)) < 8, 'approve sits on the headline line');
    assert.ok(approve.x >= head.x + head.width, 'approve sits right of the headline');
    // Worth a look is cards across the width, three or four to a row, each with its steps folded behind "To check".
    const tops = await panel.locator('.worth > .card').evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    const first = tops.filter((y) => y === tops[0]).length;
    assert.ok(first >= 3 && first <= 4, `three or four to a row: ${tops.join(' ')}`);
    const worth = panel.locator('.card', { hasText: 'Accept a tip written with a percent sign' });
    assert.equal(await worth.getByText('Run node tip.js 84.50 3 18%').count(), 0);
    await worth.getByRole('button', { name: '▸ To check · 2' }).click();
    await worth.getByText('Run node tip.js 84.50 3 18%').waitFor();
    assert.equal(await wide.locator('#thread').isVisible(), false, 'unfolding the steps opens no ticket');
    // The rest of the card opens it.
    await worth.locator('.why').click();
    await wide.locator('#thread h2', { hasText: 'Accept a tip written with a percent sign' }).waitFor();
    await wide.keyboard.press('Escape');
    await wide.close();

    for (const scheme of ['light', 'dark'] as const) {
      const phone = await open({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
      await shot(phone, `brief-390-top-${scheme}`);
      const brief = (await phone.locator('#brief').boundingBox())!;
      assert.ok(brief.height <= 844, `${scheme}: the brief is ${brief.height}px tall on a phone`);
      const columns = await phone.locator('#brief .worth > .card').evaluateAll((cards) => new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size);
      assert.equal(columns, 1, `${scheme}: one column on a phone`);
      assert.ok(await phone.locator('#brief').evaluate((n) => n.scrollWidth <= n.clientWidth), `${scheme}: nothing in it is wider than the phone`);
      await phone.close();
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
