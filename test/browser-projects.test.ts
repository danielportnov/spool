/**
 * Every project on one page, driven in a real browser: the home view of all of them, the switcher
 * in the bar, the address that names the project, and a click on one board that changes that
 * project and no other. Skipped where there is no Chrome. SPOOL_SHOTS=<folder> leaves a picture of each step there.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page } from 'playwright-core';
import { Sandbox, openChrome, startPage, until } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('a page over several projects opens on all of them, and switches between their boards in place', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  // The page reads the real clock: a thread started at the sandbox's own hour would have gone quiet by now.
  s.advance((Date.now() - Date.parse('2026-01-01T00:00:00Z')) / 3_600_000 - 1);
  s.sp('init', '--name', 'studio', '--gate');
  const game = s.cd('games/sky_hop');
  game.sp('init', '--gate');
  const app = s.cd('apps/tidy_up');
  app.sp('init', '--gate');
  const logo = s.id('task', 'A shared logo for every app');
  const jump = game.id('task', 'Tighten the jump arc');
  const coins = game.id('task', 'Make coins readable at sunset');
  const music = game.id('task', 'A calmer title theme');
  game.sp('sprint', 'Polish', '--add', coins, music);
  const sprint = game.json('list', '-k', 'sprint').items[0].id;
  game.sp('play', sprint);
  game.sp('start', coins, '--as', 'Claude Fable 5.2');
  game.sp('log', coins, 'Outlining the coins in two pixels', '--as', 'Claude Fable 5.2');
  const chores = app.id('task', 'Weekly chores list');
  app.sp('ask', 'Start the week on Sunday or Monday?', '--option', 'Sunday', '--option', 'Monday', '--for', chores);
  const state = (on: Sandbox, id: string): string => on.json('show', id).item.state;

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const home = page.locator('#home');
  const switcher = page.locator('.pswitch');
  const project = (): string | null => new URL(page.url()).searchParams.get('project');

  try {
    // At the top with no project named: all of them, a row each, and the brief across them above.
    await page.goto(url);
    await home.locator('.prow').first().waitFor();
    assert.deepEqual(await home.locator('.prow .phead .pname').allInnerTexts(), ['studio', 'apps/tidy_up', 'games/sky_hop']);
    assert.equal(await switcher.locator('.pnow').innerText(), 'All projects');
    assert.ok(await page.locator('#board').isHidden(), 'no board under it');
    const sky = home.locator('.prow[data-project="games/sky_hop"]');
    assert.match(await sky.locator('.live').innerText(), /Make coins readable at sunset[\s\S]*Outlining the coins in two pixels/, 'what is building, and its agent\'s last line');
    assert.match(await sky.locator('.hsprint').innerText(), /Polish[\s\S]*0\/2/, 'its sprint, playing, and how far along');
    const tidy = home.locator('.prow[data-project="apps/tidy_up"]');
    assert.match(await tidy.innerText(), /1 needs you[\s\S]*Start the week on Sunday or Monday\?/, 'what needs him');
    assert.match(await home.locator('.hbrief').innerText(), /needs you[\s\S]*Start the week on Sunday or Monday\?[\s\S]*apps\/tidy_up/i, 'the brief names the project');
    await shot(page, 'projects-1-home');

    // A row opens that project's board, in place: its cards, and its name in the address.
    await sky.locator('.phead').click();
    await page.locator('#board .card[data-id="' + jump + '"]').waitFor();
    assert.equal(project(), 'games/sky_hop');
    assert.equal(await switcher.locator('.pnow').innerText(), 'games/sky_hop');
    assert.equal(await page.locator('#board .card[data-id="' + logo + '"]').count(), 0, 'not the top project\'s');
    await shot(page, 'projects-2-board');

    // The menu: every project with what it holds, the one needing him marked, and this one checked.
    await switcher.click();
    const menu = page.locator('.pmenu');
    await menu.waitFor();
    assert.deepEqual(await menu.locator('.pitem .pname').evaluateAll((nodes) => nodes.map((n) => n.firstChild!.textContent)), ['All projects', 'studio', 'apps/tidy_up', 'games/sky_hop']);
    assert.equal(await menu.locator('.pitem[aria-checked="true"]').getAttribute('data-project'), 'games/sky_hop');
    assert.equal(await menu.locator('.pitem[data-project="apps/tidy_up"] .pneeds').innerText(), '1 needs you');
    assert.equal(await menu.locator('.pitem[data-project="studio"] .pneeds').count(), 0);
    await shot(page, 'projects-3-menu');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });

    // Another project from the menu, without a reload, and its Backlog view.
    await page.evaluate('window.stay = true');
    await switcher.click();
    await menu.locator('.pitem[data-project="apps/tidy_up"]').click();
    await page.locator('#board .card[data-id="' + chores + '"]').waitFor();
    assert.equal(project(), 'apps/tidy_up');
    assert.equal(await page.evaluate('window.stay'), true, 'the same page, not loaded again');
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    await page.locator('#backlog .row[data-id="' + chores + '"]').waitFor();
    assert.equal(await page.locator('#backlog .row[data-id="' + jump + '"]').count(), 0);

    // Back goes to the board before, and "All projects" to the home view.
    await page.goBack();
    await until('Sky Hop is back', async () => project() === 'games/sky_hop' && (await page.locator('#backlog .row[data-id="' + jump + '"]').count()) === 1);
    await switcher.click();
    await menu.locator('.pitem[data-project=""]').click();
    await home.locator('.prow').first().waitFor();
    assert.equal(project(), null);

    // A link opens the right board, view and ticket.
    await page.goto(`${url}?project=apps%2Ftidy_up&view=backlog#${chores}`);
    await page.locator('#thread h2', { hasText: 'Weekly chores list' }).waitFor();
    assert.ok(await page.locator('#backlog').isVisible());
    // Closing the ticket keeps the project in the address.
    await page.keyboard.press('Escape');
    await until('the ticket closes', () => page.locator('#thread').isHidden());
    assert.equal(project(), 'apps/tidy_up');

    // What is done on Sky Hop's board is done to Sky Hop: archived there, and nothing else moved.
    await page.goto(`${url}?project=games%2Fsky_hop&view=board`);
    const backlogCol = page.locator('#board [data-column="proposed"]');
    await backlogCol.locator('.card', { hasText: 'Tighten the jump arc' }).getByRole('button', { name: 'Archive' }).click();
    await until('the thread is archived', () => state(game, jump) === 'archived');
    assert.deepEqual([state(s, logo), state(app, chores)], ['proposed', 'proposed'], 'the other projects are as they were');

    // Light and dark, wide and on a phone.
    await page.goto(url);
    await home.locator('.prow').first().waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
        await page.reload();
    await home.locator('.prow').first().waitFor();
    await shot(page, 'projects-4-home-dark');
    await switcher.click();
    await shot(page, 'projects-5-menu-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    const width = (await page.evaluate('document.documentElement.scrollWidth')) as number;
    assert.ok(width <= 390, `no sideways scroll on a phone (${width}px)`);
    await shot(page, 'projects-6-home-390-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await shot(page, 'projects-7-home-390');
    await switcher.click();
    await shot(page, 'projects-8-menu-390');

    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});

test('with one project there is no switcher, and the bar is as it was', async (t) => {
  let browser: Browser;
  try {
    browser = await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc');
  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url);
    await page.locator('#board .card[data-id="' + jump + '"]').waitFor();
    assert.equal(await page.locator('.pswitch').count(), 0);
    assert.equal(await page.locator('#project').innerText(), 'skyhop');
    assert.ok(await page.locator('#home').isHidden());
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
