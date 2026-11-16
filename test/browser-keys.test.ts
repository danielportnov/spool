/**
 * The page from the keyboard, driven with real key presses in a real browser: moving between
 * threads and acting on them, and the sheet that lists the keys. Skipped where there is no Chrome.
 * SPOOL_SHOTS=<folder> leaves a picture of each step there.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright-core';
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

// One page for every test here: each test is a part of the keyboard, used as a person would.
let browser: Browser | undefined;
let child: ChildProcess | undefined;
let url = '';
const s = new Sandbox();
s.sp('init', '--name', 'skyhop', '--gate');
const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
const coins = s.id('task', 'Make coins readable at sunset');
const pause = s.id('task', 'A pause menu that keeps the music');
const water = s.id('task', 'Water that slows the player');
s.sp('build', water);
const state = (id: string): string => s.json('show', id).item.state;

before(async () => {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return;
  }
  ({ child, url } = await startPage(s, 18000 + (process.pid % 1500)));
});

after(async () => {
  await browser?.close();
  child?.kill();
  s.cleanup();
});

async function open(view: string): Promise<{ page: Page; problems: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto(`${url}?view=${view}`);
  await page.locator(view === 'board' ? '#board .card' : '#backlog .row').first().waitFor();
  return { page, problems };
}

async function focus(page: Page): Promise<string | null> {
  const all = await page.locator('.kfocus').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-id')));
  return all.length === 1 ? all[0]! : all.length ? 'several' : null;
}

test('j, k, h and l move a focus between cards, and it lasts through the redraw', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const { page, problems } = await open('board');
  try {
    assert.equal(await focus(page), null, 'nothing is focused until a key is pressed');
    await page.keyboard.press('j');
    assert.equal(await focus(page), jump, 'j starts at the top of the first column');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    assert.equal(await focus(page), pause, 'and goes down it');
    await page.keyboard.press('j');
    assert.equal(await focus(page), pause, 'and stops at its foot');
    await page.keyboard.press('k');
    assert.equal(await focus(page), coins, 'k goes back up');
    await page.keyboard.press('l');
    assert.equal(await focus(page), water, 'l goes to the next column with a card in it');
    await page.keyboard.press('l');
    assert.equal(await focus(page), water, 'and no further when the rest are empty');
    await page.keyboard.press('h');
    assert.equal(await focus(page), jump, 'h comes back, as near the same height as there is');
    await shot(page, 'keys-1-focus');

    // The board is drawn again from scratch when the spool changes: the focus is kept by id.
    const before = await page.locator('#board .card[data-id="' + jump + '"]').elementHandle();
    s.sp('task', 'Coyote time on ledges');
    await page.locator('#board .card', { hasText: 'Coyote time on ledges' }).waitFor();
    assert.equal(await before!.evaluate((n) => n.isConnected), false, 'the cards were built again');
    assert.equal(await focus(page), jump, 'and the focus is on the same thread');

    // Keys wait while he types.
    await page.keyboard.press('/');
    await page.keyboard.type('jump');
    assert.equal(await page.locator('#search').inputValue(), 'jump', 'j went into the search');
    assert.equal(await focus(page), jump, 'and moved nothing');
    await page.keyboard.press('Escape');
    // Nor with a modifier held.
    await page.keyboard.press('Alt+j');
    await page.keyboard.press('Control+j');
    assert.equal(await focus(page), jump);

    // Esc lets go of it.
    await page.keyboard.press('Escape');
    assert.equal(await focus(page), null, 'Esc lets go of the thread');
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await page.context().close();
  }
});

test('Enter opens the focused thread, b builds it, x archives it, and g switches views', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const { page, problems } = await open('board');
  const ticket = page.locator('#thread');
  try {
    await page.keyboard.press('j');
    assert.equal(await focus(page), jump);
    await page.keyboard.press('Enter');
    await ticket.getByRole('heading', { name: 'Tighten the jump arc' }).waitFor();
    // While the ticket is open, the board's keys wait.
    await page.keyboard.press('j');
    await page.keyboard.press('b');
    assert.equal(await focus(page), jump);
    assert.equal(state(jump), 'proposed', 'b did nothing behind an open ticket');
    await page.keyboard.press('Escape');
    await ticket.waitFor({ state: 'hidden' });
    assert.equal(await focus(page), jump, 'closing the ticket leaves the focus where it was');

    // b builds what is in the backlog, and nothing else.
    await page.keyboard.press('b');
    await until('the thread is in build', () => state(jump) === 'ready');
    await page.locator('#board [data-column="build"] .card[data-id="' + jump + '"]').waitFor();
    assert.equal(await focus(page), jump, 'the focus goes with it');
    await page.keyboard.press('x');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state(jump), 'ready', 'x archives only from the backlog');

    // x archives, and the focus moves on to the card that was below it.
    await page.keyboard.press('h');
    const ids = await page.locator('#board [data-column="proposed"] .card').evaluateAll((all) => all.map((n) => n.getAttribute('data-id')));
    const gone = (await focus(page))!;
    assert.ok(ids.indexOf(gone) >= 0 && ids.indexOf(gone) < ids.length - 1, 'h comes back to a backlog card with one below it');
    await page.keyboard.press('x');
    await until('the thread is archived', () => state(gone) === 'archived');
    await page.locator('#board .card[data-id="' + gone + '"]').waitFor({ state: 'detached' });
    assert.equal(await focus(page), ids[ids.indexOf(gone) + 1], 'the focus is on the card that was below it');

    // g then l: the Backlog view, where j and k go down its rows.
    await page.keyboard.press('g');
    await page.keyboard.press('l');
    await page.locator('#backlog').waitFor();
    assert.equal(await page.locator('#board').isHidden(), true);
    await page.keyboard.press('k');
    assert.ok(await focus(page), 'a row is focused');
    await shot(page, 'keys-2-backlog');
    await page.keyboard.press('g');
    await page.keyboard.press('b');
    await page.locator('#board').waitFor();
    assert.equal(await page.locator('#backlog').isHidden(), true);
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await page.context().close();
  }
});

test('? opens a sheet of every key, and Esc closes it', async (t) => {
  if (!browser) return t.skip('no Chrome on this machine to drive');
  const { page, problems } = await open('board');
  const sheet = page.getByRole('dialog', { name: 'Keys' });
  try {
    await page.keyboard.press('?');
    await sheet.waitFor();
    for (const words of ['Open its ticket', 'Move it to Build, from the backlog', 'Archive it, from the backlog', 'Go to the Backlog', 'This list']) {
      await sheet.getByText(words).waitFor();
    }
    // Under the sheet, the board's keys wait.
    await page.keyboard.press('j');
    assert.equal(await focus(page), null);
    await shot(page, 'keys-3-sheet');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'keys-3-sheet-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await page.keyboard.press('?');
    await sheet.waitFor();
    await page.keyboard.press('?');
    await sheet.waitFor({ state: 'hidden' });
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await page.context().close();
  }
});
