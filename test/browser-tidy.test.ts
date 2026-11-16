/**
 * Small things a person sees on the page, in a real browser: the bar fits a phone, a question's
 * answers line up on its thread, a card opens from anywhere on it, a thread's Why names its own project, a
 * ticket says only what a run really had, the dark theme's green buttons are calm, and a page that
 * lost its server says so plainly. SPOOL_SHOTS=<folder> leaves pictures of each.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { startPage, until } from './helpers.ts';
import { chrome, ship, slowAgent, tipNight, tipProject } from './tip-sandbox.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string, whole = false): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: whole });
}

test('on a phone the name has its room and the search is a button; answers line up; a card opens from anywhere on it', async (t) => {
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
    await tab.locator('#brief .bhead').waitFor();
    return tab;
  };
  const sameWidths = async (tab: Page, where: string): Promise<void> => {
    const widths = await tab.locator(where).evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().width)));
    const tops = await tab.locator(where).evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
    assert.equal(widths.length, 2, where);
    // Side by side, or one to a line at one width.
    assert.ok(tops[0] === tops[1] || widths[0] === widths[1], `${where}: ${widths.join(', ')} at ${tops.join(', ')}`);
  };
  // A question is asked on its thread alone: its card and the brief say nothing of it, and its ticket has the answers.
  const answers = async (tab: Page): Promise<void> => {
    assert.equal(await tab.locator('#brief, #board').getByText('Who pays the cent').count(), 0, 'no question on the board or in the brief');
    await tab.locator('#board .card', { hasText: 'Make the shares add up' }).locator('.title').click();
    await sameWidths(tab, '#thread .post:has-text("Who pays the cent") .opts button');
  };
  const shut = async (tab: Page): Promise<void> => {
    await tab.keyboard.press('Escape');
    await tab.locator('#thread').waitFor({ state: 'hidden' });
  };

  try {
    for (const scheme of ['light', 'dark'] as const) {
      const phone = await open({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
      await shot(phone, `phone-top-${scheme}`);
      const brand = phone.locator('.brand');
      assert.ok(await brand.evaluate((n) => n.scrollWidth <= n.clientWidth), `${scheme}: the project's name is not cut`);
      assert.match(await brand.innerText(), /tip-splitter/);
      await answers(phone);
      await shut(phone);
      if (scheme === 'light') {
        // The search opens over the bar's second row, from its button or from /, and folds away left empty.
        const box = phone.locator('#search');
        assert.equal(await box.isVisible(), false);
        await phone.locator('#searchbtn').click();
        await box.waitFor();
        assert.equal(await phone.evaluate('document.activeElement.id'), 'search');
        await shot(phone, 'phone-search-open');
        await phone.keyboard.press('Escape');
        await box.waitFor({ state: 'hidden' });
        await phone.keyboard.press('/');
        await box.waitFor();
        await phone.keyboard.type('remember');
        await until('the board is narrowed', async () => (await phone.locator('#board .card[data-id]').count()) === 1);
        await phone.keyboard.press('Escape');
        await box.waitFor({ state: 'hidden' });
      }
      await phone.close();
    }

    const wide = await open({ viewport: { width: 1440, height: 900 } });
    // A result written over several lines: whole, it is read with its list; where there is room for a line, its first.
    assert.deepEqual(await wide.evaluate("[firstLine('Shares add up now:\\n- the first person pays the cent'), firstLine('\\n- one\\n- two'), richNote('Shares add up now:\\n- the first person pays the cent').querySelectorAll('li').length]"),
      ['Shares add up now:', 'one', 1]);
    await answers(wide);
    await shot(wide, 'answers-wide');
    await shut(wide);
    // A click on the body of a card opens its ticket; one on its id copies, and opens nothing.
    const card = wide.locator('#board .card', { hasText: 'Refuse to split a bill between no one' });
    await card.locator('.why').click();
    await wide.locator('#thread h2', { hasText: 'Refuse to split a bill between no one' }).waitFor();
    // Its Why is headed with the project's own name.
    await wide.locator('#thread').getByText('How it helps tip-splitter').waitFor();
    await wide.keyboard.press('Escape');
    await wide.locator('#thread').waitFor({ state: 'hidden' });
    await card.locator('.key').click();
    await wide.locator('#said', { hasText: 'Copied' }).waitFor();
    assert.equal(await wide.locator('#thread').isVisible(), false);
    // A card can still be dragged: from the backlog to Build.
    await card.dragTo(wide.locator('#board .col[data-column="build"]'));
    await wide.locator('#board .col[data-column="build"] .card', { hasText: 'Refuse to split a bill between no one' }).waitFor();
    assert.equal(await wide.locator('#thread').isVisible(), false, 'a drag opens no ticket');
    await wide.close();
    assert.deepEqual(problems, []);
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('a ticket shows only what a run really had; dark buttons are calm; a lost server is plain to see', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  t.after(() => browser.close());
  const s = tipProject();
  const zero = s.id('task', 'Refuse to split a bill between no one', '-s', 'xs', '-b', 'What: say so, and exit with 1\nWhy: Infinity is not an answer\nDone when: zero people is refused');
  s.sp('sprint', 'First round');
  for (const title of ['Colour the total in green', 'Show the tip on its own line']) s.id('task', title, '-s', 'xs', '--sprint', 'First round');
  const cent = s.id('task', 'Round each share to the cent', '-s', 'xs');
  ship(s, cent, 'Every amount is rounded to the cent', [], 'Round half up, or to even?');

  let page = await startPage(s, '--run', '--agent', slowAgent(s));
  const problems: string[] = [];
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  tab.on('pageerror', (error) => problems.push(String(error)));
  try {
    s.sp('build', zero);
    await until('the thread is being built', () => s.json('show', zero).item.state === 'active');
    await tab.goto(`${page.url}?view=board`);
    await tab.locator(`#board .card[data-id="${zero}"]`).click();
    const ticket = tab.locator('#thread');
    await ticket.locator('.livelog').waitFor();
    // The agent is not claude: it was given no model and no effort, and nothing says it ran with one.
    // The boxes are there for the next run, each saying what its size would give.
    const side = ticket.locator('.side');
    assert.doesNotMatch(await side.innerText(), /MODEL\n(Haiku|Sonnet)\n|EFFORT\nmedium\n/i);
    await side.locator('.field', { hasText: 'Model' }).getByText('For the next run').waitFor();
    assert.equal(await side.locator('.field', { hasText: 'Model' }).locator('select').count(), 1);
    await shot(tab, 'ticket-building-light');
    await tab.emulateMedia({ colorScheme: 'dark' });
    await shot(tab, 'ticket-building-dark');
    await tab.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });
    await shot(tab, 'board-dark');
    await tab.locator('.tab', { hasText: 'Backlog' }).click();
    await tab.locator('#backlog .group').first().waitFor();
    await shot(tab, 'backlog-dark');
    await tab.locator('.tab', { hasText: 'Board' }).click();
    await tab.emulateMedia({ colorScheme: 'light' });
    await shot(tab, 'board-light');

    // The server goes: the banner is plain, one line, and the agents' switch says it does not know.
    await page.stop();
    await tab.locator('#away').waitFor();
    assert.equal(await tab.locator('#runner').innerText(), 'Agents: ?');
    assert.equal(await tab.locator('#runner.on').count(), 0);
    assert.equal(await tab.locator('#builder button.on').count(), 0);
    assert.ok((await tab.locator('#away').boundingBox())!.height < 40, 'the banner is one line');
    await shot(tab, 'lost-server-light');
    await tab.emulateMedia({ colorScheme: 'dark' });
    await shot(tab, 'lost-server-dark');
    await tab.setViewportSize({ width: 390, height: 844 });
    await shot(tab, 'lost-server-390-dark');
    assert.ok((await tab.locator('#away').boundingBox())!.height < 40, 'one line on a phone too');
    await tab.setViewportSize({ width: 1440, height: 900 });
    await tab.emulateMedia({ colorScheme: 'light' });
    // Back: the switch says what it is again.
    page = await startPage(s, '--port', String(page.port));
    await tab.locator('#away').waitFor({ state: 'hidden' });
    await until('the switch is known again', async () => /^Agents: off$/.test(await tab.locator('#runner').innerText()));
    assert.equal(await tab.locator('#builder button.on').count(), 1);
    assert.deepEqual(problems, []);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
