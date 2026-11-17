/**
 * Clean Up on the board: a pass over the backlog the human asks for with one button. Headless, the
 * page starts an agent on it; in Chat mode the chat that builds hears of it from `spool watch`.
 * Either way the pass proposes every drop and archive, and only a yes on its thread drops anything.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { changes } from '../src/watch.ts';
import { CLI, Sandbox, startPage, until } from './helpers.ts';
import { spool } from './helpers.ts';
import { chrome } from './tip-sandbox.ts';

/** A stand-in agent for the pass: it reads its prompt, proposes one drop, and ends the pass. */
function passAgent(s: Sandbox, target: string): string {
  const file = path.join(s.root, 'manager.sh');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat "$1" > "${path.join(s.root, 'pass-prompt.txt')}"\necho "$SPOOL_RUN" > "${path.join(s.root, 'pass-run.txt')}"\n` +
      `spool manage --propose drop ${target} -m "A repeat of the first one" > /dev/null\nspool manage --end -m "Tidied: 1 proposal for you" > /dev/null\n`,
  );
  fs.chmodSync(file, 0o755);
  return `${file} {prompt_file}`;
}

test('headless, Clean Up starts a pass whose drop waits for a yes; pressed again, it leads to what waits', async () => {
  const s = spool();
  s.id('task', 'Tighten the jump arc');
  const twice = s.id('task', 'Tighten the jump arc again');
  const page = await startPage(s, '--agent', passAgent(s, twice));
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const post = async (action: string, body: unknown) =>
    (await (await fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  try {
    assert.deepEqual((await board()).cleanup, { open: null, asked: null, leave: null, waiting: null });
    // Pressed with Agents off: the human asked for this one run, so it starts all the same.
    const started = await post('cleanup', {});
    assert.equal(started.ok, true, started.text);
    assert.match(started.text, /Clean-up started/);
    const run = started.id as string;
    assert.match(run, /^t-\w+$/);
    await until('the pass has ended', () => s.json('show', run).item.status === 'done');
    const prompt = fs.readFileSync(path.join(s.root, 'pass-prompt.txt'), 'utf8');
    assert.match(prompt, /tidying the backlog[\s\S]*The manager[\s\S]*YOUR PASS[\s\S]*Asked for with Clean Up on the board\. Every drop and every archive goes on this thread as a proposal/);
    assert.equal(fs.readFileSync(path.join(s.root, 'pass-run.txt'), 'utf8').trim(), run, 'every command of the agent is part of the run');
    assert.match(s.item(run), /asked for with Clean Up on the board by human/);

    // Nothing is dropped on the pass's say: it waits on the run's thread, and the button leads there.
    assert.notEqual(s.json('show', twice).item.status, 'dropped');
    const after = await until('the board says a proposal waits', async () => { const b = await board(); return b.cleanup.waiting && b; });
    assert.deepEqual(after.cleanup, { open: null, asked: null, leave: null, waiting: { id: run, count: 1 } });

    // A yes drops it, with the reason.
    assert.equal((await post('proposal', { id: run, n: 1, said: 'yes' })).ok, true);
    assert.match(s.sp('show', twice), /dropped: A repeat of the first one/);
    assert.equal((await board()).cleanup.waiting, null);
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('in Chat mode Clean Up asks the chat: spool watch says so, and the pass that answers takes the request up', async () => {
  const s = spool();
  s.id('task', 'Tighten the jump arc');
  const page = await startPage(s, '--agent', 'false');
  const board = async () => (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
  const post = async (action: string, body: unknown) =>
    (await (await fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify(body) })).json()) as Record<string, any>;
  try {
    assert.equal((await post('builder', { builder: 'chat' })).ok, true);
    const asked = await post('cleanup', { words: 'tidy it, I look in the morning' });
    assert.equal(asked.ok, true);
    assert.match(asked.text, /No chat is watching this project: say \/spool-loop/);
    assert.equal(asked.id, undefined, 'no pass is open yet');
    const b = await board();
    assert.ok(b.cleanup.asked, 'the request waits');
    // Their words are a leave for tonight that allows tidying only.
    assert.equal(b.cleanup.leave, 'tidy it, I look in the morning');
    assert.match(s.sp('leave'), /tidy only/);
    // Asked twice, it is one request.
    assert.equal((await post('cleanup', {})).ok, true);

    // The line the chat is woken by, once, as it is asked.
    const at = (cleanup?: Map<string, string>) => ({ ready: new Map(), said: new Map(), inbox: new Set<string>(), asks: new Map(), cleanup });
    const line = `cleanup: demo — they pressed Clean Up on the board: "tidy it, I look in the morning". Run the pass by spool prime manager, every drop and archive a proposal, and reply with the run's link`;
    assert.deepEqual(changes(at(), at(new Map([['demo', line]])), () => '', () => ''), [line]);
    assert.deepEqual(changes(at(new Map([['demo', line]])), at(new Map([['demo', line]])), () => '', () => ''), []);

    // The chat runs the pass: its worksheet says what such a pass must do, and the request is gone.
    const sheet = s.sp('manage', '--start', '--as', 'Chat');
    assert.match(sheet, /Asked for with Clean Up on the board\. Every drop and every archive goes on this thread as a proposal, your own suggestions too/);
    assert.match(sheet, /What they wrote with it: "tidy it, I look in the morning"/);
    const run = /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!;
    assert.deepEqual({ ...(await board()).cleanup, leave: null }, { open: run, asked: null, leave: null, waiting: null });

    // Pressed while the pass is open: its thread, not a second pass.
    const again = await post('cleanup', {});
    assert.deepEqual([again.ok, again.id], [true, run]);
    assert.ok(!s.exists('.spool/cleanup.json'));
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('a pass nobody asked for from the board says nothing of Clean Up', () => {
  const s = spool();
  try {
    s.id('task', 'Tighten the jump arc');
    assert.doesNotMatch(s.sp('manage', '--start', '--as', 'Mgr'), /Clean Up/);
  } finally {
    s.cleanup();
  }
});

test('on the page: the backlog has Clean Up, its form takes their words, and the button then says it was asked for', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  // With the gate, a new thread waits in the backlog, where Clean Up is.
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.id('task', 'Tighten the jump arc');
  const page = await startPage(s, '--agent', 'false');
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await tab.goto(`${page.url}?view=board`);
    await tab.locator('#board .col[data-column="proposed"] .cleanup', { hasText: 'Clean Up' }).click();
    await tab.locator('#board .cleaning input').fill('tidy it');
    // Chat picked: the request waits for the chat, and nothing is started.
    await fetch(`${page.url}api/builder`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': page.token }, body: JSON.stringify({ builder: 'chat' }) });
    await tab.locator('#board .cleaning button.go').click();
    await tab.locator('#board .cleanup', { hasText: 'Clean Up asked for' }).waitFor();
    assert.equal(JSON.parse(s.read('.spool/cleanup.json')).words, 'tidy it');
    await tab.goto(`${page.url}?view=backlog`);
    await tab.locator('#backlog .cleanup', { hasText: 'Clean Up asked for' }).waitFor();
  } finally {
    await browser.close();
    await page.stop();
    s.cleanup();
  }
});
