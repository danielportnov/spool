/**
 * The page, driven the way a person drives it: a real browser, a real mouse.
 *
 * The other page tests talk to the server; this one clicks, drags and types.
 * It uses the Chrome already on the machine (through playwright-core, which
 * brings no browser of its own) and is skipped where there is none.
 *
 * Set SPOOL_SHOTS to a folder and it leaves a picture of each view there, for
 * a look at how the page actually renders.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Locator, type Page, chromium } from 'playwright-core';
import { CLI, Sandbox } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;

function startPage(s: Sandbox, port: number): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '--port', String(port), '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve({ child, url: found[1]! });
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

/** Wait for something in the spool itself to become true: the page saves, then the files say so. */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('the page, clicked, dragged and typed on in a real browser', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const pause = s.id('task', 'Pause button under the score', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const state = (id: string): string => s.json('show', id).item.state;

  const { child, url } = await startPage(s, 43000 + (process.pid % 2000));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const column = (key: string): Locator => page.locator(`#board [data-column="${key}"]`);
  const card = (key: string, title: string): Locator => column(key).locator('.card', { hasText: title });

  try {
    await page.goto(url);
    await column('proposed').waitFor();

    // What is on screen: the project and its version, four columns, the two views.
    assert.equal(await page.title(), 'skyhop');
    assert.deepEqual([await page.locator('#project').innerText(), await page.locator('#where').innerText()], ['skyhop', 'v1.4.2']);
    assert.deepEqual((await page.locator('#board .col h2').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim()), [
      '🟠 BACKLOG 2',
      '🟢 BUILD 1',
      '🔵 BUILDING 0',
      '✅ DONE 0',
    ]);
    await shot(page, '1-board');

    // ▶ Build moves a thread to Build.
    await card('proposed', 'Tighten the jump arc').getByRole('button', { name: '▶ Build' }).click();
    await card('build', 'Tighten the jump arc').waitFor();
    assert.equal(state(jump), 'ready');

    // Dragging, with the mouse: back to the backlog, and into Build again.
    await card('build', 'Tighten the jump arc').dragTo(column('proposed'));
    await card('proposed', 'Tighten the jump arc').waitFor();
    assert.equal(state(jump), 'proposed', 'dragged back to the backlog');
    await card('proposed', 'Tighten the jump arc').dragTo(column('build'));
    await card('build', 'Tighten the jump arc').waitFor();
    assert.equal(state(jump), 'ready', 'dragged into build');

    // + Add: typed, Enter, and the card is there without waiting on anything.
    await column('proposed').locator('button.add').click();
    await page.keyboard.type('A daily challenge level');
    const typed = Date.now();
    await page.keyboard.press('Enter');
    await card('proposed', 'A daily challenge level').waitFor();
    assert.ok(Date.now() - typed < 1500, 'what was added shows at once');
    const daily = s.json('list').items.find((i: { title: string }) => i.title === 'A daily challenge level').id;

    // A page left open while its server restarted has an old token. Adding still works, and nothing typed is lost.
    await page.evaluate('token = "left-over-from-before-a-restart"');
    await column('build').locator('button.add').click();
    await page.keyboard.type('Fix the typo on the title screen');
    await page.keyboard.press('Enter');
    await card('build', 'Fix the typo on the title screen').waitFor();
    const typo = s.json('list').items.find((i: { title: string }) => i.title === 'Fix the typo on the title screen').id;
    assert.equal(state(typo), 'ready', 'added under Build, it is in build');
    s.sp('propose', typo);
    await card('proposed', 'Fix the typo on the title screen').waitFor();

    // A question is answered where it is asked.
    await card('build', 'Make coins readable at sunset').getByRole('button', { name: 'Outline' }).click();
    await until('the answer is on record', () => s.json('review').questions.length === 0);
    await card('build', 'Make coins readable at sunset').locator('.q').waitFor({ state: 'detached' });

    // The ticket: opened from a card, its fields changed, a reply posted, closed with Escape.
    await card('build', 'Tighten the jump arc').locator('.title').click();
    const ticket = page.locator('#thread');
    await ticket.waitFor();
    await ticket.locator('.field', { hasText: 'Priority' }).locator('select').selectOption('0');
    await until('the priority is saved', () => s.json('show', jump).item.priority === 0);
    await ticket.getByPlaceholder('Add a tag').fill('Feel');
    await ticket.getByPlaceholder('Add a tag').press('Enter');
    await ticket.locator('.side .chip', { hasText: '#feel' }).waitFor();
    await ticket.locator('h2').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('A snappier jump');
    await page.keyboard.press('Enter');
    await until('the new name is saved', () => s.json('show', jump).item.title === 'A snappier jump');
    await ticket.getByPlaceholder('Post your reply').fill('snappy, not heavy');
    await ticket.getByRole('button', { name: 'Reply' }).click();
    await ticket.locator('.post', { hasText: 'snappy, not heavy' }).waitFor();
    assert.match(s.item(jump), /> snappy, not heavy\n> — \[\[n-/);
    await shot(page, '2-ticket');
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });

    // The Backlog view takes the board's place: it is on screen, at the top, and the board is not.
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    const backlog = page.locator('#backlog');
    await backlog.waitFor();
    assert.equal(await page.locator('#board').isVisible(), false, 'the board is gone while the backlog is up');
    assert.ok((await backlog.boundingBox())!.y < 200, 'the backlog is at the top of the page, not below the board');

    // A sprint: made, filled by dragging a row into it, and played.
    await backlog.getByRole('button', { name: '+ Create sprint' }).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Polish');
    await page.keyboard.press('Enter');
    const sprint = backlog.locator('.group', { hasText: 'Polish' });
    await sprint.waitFor();
    await sprint.getByText('+ Say what this sprint is for').click();
    await sprint.getByPlaceholder('Goal: what this sprint is for').fill('Everything feels tight');
    await sprint.getByPlaceholder('Why: why now').fill('the beta opens on Friday');
    await sprint.getByRole('button', { name: 'Save' }).click();
    await sprint.locator('.about', { hasText: 'Everything feels tight' }).waitFor();
    assert.match(s.json('show', s.json('list', '-k', 'sprint').items[0].id).item.body, /^Goal: Everything feels tight\nWhy: the beta opens on Friday/);
    await backlog.locator('.row', { hasText: 'A daily challenge level' }).dragTo(sprint);
    await sprint.locator('.row', { hasText: 'A daily challenge level' }).waitFor();
    assert.ok(s.json('show', daily).item.sprint, 'dragged into the sprint');
    await shot(page, '3-backlog');
    await sprint.getByRole('button', { name: '▶ Play sprint' }).click();
    await until('playing the sprint moved its thread to build', () => state(daily) === 'ready');
    await sprint.locator('.ghead .state', { hasText: 'running' }).waitFor();

    // Back on the board: a pill for the sprint narrows it, and the search narrows it too.
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await column('build').waitFor();
    assert.equal(await backlog.isVisible(), false);
    await page.locator('#quick .pill', { hasText: 'Polish' }).click();
    assert.deepEqual(await page.locator('#board .card .title').allInnerTexts(), ['A daily challenge level']);
    await page.locator('#quick .pill', { hasText: 'All' }).click();
    await page.keyboard.press('/');
    await page.keyboard.type('coins');
    assert.deepEqual(await page.locator('#board .card .title').allInnerTexts(), ['Make coins readable at sunset']);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#board .card').count(), 5);

    // Each column sorts and filters by itself, and remembers it.
    const titles = (key: string): Promise<string[]> => column(key).locator('.card .title').allInnerTexts();
    assert.deepEqual(await titles('proposed'), ['Pause button under the score', 'Fix the typo on the title screen']);
    await column('proposed').getByLabel('Sort this column').selectOption('title');
    assert.deepEqual(await titles('proposed'), ['Fix the typo on the title screen', 'Pause button under the score']);
    await column('build').getByLabel('Filter this column').selectOption({ label: '#feel' });
    assert.deepEqual(await titles('build'), ['A snappier jump']);
    assert.match(await column('build').locator('h2').innerText(), /1 OF 3/i);
    assert.deepEqual(await titles('proposed'), ['Fix the typo on the title screen', 'Pause button under the score'], 'the other columns are left alone');
    await page.reload();
    await column('build').waitFor();
    assert.deepEqual(await titles('build'), ['A snappier jump'], 'the choice is remembered');
    await column('build').getByLabel('Filter this column').selectOption('');
    await column('proposed').getByLabel('Sort this column').selectOption('');
    assert.equal((await titles('build')).length, 3);

    // "Add to Build" at the foot of the backlog moves what is shown there, and only that: it knows the filters.
    const extra = s.id('task', 'Brighter sky on level 3', '-s', 's', '--tag', 'art');
    s.sp('task', 'Sunset palette for level 4', '-s', 's', '--tag', 'art');
    await card('proposed', 'Sunset palette for level 4').waitFor();
    assert.equal(await column('proposed').locator('.card').count(), 4);
    assert.equal(await column('proposed').locator('.addall').innerText(), '▶ Add all 4 shown to Build');
    await column('proposed').getByLabel('Filter this column').selectOption({ label: '#art' });
    await page.keyboard.press('/');
    await page.keyboard.type('sky');
    assert.deepEqual(await titles('proposed'), ['Brighter sky on level 3']);
    await column('proposed').locator('.addall', { hasText: '▶ Add 1 to Build' }).click();
    assert.equal(state(extra), 'proposed', 'the first press only arms it');
    await column('proposed').getByRole('button', { name: 'Yes, move 1 to Build' }).click();
    await until('what was shown is in build', () => state(extra) === 'ready');
    await page.keyboard.press('/');
    await page.keyboard.press('Escape');
    await column('proposed').getByLabel('Filter this column').selectOption('');
    await card('proposed', 'Pause button under the score').waitFor();
    assert.deepEqual([state(pause), state(typo)], ['proposed', 'proposed'], 'what the filters hid was left where it was');
    s.sp('propose', extra);
    await card('proposed', 'Brighter sky on level 3').waitFor();

    // Finished work: who built it is on the card, a tick approves one, and one button approves the rest.
    for (const [id, summary] of [[coins, 'Coins are outlined'], [jump, 'The jump snaps'], [daily, 'A new level every day']] as const) {
      s.sp('start', id, '--as', 'Claude Fable 5.2');
      s.sp('done', id, '-m', summary, '--as', 'Claude Fable 5.2');
    }
    await column('done').locator('.card').nth(2).waitFor();
    assert.equal(await column('done').locator('.card .avatar.claude svg').count(), 3, 'Claude is shown by its mark');
    await card('done', 'Make coins readable at sunset').locator('.tick').click();
    await until('one thread is marked complete', () => !!s.json('show', coins).item.reviewed);
    await column('done').getByRole('button', { name: '✓ Mark all 2 as complete' }).click();
    await until('the rest are marked complete', () => !!s.json('show', jump).item.reviewed && !!s.json('show', daily).item.reviewed);
    await column('done').getByText('Nothing left to check.').waitFor();
    await column('done').locator('.history').click();
    assert.equal(await column('done').locator('.card.past').count(), 3, 'kept as history, a click away');
    await shot(page, '4-done');

    assert.equal(state(pause), 'proposed', 'what was never moved to build was never built');
    // One refusal is expected: the request sent with the left-over token, before the page fetched a new one.
    assert.deepEqual(problems, ['Failed to load resource: the server responded with a status of 403 (Forbidden)'], 'the page logged no other errors');
  } finally {
    await browser.close();
    child.kill();
    s.cleanup();
  }
});
