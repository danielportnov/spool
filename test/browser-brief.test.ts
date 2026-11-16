/**
 * While you were away: the morning brief on the page, in a real browser.
 *
 * After a night of agents working, the board opens with a panel above its
 * columns: what needs him, what is worth a look, and the rest, folded. Set
 * SPOOL_SHOTS to a folder to leave pictures of it there, light, dark and at a
 * phone's width.
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
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

function ship(s: Sandbox, id: string, summary: string, files = 1): void {
  s.sp('start', id);
  for (let i = 0; i < files; i++) s.write(`src/${id}-${i}.txt`, `${summary} ${i}\n`);
  s.commitAll(`${summary}\n\nSpool: ${id}`);
  s.sp('done', id, '-m', summary);
}

test('the brief sits above the board: each line opens its thread, it folds, and approving everything clears it', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  // A night of work: a large change, one an agent made a call on, two small ones (one in a sprint),
  // a thread its agent walked away from, and a question.
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  const big = s.id('task', 'Rebuild the level editor', '-s', 'l');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 's');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  s.sp('sprint', 'Polish');
  const menu = s.id('task', 'Round the menu corners', '-s', 'xs', '--sprint', 'Polish');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const music = s.id('task', 'Fade the music between levels', '-s', 's');
  ship(s, big, 'The editor saves as you go, and undo works across levels', 9);
  s.sp('start', coins);
  s.sp('assume', 'Outline the coins, or turn them teal?', '--chose', 'A dark outline', '--for', coins);
  s.write('src/coins.txt', 'outlined\n');
  s.commitAll(`Outline the coins\n\nSpool: ${coins}`);
  s.sp('done', coins, '-m', 'Coins have a dark outline, so they show against the sunset');
  ship(s, typo, 'The title says Spool, not Sppol');
  ship(s, menu, 'Menu corners are rounded');
  s.sp('start', jump);
  s.sp('log', jump, 'I could not find where the jump arc is set');
  s.sp('build', '--abort', jump);
  s.sp('ask', 'Fade over one second, or two?', '--option', 'One second', '--option', 'Two seconds', '--recommend', '2', '--for', music);

  const { url, stop } = await startPage(s);
  const problems: string[] = [];
  const open = async (options: Parameters<Browser['newPage']>[0]): Promise<Page> => {
    const page = await browser.newPage(options);
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    return page;
  };

  try {
    const page = await open({ viewport: { width: 1440, height: 900 } });
    const panel = page.locator('#brief');
    const head = panel.locator('.bhead');
    const ticket = page.locator('#thread');
    await page.goto(url);
    await head.waitFor();

    // Titled as the brief's headline reads, then the parts in the order the command gives them.
    assert.match(await head.innerText(), /4 threads shipped since you last looked, over \d+m · 2 need you/);
    assert.deepEqual((await panel.locator('h2').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim()), ['NEEDS YOU 2', 'WORTH A LOOK 2']);
    const worth = panel.locator('.card', { hasText: 'Rebuild the level editor' });
    assert.match(await worth.innerText(), /The editor saves as you go[\s\S]*large · 9 files changed/);
    await panel.locator('.card', { hasText: 'Make coins readable at sunset' }).getByText('1 call an agent made').waitFor();
    await panel.locator('.card', { hasText: 'Tighten the jump arc' }).getByText('Last said: “I could not find where the jump arc is set”').waitFor();
    // The rest is folded shut, a click away, under its sprint.
    assert.equal(await panel.getByText('Fix the typo on the title screen').count(), 0);
    await panel.getByRole('button', { name: '▸ Also shipped · 2' }).click();
    await panel.getByText('🏁 Polish').waitFor();
    await panel.locator('.card', { hasText: 'Round the menu corners' }).getByText('Menu corners are rounded').waitFor();
    // It sits above the columns, and is on the Board view only.
    assert.ok((await panel.boundingBox())!.y < (await page.locator('#board').boundingBox())!.y);
    await shot(page, 'brief-light');

    // Each line opens its thread.
    await worth.locator('.title').click();
    await ticket.getByText('Rebuild the level editor').first().waitFor();
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });
    await panel.locator('.card', { hasText: 'Tighten the jump arc' }).locator('.title').click();
    await ticket.getByText('Tighten the jump arc').first().waitFor();
    await page.keyboard.press('Escape');
    await panel.locator('.card', { hasText: 'Fade over one second' }).locator('.title').click();
    await ticket.getByText('Fade the music between levels').first().waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await head.waitFor();

    // Folded, it is its headline alone, and stays so across a reload.
    await head.click();
    await panel.locator('h2').first().waitFor({ state: 'detached' });
    await page.reload();
    await head.waitFor();
    assert.equal(await panel.locator('h2').count(), 0);
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    // Until something else is finished: then it opens again, with that in it.
    const fade = s.id('task', 'Fade the title in', '-s', 'xs');
    ship(s, fade, 'The title fades in');
    await panel.getByText('NEEDS YOU').waitFor();
    assert.match(await head.innerText(), /^▾\s*5 threads shipped/);

    // The question is answered right there, with the buttons the cards use.
    await panel.locator('.card', { hasText: 'Fade over one second' }).getByRole('button', { name: 'Two seconds' }).click();
    await panel.locator('.card', { hasText: 'Fade over one second' }).waitFor({ state: 'detached' });

    // All good: every finished thread approved, and the call an agent made.
    await panel.getByRole('button', { name: 'All good: approve everything' }).click();
    await panel.getByText('Worth a look', { exact: false }).waitFor({ state: 'detached' });
    assert.match(await head.innerText(), /Nothing shipped since you last looked · 1 needs you/);
    const review = s.json('review');
    assert.deepEqual([review.shipped.length, review.assumptions.length], [0, 0]);
    // With the stopped thread back in the backlog, nothing is left, and the panel is not there at all.
    s.sp('propose', jump);
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await panel.innerHTML(), '');
    await page.close();

    // Dark, and at a phone's width, with the same night's work: a sandbox of its own is not needed,
    // undoing the approvals would be; so the pictures are of a fresh night.
    s.sp('build', jump);
    s.sp('start', jump);
    s.sp('log', jump, 'The arc is set in two places, and they disagree');
    s.sp('build', '--abort', jump);
    for (const [title, summary] of [['Add a pause menu', 'Escape pauses, and the menu says so'], ['Speed up loading', 'Loads in half the time']] as const) {
      ship(s, s.id('task', title, '-s', 'm'), summary, 9);
    }
    ship(s, s.id('task', 'Bigger coins', '-s', 'xs'), 'Coins are a third bigger');
    for (const [name, options] of [
      ['brief-dark', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' as const }],
      ['brief-390', { viewport: { width: 390, height: 844 } }],
      ['brief-390-dark', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' as const }],
    ] as const) {
      const p = await open(options);
      await p.goto(url);
      await p.locator('#brief .bhead').waitFor();
      await p.locator('#brief').getByRole('button', { name: '▸ Also shipped · 1' }).click();
      await p.locator('#brief').getByText('Bigger coins').waitFor();
      // Nothing in it is wider than the phone.
      const wide = await p.locator('#brief').evaluate((n) => n.scrollWidth <= n.clientWidth);
      assert.ok(wide, `${name}: the panel fits its width`);
      await shot(p, name);
      await p.close();
    }
    assert.deepEqual(problems, []);
  } finally {
    await stop();
    await browser.close();
    s.cleanup();
  }
});
