/**
 * The page's frame in a real browser: what the tab says, what shows when the server goes away,
 * the theme, and the page on a phone.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where
 * there is none. Set SPOOL_SHOTS to a folder for pictures, light and dark.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright-core';
import { CLI, Sandbox } from './helpers.ts';

const SHOTS = process.env.SPOOL_SHOTS;
const PORT = 16500 + (process.pid % 1500);

function startPage(s: Sandbox, port: number): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '--port', String(port), '-C', s.root], {
    env: { ...process.env, HOME: `${s.root}/.home`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined },
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

/** Wait for something to become true: in the spool, or on the page. */
async function until(what: string, check: () => boolean | Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function chrome(t: { skip: (why: string) => void }): Promise<Browser | null> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
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

  const { child, url } = await startPage(s, PORT);
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

    // It finished, for him to check, and another thread asks him something: two wait on him.
    assert.equal(s.exec(['done', jump, '-m', 'Snappier']).code, 0);
    s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--for', coins);
    await until('the tab counts what waits', async () => (await page.title()) === '(2) skyhop');
    assert.match(await icon(page), /#b45309[\s\S]*>2</);

    // Marked complete and answered, nothing waits, and the tab is quiet again.
    s.sp('approve', jump);
    s.sp('answer', s.json('review').questions[0].id, 'Outline');
    await until('the tab is quiet', async () => (await page.title()) === 'skyhop');
    assert.doesNotMatch(await icon(page), /circle/);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    child.kill();
    s.cleanup();
  }
});
