/**
 * The Backlog view and its cards, driven in a real browser: the Why line on a card, archiving a
 * thread with one click, and bringing it back with one more. Skipped where there is no Chrome.
 * SPOOL_SHOTS=<folder> leaves a picture of each step there.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
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

const WHY = 'the jump feels floaty, and players overshoot the first gap on every level of the first world, which is where most of them quit';

test('a card says why, and a backlog thread is archived with one click and brought back with one more', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-b', `What: a shorter hang\nWhy: ${WHY}\nDone when: it feels snappy`);
  const grand = s.id('task', 'A Grand Prix mode', '-b', 'Why: players asked for it');
  const daily = s.id('task', 'A daily challenge level', '-b', 'Why: a reason to come back');
  const state = (id: string): string => s.json('show', id).item.state;

  const { child, url } = await startPage(s, 22000 + (process.pid % 1500));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const backlogCol = page.locator('#board [data-column="proposed"]');

  try {
    await page.goto(`${url}?view=board`);
    await backlogCol.waitFor();

    // The Why is one quiet line under the name: cut short on screen, whole in its title.
    const why = backlogCol.locator('.card', { hasText: 'Tighten the jump arc' }).locator('.why');
    assert.equal(await why.getAttribute('title'), WHY);
    const fit = await why.evaluate((node) => [node.scrollWidth > node.clientWidth, node.ownerDocument.defaultView!.getComputedStyle(node).textOverflow, node.getBoundingClientRect().height]);
    assert.deepEqual(fit.slice(0, 2), [true, 'ellipsis'], 'a long reason is cut with an ellipsis');
    assert.ok((fit[2] as number) < 20, 'and kept to one line');
    await shot(page, 'backlog-1-why');

    // Archived from the board, with one click: it leaves the board at once, and is kept.
    await backlogCol.locator('.card', { hasText: 'A Grand Prix mode' }).getByRole('button', { name: 'Archive' }).click();
    await until('the thread is archived', () => state(grand) === 'archived');
    await backlogCol.locator('.card', { hasText: 'A Grand Prix mode' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('#board').getByText('A Grand Prix mode').count(), 0, 'gone from the board');

    // And from a row in the Backlog view.
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    const backlog = page.locator('#backlog');
    await backlog.locator('.row', { hasText: 'A daily challenge level' }).getByRole('button', { name: 'Archive' }).click();
    await until('the second thread is archived', () => state(daily) === 'archived');

    // Archived is at the foot of the Backlog view, folded shut.
    const archived = backlog.locator('#archived');
    await archived.getByRole('button', { name: '▸ Archived · 2' }).waitFor();
    assert.equal(await archived.locator('.row').count(), 0, 'folded shut');
    assert.equal(await backlog.locator('.group').last().getAttribute('id'), 'archived', 'at the foot');
    assert.equal(await backlog.locator('.group:not(#archived) .row', { hasText: 'A Grand Prix mode' }).count(), 0, 'not in the backlog\'s lists');
    await archived.getByRole('button', { name: '▸ Archived · 2' }).click();
    assert.deepEqual(await archived.locator('.row > div:first-child > span').allInnerTexts(), ['A daily challenge level', 'A Grand Prix mode'], 'newest first');
    await shot(page, 'backlog-2-archived');

    // One click brings it back, just as it was.
    await archived.locator('.row', { hasText: 'A Grand Prix mode' }).getByRole('button', { name: '↩ Bring back' }).click();
    await until('the thread is back', () => state(grand) === 'proposed');
    await backlog.locator('.group:not(#archived) .row', { hasText: 'A Grand Prix mode' }).waitFor();
    await archived.getByRole('button', { name: '▾ Archived · 1' }).waitFor();

    // The last one back, and the section goes with it.
    await archived.getByRole('button', { name: '↩ Bring back' }).click();
    await until('the last thread is back', () => state(daily) === 'proposed');
    await archived.waitFor({ state: 'detached' });
    assert.equal(state(jump), 'proposed', 'nothing was built');
    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    await browser.close();
    child.kill();
    s.cleanup();
  }
});
