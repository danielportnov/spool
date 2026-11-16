/**
 * The small details of a ticket and a card, in a real browser: what the model boxes say, and who
 * is building a thread, with what; times that read the way people say them; Markdown; and Undo on a toast.
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

function startPage(s: Sandbox, port: number, ...args: string[]): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '--port', String(port), '-C', s.root, ...args], {
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

/**
 * A stand-in for `claude`, named so the page treats it as Claude: asked to choose, it answers as
 * Fable would; asked to work, it says which session it is and works on and on.
 */
function claude(s: Sandbox): string {
  const dir = path.join(s.root, '.bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'cat > /dev/null',
    'if [ -n "$SPOOL_ROUTING" ]; then echo \'{"model": "opus", "effort": "xhigh", "why": "a small change, worth care"}\'; exit 0; fi',
    'echo \'{"type":"system","subtype":"init","session_id":"5f2c9e1a-77b0-4c1e-9a3d-0e6b2f4c8d11","model":"opus"}\'',
    'i=1; while [ $i -le 400 ]; do sleep 0.25; echo "step $i: measuring the arc"; i=$((i+1)); done',
  ].join('\n') + '\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('the details of a ticket and a card', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  t.after(() => browser.close());

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const grand = s.id('task', 'A Grand Prix mode', '-s', 'l');
  s.sp('archive', grand);
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs', '-b',
    [
      'What: outline the coins in `src/coins.ts`',
      'Why: at sunset they read as **sand**',
      'Done when: it matches https://example.com/coins.',
      '',
      'Steps:',
      '- **two pixels**, dark',
      '- see [the mockup](https://example.com/mock?a=1&b=2)',
      '',
      '1. first the sprite',
      '2. then the shader',
      '```',
      'outline(coin, 2);',
      '```',
    ].join('\n'));
  s.sp('log', coins, 'Outlined the coins in `src/coins.ts`: **two pixels**, see https://example.com/mock.', '--as', 'Claude Fable 5.2');
  const hostile = '<script>window.hacked = 1</script> [click](javascript:alert(1)) [ok](data:text/html,hi) `unbalanced <img src=x onerror="window.hacked = 2"> **open';
  s.sp('log', coins, hostile, '--as', 'Claude Fable 5.2');
  // The human's own words can run to many lines: a fence never closed among them.
  const note = s.id('capture', 'One more thing:\n```\nno end to this');
  s.sp('file', note, '--into', coins);

  const { child, url } = await startPage(s, 19500 + (process.pid % 1500), '--run', '--agent', `${claude(s)} -p`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], timezoneId: 'UTC' });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const ticket = page.locator('#thread');
  const open = async (id: string): Promise<void> => {
    if (await ticket.isVisible()) {
      await page.keyboard.press('Escape');
      await ticket.waitFor({ state: 'hidden' });
    }
    await page.locator(`#board .card[data-id="${id}"] .title`).click();
    await ticket.locator('.key', { hasText: id }).waitFor();
  };
  const field = (label: string) => ticket.locator('.side .field', { has: page.locator(`label:text-is("${label}")`) });

  try {
    await page.goto(url);
    await page.locator(`#board .card[data-id="${jump}"]`).waitFor();

    // Which model, and how hard it thinks: two boxes, each with its own label. Left alone, Fable
    // decides, and a quiet line says what the size would give.
    await open(jump);
    const model = field('Model');
    const effort = field('Effort');
    assert.equal(await model.locator('select option:checked').innerText(), 'Fable decides');
    assert.equal(await effort.locator('select option:checked').innerText(), 'Fable decides');
    assert.equal(await model.locator('.hint').innerText(), 'Its size suggests Opus');
    assert.equal(await effort.locator('.hint').innerText(), 'Its size suggests high');
    await shot(page, 'details-model');
    await model.locator('select').selectOption('sonnet');
    await until('the model is on record', () => /^model: sonnet$/m.test(s.item(jump)));
    await until('the hint goes once he picks', async () => (await model.locator('.hint').count()) === 0);
    assert.equal(await effort.locator('.hint').count(), 1, 'the effort is still left to Fable');
    await model.locator('select').selectOption('');
    await until('the model is handed back', () => !/^model: /m.test(s.item(jump)));

    // Times read the way people say them, the exact time on hover: the sandbox made the thread on
    // its own day, and the page changed it a moment ago.
    const created = field('Created').locator('time');
    // The day alone in the year it is now; the year too once it is another.
    assert.match(await created.innerText(), /^Jan 1(, 2026)?$/);
    assert.equal(await created.getAttribute('title'), await page.evaluate(`new Date(${JSON.stringify(s.json('show', jump).item.created)}).toLocaleString()`));
    await until('the edit just now shows', async () => (await field('Updated').innerText()).endsWith('just now'));

    // What agents write in Markdown shows as what it is: code, lists, bold, links out to the web.
    await open(coins);
    const post = (text: string) => ticket.locator('.post', { hasText: text }).locator('pre');
    const good = post('Outlined the coins');
    assert.equal(await good.locator('code').innerText(), 'src/coins.ts');
    assert.equal(await good.locator('strong').innerText(), 'two pixels');
    // A link's full stop is the sentence's, not the link's.
    const bare = good.locator('a');
    assert.deepEqual([await bare.getAttribute('href'), await bare.getAttribute('target'), await bare.getAttribute('rel')],
      ['https://example.com/mock', '_blank', 'noopener noreferrer']);
    // The spec's parts: one a line, and the rest with its lists and its code.
    const part = (key: string) => ticket.locator(`.desc .part.${key} pre`);
    assert.equal(await part('what').locator('code').innerText(), 'src/coins.ts');
    assert.equal(await part('why').locator('strong').innerText(), 'sand');
    assert.equal(await part('done').locator('a').getAttribute('href'), 'https://example.com/coins');
    const more = part('other');
    assert.deepEqual(await more.locator('ul > li').allInnerTexts(), ['two pixels, dark', 'see the mockup']);
    assert.equal(await more.locator('ul strong').innerText(), 'two pixels');
    assert.equal(await more.locator('a', { hasText: 'the mockup' }).getAttribute('href'), 'https://example.com/mock?a=1&b=2');
    assert.deepEqual(await more.locator('ol > li').allInnerTexts(), ['first the sprite', 'then the shader']);
    assert.equal(await more.locator('pre.code').innerText(), 'outline(coin, 2);');
    // Hostile words stay words: no tag is made of them, no link but to the web, and what does not close stays as written.
    assert.equal(await ticket.locator('script, img, a[href^="javascript"], a[href^="data"]').count(), 0);
    assert.equal(await page.evaluate('window.hacked'), undefined);
    const bad = post('window.hacked');
    assert.equal(await bad.locator('a, code, strong').count(), 0);
    assert.equal(await bad.innerText(), hostile);
    const open_ = post('One more thing');
    assert.equal(await open_.locator('pre, code').count(), 0);
    assert.equal(await open_.innerText(), 'One more thing:\n```\nno end to this');
    await shot(page, 'details-markdown');

    // Who is building it: the model and effort beside the agent's mark on its card, and on its
    // ticket the session, with the command that opens it a click from the clipboard.
    s.sp('build', jump);
    const card = page.locator(`#board [data-column="building"] .card[data-id="${jump}"]`);
    await until('Fable has chosen and the agent has its session', () => /session 5f2c9e1a/.test(s.item(jump)), 300);
    await until('the card says what it runs with', async () => (await card.locator('.ran').count()) === 1 && (await card.locator('.ran').innerText()) === 'opus · xhigh');
    assert.match((await card.locator('.ran').getAttribute('title'))!, /^Started with opus · xhigh\. Why: a small change, worth care$/);
    await open(jump);
    const working = ticket.locator('.livepost');
    await until('the ticket names the session', async () => (await working.locator('.session').count()) === 1);
    assert.equal(await working.locator('.byline .model').innerText(), 'opus · xhigh');
    assert.equal(await working.locator('.session code').innerText(), '5f2c9e1a');
    await working.locator('.session button').click();
    assert.equal(await page.evaluate('navigator.clipboard.readText()'), 'claude --resume 5f2c9e1a-77b0-4c1e-9a3d-0e6b2f4c8d11');
    assert.deepEqual([await field('Model').locator('.val').innerText(), await field('Effort').locator('.val').innerText()], ['Opus', 'xhigh']);
    await shot(page, 'details-building');
    await page.keyboard.press('Escape');
    await shot(page, 'details-building-card');

    // A move, or an archive, can be taken back from its toast for a few seconds: longer while the
    // pointer rests on it. (The agent is busy with the jump, so nothing starts on the coins.)
    const toast = page.locator('#said');
    const coinsCard = page.locator(`#board .card[data-id="${coins}"]`);
    const state = (id: string): string => s.json('show', id).item.state;
    await coinsCard.getByRole('button', { name: '▶ Build' }).click();
    await until('the coins are in build', () => state(coins) === 'ready');
    await toast.getByRole('button', { name: 'Undo' }).waitFor();
    assert.match(await toast.innerText(), /^In build: Make coins readable at sunset/);
    await shot(page, 'details-undo');
    await toast.hover();
    await page.waitForTimeout(5600);
    assert.ok(await toast.evaluate((n) => n.classList.contains('on')), 'it stays while the pointer is on it');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await until('the move is taken back', () => state(coins) === 'proposed');
    await page.locator(`#board [data-column="proposed"] .card[data-id="${coins}"]`).waitFor();
    assert.equal(await toast.locator('button').count(), 0, 'taking it back cannot itself be taken back');
    await coinsCard.getByRole('button', { name: 'Archive' }).click();
    await until('the coins are archived', () => state(coins) === 'archived');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await until('the archive is taken back', () => state(coins) === 'proposed');
    await page.mouse.move(0, 0);
    await until('the toast goes', async () => !(await toast.evaluate((n) => n.classList.contains('on'))));

    // An archived thread says when, the same way.
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    await page.getByRole('button', { name: '▸ Archived · 1' }).click();
    assert.match(await page.locator(`#archived .row[data-id="${grand}"] .right`).innerText(), /^Archived Jan 1(, 2026)?\s/);

    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    child.kill();
    s.cleanup();
  }
});
