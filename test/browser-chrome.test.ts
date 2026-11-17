/**
 * The page's frame in a real browser: what the tab says, what shows when the server goes away,
 * the theme, and the page on a phone.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where
 * there is none. Set SPOOL_SHOTS to a folder for pictures, light and dark.
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

async function chrome(t: { skip: (why: string) => void }): Promise<Browser | null> {
  try {
    return await openChrome();
  } catch {
    t.skip('no Chrome on this machine to drive');
    return null;
  }
}

const icon = (page: Page): Promise<string> => page.evaluate('decodeURIComponent(document.getElementById("icon").href)');

test('the tab says what is happening: a dot while agents build, a count when something waits', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');

  const { url, stop } = await startPage(s);
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    // Nothing going on: the project's name, and the yarn alone.
    assert.equal(await page.title(), 'skyhop');
    assert.doesNotMatch(await icon(page), /circle/);

    // An agent at work: a dot ahead of the name, and on the yarn.
    // The sandbox's clock starts in the past, where a claim would be long stale: bring it to now.
    s.advance((Date.now() - Date.parse('2026-01-01T00:00:00Z')) / 3_600_000 - 1 / 60);
    s.sp('start', jump);
    await until('the tab shows a build', async () => (await page.title()) === '● skyhop');
    assert.match(await icon(page), /<circle[^>]*#1d4ed8/);

    // It finished, for him to check, and another thread asks him something: the question waits on him,
    // counted as the brief and the list of projects count it.
    assert.equal(s.exec(['done', jump, '-m', 'Snappier']).code, 0);
    s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--for', coins);
    await until('the tab counts what waits', async () => (await page.title()) === '(1) skyhop');
    assert.match(await icon(page), /#b45309[\s\S]*>1</);

    // Marked complete and answered, nothing waits, and the tab is quiet again.
    s.sp('approve', jump);
    s.sp('answer', s.json('review').questions[0].id, 'Outline');
    await until('the tab is quiet', async () => (await page.title()) === 'skyhop');
    assert.doesNotMatch(await icon(page), /circle/);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});

test('a page that loses its server says so, and is back by itself when the server is', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.id('task', 'Tighten the jump arc', '-s', 's');

  let server = await startPage(s);
  const { url } = server;
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const banner = page.locator('#away');
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    assert.equal(await banner.isVisible(), false);
    // Anything the page itself keeps would be gone if it reloaded.
    await page.evaluate('window.stayed = true');
    const before = await page.evaluate('token');

    // The server goes: after a few missed looks, a line under the bar says so, and the board dims.
    await server.stop();
    await banner.waitFor();
    assert.match(await banner.innerText(), /^Not connected to the Spool server\. Last heard from it \d+s ago\. Trying again…$/);
    assert.equal(await page.evaluate('document.body.classList.contains("away")'), true);
    await shot(page, 'chrome-away');

    // The same address answers again, a new server with a new token: the line goes, with no reload.
    server = await startPage(s, '--port', String(server.port));
    await banner.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate('document.body.classList.contains("away")'), false);
    assert.equal(await page.evaluate('window.stayed'), true);
    const fresh = /const TOKEN = '([^']+)';/.exec(await (await fetch(url)).text())![1];
    assert.notEqual(fresh, before);
    await until('the page has the new token', async () => (await page.evaluate('token')) === fresh);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await server.stop();
    s.cleanup();
  }
});

test('light or dark by his pick, kept in the browser, or by the system', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.id('task', 'Tighten the jump arc', '-s', 's');

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ colorScheme: 'light' });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const themer = page.locator('#themer');
  const background = (): Promise<string> => page.evaluate('getComputedStyle(document.body).backgroundColor');
  const LIGHT = 'rgb(247, 246, 243)';
  const DARK = 'rgb(21, 20, 19)';
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();
    // At first it follows the system, and goes with it.
    assert.equal(await themer.getAttribute('title'), 'Theme: System. Click for Light.');
    assert.equal(await background(), LIGHT);
    await page.emulateMedia({ colorScheme: 'dark' });
    await until('it follows the system to dark', async () => (await background()) === DARK);

    // Light, picked, holds against a dark system; Dark against a light one.
    await themer.click();
    assert.equal(await themer.getAttribute('title'), 'Theme: Light. Click for Dark.');
    assert.equal(await background(), LIGHT);
    await page.emulateMedia({ colorScheme: 'light' });
    await themer.click();
    assert.equal(await themer.getAttribute('title'), 'Theme: Dark. Click for System.');
    assert.equal(await background(), DARK);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("button.go, #themer")).colorScheme'), 'dark');
    await shot(page, 'chrome-dark-picked');

    // The pick outlives the page.
    await page.reload();
    await page.locator('#board .card').first().waitFor();
    assert.equal(await background(), DARK);
    assert.equal(await themer.getAttribute('aria-label'), 'Theme: Dark');

    // And round to System again.
    await themer.click();
    assert.equal(await background(), LIGHT);
    assert.equal(await themer.getAttribute('title'), 'Theme: System. Click for Light.');
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});

test('on a phone: the bar in two rows, one column at a time, the ticket filling the screen', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop-on-the-go', '--gate');
  s.advance((Date.now() - Date.parse('2026-01-01T00:00:00Z')) / 3_600_000 - 1);
  s.sp('sprint', 'Sprint 1');
  const level = s.id('task', 'A daily challenge level with a leaderboard and a share card for every run', '-s', 'l', '-p', '1');
  s.sp('edit', level, '--tag', 'daily', '--tag', 'levels', '--version', '1.5', '--sprint', 'Sprint 1');
  s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const pause = s.id('task', 'Pause button under the score', '-s', 'xs');
  s.sp('build', pause);
  s.sp('start', pause, '--as', 'Claude Fable 5.2');
  s.sp('done', pause, '-m', 'A pause button under the score; it pauses the music too.', '--as', 'Claude Fable 5.2');
  const music = s.id('task', 'New music for the menu', '-s', 's');
  s.sp('build', music);
  s.sp('start', music);

  const { url, stop } = await startPage(s);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const board = page.locator('#board');
  const jump = page.locator('#jump');
  // Nothing on the page is wider than the phone, and nothing to tap is under 36px.
  const fits = async (where: string): Promise<void> => {
    assert.ok((await page.evaluate('document.documentElement.scrollWidth')) as number <= 390, `${where}: the page is wider than the phone`);
    const short = await page.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.getClientRects().length && !b.closest('[hidden]'))
      .map((b) => [b.textContent.trim() || b.title, b.getBoundingClientRect().height]).filter(([, h]) => h < 35.5)`);
    assert.deepEqual(short, [], `${where}: buttons under 36px`);
  };
  const scrolled = (): Promise<number> => board.evaluate((node) => node.scrollLeft);
  const left = (key: string): Promise<number> => page.locator(`#board [data-column="${key}"]`).evaluate((node) => (node as unknown as { offsetLeft: number }).offsetLeft);
  try {
    await page.goto(url);
    await page.locator('#board .card').first().waitFor();

    // The bar is two rows: the project and the views, then the search's button, the status, the bell and the gear. The theme is in Settings.
    const middle = async (selector: string): Promise<number> => {
      const box = (await page.locator(selector).boundingBox())!;
      return box.y + box.height / 2;
    };
    const row = async (a: string, b: string): Promise<boolean> => Math.abs((await middle(a)) - (await middle(b))) < 6;
    assert.ok(await row('.brand', '.tabs'), 'the project and the views are one row');
    assert.ok((await middle('#searchbtn')) > (await middle('.tabs')) + 30, 'the search is on the second row');
    assert.ok(await row('#searchbtn', '#runner'), 'the status is on the search row');
    assert.ok(await row('#searchbtn', '#notifier'), 'the bell is on the search row');
    assert.ok(await row('#searchbtn', '#gear'), 'the gear is on the search row');
    assert.equal(await page.locator('#themer').isVisible(), false, 'no room for the theme: it is in Settings');
    await fits('the board');

    // One column at a time, and a row of their names with what each holds goes to another.
    assert.deepEqual(await jump.locator('button').allInnerTexts(), ['Backlog 2', 'Build 1', 'Building 1', 'Done 1']);
    assert.equal((await page.locator('#board [data-column="proposed"]').boundingBox())!.width, 358);
    assert.match((await jump.locator('button.on').innerText()), /^Backlog/);
    await shot(page, 'phone-1-board');
    await jump.getByRole('button', { name: /^Done/ }).click();
    await until('the board is at Done', async () => (await scrolled()) === (await left('done')) - (await left('proposed')));
    await until('Done is marked as in view', async () => /^Done/.test(await jump.locator('button.on').innerText()));
    await shot(page, 'phone-2-done');
    // A swipe lands on a column, not between two.
    await board.evaluate((node) => node.scrollTo({ left: node.scrollLeft - 300 }));
    await until('the swipe snaps to Building', async () => (await scrolled()) === (await left('building')) - (await left('proposed')));
    await until('Building is marked as in view', async () => /^Building/.test(await jump.locator('button.on').innerText()));
    // The board redrawing under him leaves him on the column he was looking at.
    s.id('task', 'A night level', '-s', 's');
    await until('the board redrew', async () => (await jump.locator('button').first().innerText()) === 'Backlog 3');
    assert.equal(await scrolled(), (await left('building')) - (await left('proposed')));
    assert.match(await jump.locator('button.on').innerText(), /^Building/);

    // The backlog's rows wrap inside the phone.
    await page.getByRole('button', { name: 'Backlog', exact: true }).first().click();
    await page.locator('#backlog .row').first().waitFor();
    assert.equal(await jump.isVisible(), false);
    await fits('the backlog');
    await shot(page, 'phone-3-backlog');

    // The ticket is the whole screen, its fields under the conversation.
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await jump.getByRole('button', { name: /^Done/ }).click();
    await page.locator('#board [data-column="done"] .card .title').first().click();
    const ticket = page.locator('#thread');
    await ticket.waitFor();
    assert.deepEqual(await ticket.boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
    assert.ok((await page.locator('#thread .side').boundingBox())!.y > (await page.locator('#thread .feed').boundingBox())!.y, 'the fields come after the conversation');
    await fits('the ticket');
    await shot(page, 'phone-4-ticket');

    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'phone-dark-4-ticket');
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });
    await shot(page, 'phone-dark-2-done');
    await page.getByRole('button', { name: 'Backlog', exact: true }).first().click();
    await shot(page, 'phone-dark-3-backlog');
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    await stop();
    s.cleanup();
  }
});
