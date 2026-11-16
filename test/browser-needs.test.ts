/**
 * What waits on the human, done from the thread it is about, in a real browser.
 *
 * The page has no view of its own for it: a plan's go-ahead, a skill an agent
 * wrote and a question's answer in his own words are all on the thread's ticket.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { type Browser, chromium } from 'playwright-core';
import { CLI, Sandbox } from './helpers.ts';

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

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`never happened: ${what}`);
}

test('a plan, a new skill and a question are each settled on their own thread', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  // A plan, written and handed in, with a part that waits for the go-ahead.
  const plan = s.id('plan', 'Add online multiplayer', '-s', 'xl');
  s.sp('start', plan);
  const lobby = s.id('task', 'Lobby screen', '--from', plan, '--needs', plan, '-s', 's');
  assert.equal(s.exec(['done', plan, '-m', 'Lobby first', '--report', '-'], { stdin: '# Multiplayer\n\n1. Lobby\n' }).code, 0);
  // A thread that taught an agent a skill, and asks a question.
  const pause = s.id('task', 'Pause button under the score', '-s', 'xs', '--hold', 'not yet');
  const taught = s.exec(['skill', 'add', 'pause-menus', '-d', 'How this game pauses: use when adding a menu.', '--from', pause, '-b', '-'], { stdin: '1. Freeze the clock.\n' });
  assert.equal(taught.code, 0, taught.err);
  const skill = JSON.parse(s.sp('list', '-k', 'skill', '--json')).items[0].id as string;
  s.sp('ask', 'Pause on the left, or the right?', '--option', 'Left', '--option', 'Right', '--for', pause);

  const { child, url } = await startPage(s, 26500 + (process.pid % 1500));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const ticket = page.locator('#thread');
  const card = (title: string) => page.locator('#board .card', { hasText: title });

  try {
    // A link to the view that is gone, or a page that remembers it, opens on the board.
    await page.goto(url + '?view=needs');
    await card('Lobby screen').waitFor();
    assert.deepEqual(await page.locator('.tab').allInnerTexts(), ['Board', 'Backlog']);
    await page.evaluate(() => localStorage.setItem('spool-view', 'needs'));
    await page.goto(url);
    await card('Lobby screen').waitFor();
    assert.equal(await page.locator('#board').isVisible(), true);

    // The plan's card says it waits for him, and its ticket is where he gives the go-ahead.
    await page.locator('#board [data-column="done"] .card', { hasText: 'Add online multiplayer' }).getByText('Waiting for your go-ahead').waitFor();
    await page.locator('#board [data-column="done"] .card', { hasText: 'Add online multiplayer' }).locator('.title').click();
    await ticket.getByRole('button', { name: '✓ Go ahead with the plan' }).click();
    await until('the plan has its go-ahead', () => !!s.json('show', plan).item.reviewed);
    await until('its part is free', () => s.json('show', lobby).item.state !== 'blocked');
    await page.keyboard.press('Escape');

    // The skill the thread taught is on its card as something to look at, and kept from its ticket.
    await card('Pause button under the score').locator('.chip', { hasText: '🧾 1 to look at' }).click();
    const wrote = ticket.locator('.post', { hasText: '📘 Wrote a new skill' });
    await wrote.getByText('pause-menus').waitFor();
    await wrote.getByRole('button', { name: 'Keep' }).click();
    await until('the skill is kept', () => !!s.json('show', skill).item.reviewed);
    await wrote.waitFor({ state: 'detached' });

    // A question is answered on the ticket in his own words, as well as with its options.
    const asked = ticket.locator('.post', { hasText: 'Pause on the left, or the right?' });
    await asked.getByPlaceholder('Or say what you want').fill('in the middle');
    await asked.getByRole('button', { name: 'Answer' }).click();
    await until('the question is answered in his words', () => s.json('review').questions.length === 0);
    await page.keyboard.press('Escape');

    // Nothing is left about no thread, so the backlog has no strip.
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    await page.locator('#backlog .group').first().waitFor();
    assert.equal(await page.locator('#backlog .group.waiting').count(), 0);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    child.kill();
    s.cleanup();
  }
});
