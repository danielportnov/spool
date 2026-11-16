/**
 * The ticket in a real browser: the conversation, the reply box, what a thread is waiting on, and
 * an agent's live log while the page redraws under it.
 *
 * It uses the Chrome already on the machine, like test/browser.test.ts, and is skipped where
 * there is none. Set SPOOL_SHOTS to a folder for pictures of a live ticket, light and dark.
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

/** A stand-in agent: a shell script that drives the real CLI, told apart per thread. */
function agent(s: Sandbox, script: string): string {
  const file = path.join(s.root, 'agent.sh');
  fs.writeFileSync(file, `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat > /dev/null\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('the ticket: replies on Enter, says what it waits on, and a live log that holds still', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    t.skip('no Chrome on this machine to drive');
    return;
  }
  // Closed however the test ends, even where the scene fails to set up: an open browser keeps the run alive.
  t.after(() => browser.close());

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const level = s.id('task', 'A daily challenge level', '-s', 'm');
  const leaderboard = s.id('task', 'A leaderboard for the daily level', '-s', 's', '--needs', level);
  s.sp('build', leaderboard);
  const music = s.id('task', 'New music for the menu', '-s', 's');
  s.sp('build', music);
  s.sp('hold', music, '-m', 'wait until the composer sends the stems');
  const publish = s.id('task', 'Publish the beta to the store', '-s', 's');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const shipped = s.id('task', 'Pause button under the score', '-s', 'xs');
  s.sp('build', shipped);
  s.sp('start', shipped, '--as', 'Claude Fable 5.2');
  s.sp('log', shipped, 'The pause button sits under the score now, at the same size as the coin counter.', '--as', 'Claude Fable 5.2');
  s.sp('done', shipped, '-m', 'A pause button under the score; it pauses the music too.', '--as', 'Claude Fable 5.2');

  // The stand-in agent: on the publish thread it is refused a command and gives up; on the jump it works on and on.
  const worker = agent(s, [
    `if [ "$SPOOL_TASK" = "${publish}" ]; then`,
    '  echo "reading the brief"',
    `  echo '{"type":"result","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"npm publish --tag beta"}}]}'`,
    '  echo "I could not publish: the command was refused"',
    '  exit 3',
    'fi',
    'i=1; while [ $i -le 40 ]; do echo "step $i: measuring the arc"; i=$((i+1)); done',
    'while [ $i -le 400 ]; do sleep 0.25; echo "step $i: trying a gravity of 0.$i"; i=$((i+1)); done',
  ].join('\n'));
  s.sp('build', publish);

  const { child, url } = await startPage(s, 20000 + (process.pid % 1500), '--run', '--agent', worker);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const ticket = page.locator('#thread');
  // A ticket is opened the way a person opens one: from its card.
  const open = async (id: string): Promise<void> => {
    if (await ticket.isVisible()) {
      await page.keyboard.press('Escape');
      await ticket.waitFor({ state: 'hidden' });
    }
    await page.locator(`#board .card[data-id="${id}"] .title`).click();
    await ticket.locator('.key', { hasText: id }).waitFor();
  };

  try {
    await until('the publish thread is given up on', () => /agent exited 3 without finishing/.test(s.item(publish)), 300);
    s.sp('build', jump);
    await until('the jump is being built', () => s.json('show', jump).item.state === 'active', 300);

    await page.goto(url);

    // What a thread waits on is marked on its card, and said at the top of its ticket.
    const flag = (id: string): Promise<string> => page.locator(`#board .card[data-id="${id}"] .flag`).innerText();
    await until('the board knows the agent gave up', async () => (await page.locator('#board .card .flag.stuck').count()) === 1);
    assert.deepEqual(
      [await flag(coins), await flag(leaderboard), await flag(music), await flag(publish)].map((f) => f.toLowerCase()),
      ['needs you', `waiting on ${level}`, 'on hold', 'agent stopped unfinished'],
    );
    assert.equal(await page.locator(`#board .card[data-id="${jump}"] .flag`).count(), 0, 'a thread being built waits on nothing');
    await shot(page, 'board-waiting');
    const notice = ticket.locator('.notice');
    await open(coins);
    assert.match(await notice.innerText(), /^Needs you\nOutline the coins, or turn them teal\?/);
    await shot(page, 'ticket-needs-you');
    await open(music);
    assert.match(await notice.innerText(), /^On hold\nwait until the composer sends the stems/);
    await open(publish);
    const stuck = await notice.innerText();
    assert.match(stuck, /^The agent stopped without finishing\nIt exited 3\. It last said: “I could not publish: the command was refused”/);
    assert.match(stuck, /It was refused: Bash: npm publish --tag beta/);
    await shot(page, 'ticket-stuck');
    await open(leaderboard);
    assert.match(await notice.innerText(), /^Waiting on another thread\n/);
    await notice.getByRole('link', { name: /A daily challenge level/ }).click();
    await ticket.locator('.key', { hasText: level }).waitFor();
    assert.equal(await notice.count(), 0, 'the thread it waits on waits on nothing');

    // Enter posts a reply; Shift+Enter is a new line in it.
    await open(leaderboard);
    await ticket.getByPlaceholder('Post your reply').click();
    await page.keyboard.type('Top ten only.');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Friends first.');
    await page.keyboard.press('Enter');
    await until('the reply is on record', () => /> Top ten only\.\n> Friends first\.\n> — \[\[n-/.test(s.item(leaderboard)));
    await ticket.locator('.post', { hasText: 'Friends first.' }).waitFor();
    assert.equal(await ticket.getByPlaceholder('Post your reply').inputValue(), '', 'the box is empty again');

    // The live log holds still while it is read, and follows new lines only while it is at its foot.
    await open(jump);
    const log = ticket.locator('.livelog');
    await until('the log runs past its box', async () => (await log.evaluate((n) => n.scrollHeight > n.clientHeight + 100)), 300);
    const lines = (): Promise<string> => log.evaluate((n) => n.textContent ?? '');
    const atFoot = (): Promise<boolean> => log.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 8);
    const newLine = async (): Promise<void> => {
      const before = await lines();
      await until('a new line arrives', async () => (await lines()) !== before);
    };
    assert.ok(await atFoot(), 'it opens at its foot, on the latest line');
    await newLine();
    assert.ok(await atFoot(), 'and follows what is added');
    await log.evaluate((n) => { n.scrollTop = 40; (n as unknown as { mark: boolean }).mark = true; });
    await newLine();
    await newLine();
    assert.equal(await log.evaluate((n) => n.scrollTop), 40, 'scrolled up to read, it stays where it was put');
    assert.ok(await log.evaluate((n) => (n as unknown as { mark?: boolean }).mark), 'the same box, updated in place');
    await log.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await newLine();
    assert.ok(await atFoot(), 'back at its foot, it follows again');
    await shot(page, 'ticket-live');

    assert.deepEqual(problems, [], 'the page logged no errors');
  } finally {
    child.kill();
    s.cleanup();
  }
});
