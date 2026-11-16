/**
 * The small details of a ticket and a card, in a real browser: what the model boxes say.
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

  const { child, url } = await startPage(s, 19500 + (process.pid % 1500), '--agent', `${claude(s)} -p`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    child.kill();
    s.cleanup();
  }
});
