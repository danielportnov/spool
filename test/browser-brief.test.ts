/**
 * While you were away, on the page, in a real browser.
 *
 * After a night of agents working, the board opens straight onto its columns:
 * what shipped is in Done, and the few finished threads the brief says are worth
 * a look carry a small mark there, with why on hover. Set SPOOL_SHOTS to a folder
 * to leave pictures of it there, light, dark and at a phone's width.
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

test('the board opens on its columns: no brief above them, and the Done cards worth a look carry a mark that says why', async (t) => {
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
    const marks = page.locator('#board .chip.worth');
    const card = (title: string) => page.locator('#board .card', { hasText: title });
    const ticket = page.locator('#thread');
    await page.goto(url);
    await card('Rebuild the level editor').waitFor();

    // No panel above the columns: the board is the first thing under the bar.
    assert.equal(await page.locator('#brief').count(), 0);
    assert.equal(await page.getByText('since you last looked').count(), 0);

    // The two worth a look carry the mark, and its hover says why; the small ones do not.
    const big = card('Rebuild the level editor').locator('.chip.worth');
    assert.equal(await big.innerText(), '★ Worth a look');
    assert.equal(await big.getAttribute('title'), 'Worth a look: large · 9 files changed');
    assert.equal(await card('Make coins readable at sunset').locator('.chip.worth').getAttribute('title'), 'Worth a look: 1 call an agent made');
    assert.equal(await card('Fix the typo on the title screen').locator('.chip.worth').count(), 0);
    assert.equal(await card('Round the menu corners').locator('.chip.worth').count(), 0);
    assert.equal(await marks.count(), 2);
    // What needed him in the brief is on its own card: the stopped thread in Build, the question on its thread.
    await card('Tighten the jump arc').getByRole('button', { name: '▶ Carry on' }).waitFor();
    assert.equal(await card('Fade the music between levels').locator('.flag').innerText(), 'Needs a call from you');
    await shot(page, 'brief-light');

    // The mark is a chip like the others: the card still opens its thread.
    await card('Rebuild the level editor').locator('.title').click();
    await ticket.getByText('Rebuild the level editor').first().waitFor();
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });

    // A thread marked complete is checked, and loses its mark.
    s.sp('approve', '--all');
    await marks.first().waitFor({ state: 'detached' });
    await page.close();

    // Dark, and at a phone's width, with a fresh night's work.
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
      await p.locator('#board .card', { hasText: 'Speed up loading' }).locator('.chip.worth').waitFor();
      assert.equal(await p.locator('#board .card', { hasText: 'Bigger coins' }).locator('.chip.worth').count(), 0);
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
