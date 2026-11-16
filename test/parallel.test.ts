/**
 * The page building several threads at once.
 *
 * How many is `parallel` in the user's own config, which these tests write into the sandbox's
 * home. The agents are stand-ins: each says which thread it is on, then works until a file
 * tells it that it may finish, so a test can hold several at work for as long as it needs.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, chromium } from 'playwright-core';
import { CLI, Sandbox } from './helpers.ts';

/** A stand-in agent that works on its thread until `go`, or `go-<thread>`, is in the sandbox; then it finishes it. */
function worker(s: Sandbox): string {
  const file = path.join(s.root, 'worker.sh');
  const script = [
    '#!/bin/sh',
    `spool() { "${process.execPath}" "${CLI}" "$@"; }`,
    'cat > /dev/null',
    `echo "$SPOOL_TASK" >> "${path.join(s.root, 'runs.txt')}"`,
    'echo "working on $SPOOL_TASK"',
    `while [ ! -f "${path.join(s.root, 'go')}" ] && [ ! -f "${path.join(s.root, 'go')}-$SPOOL_TASK" ]; do sleep 0.1; done`,
    'spool done "$SPOOL_TASK" -m "finished" > /dev/null',
  ];
  fs.writeFileSync(file, `${script.join('\n')}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** The user's own settings, as the page reads them: tests run it with the sandbox's `.home` as HOME. */
function settings(s: Sandbox, config: Record<string, unknown>): void {
  s.write(path.join('.home', '.config', 'spool', 'config.json'), JSON.stringify(config));
}

type Board = Record<string, any>;

interface Running {
  child: ChildProcess;
  url: string;
  board: () => Promise<Board>;
  post: (action: string, body: unknown) => Promise<{ status: number; text: string }>;
}

function startPage(cli: string, s: Sandbox, ...args: string[]): Promise<Running> {
  const child = spawn(process.execPath, [cli, 'page', '--no-open', '-C', s.root, ...args], {
    env: { ...process.env, HOME: `${s.root}/.home`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined, SPOOL_PAGE_RESUME: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (!found) return;
      clearTimeout(timer);
      const url = found[1]!;
      resolve({
        child,
        url,
        board: async () => (await (await fetch(`${url}api/board`)).json()) as Board,
        // The token is read each time: a page that restarted hands out a new one.
        post: async (action, body) => {
          const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())![1]!;
          const res = await fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
          return { status: res.status, text: ((await res.json()) as { text: string }).text };
        },
      });
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

/** Wait for something to become true. A page that is restarting is away for a moment: a look that finds nobody is tried again. */
async function until<T>(what: string, look: () => Promise<T | false | undefined | null | 0 | ''>, seconds = 20): Promise<T> {
  for (let i = 0; i < seconds * 20; i++) {
    try {
      const found = await look();
      if (found) return found;
    } catch {
      // Nobody answered; look again.
    }
    await pause(50);
  }
  return assert.fail(`never happened: ${what}`);
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gone = (child: ChildProcess): Promise<void> => new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', () => r())));
/** Which threads the page's agents are on, in the order they were started. */
const running = (b: Board): string[] => b.runner.running.map((run: { id: string }) => run.id);

/** The Chrome on this machine, where there is one: what a test checks on the open page is skipped without it. */
async function chrome(): Promise<Browser | undefined> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return undefined;
  }
}

test('with parallel 3, three threads moved to Build are built at once, each by an agent of its own, and each lands in Done', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const [jump, coins, score, mute] = ['Tighten the jump arc', 'Make coins readable at sunset', 'Pause button under the score', 'Mute in settings'].map((title) => s.id('task', title)) as [string, string, string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  settings(s, { parallel: 3 });
  const browser = await chrome();
  const page = await startPage(CLI, s, '--run', '--agent', worker(s), '--port', String(33000 + (process.pid % 1500)));
  try {
    assert.deepEqual([(await page.board()).runner.parallel, (await page.board()).runner.running], [3, []]);

    // Three threads moved to Build, one after another: three agents, all at work at the same time.
    for (const id of [jump, coins, score]) assert.equal((await page.post('move', { id, to: 'build' })).status, 200);
    const busy = await until('three agents are heard working', async () => {
      const b = await page.board();
      return b.runner.running.length === 3 && b.runner.running.every((run: { lines: string[] }) => run.lines.length) && b;
    });
    assert.deepEqual(
      busy.runner.running.map((run: { id: string; lines: string[] }) => [run.id, run.lines]),
      [jump, coins, score].map((id) => [id, [`working on ${id}`]]),
      'each run says what its own agent is doing',
    );
    assert.deepEqual([jump, coins, score].map(state), ['active', 'active', 'active']);
    assert.deepEqual(busy.columns.building.map((c: { thread: { by: string } }) => c.thread.by), ['worker.sh', 'worker.sh', 'worker.sh']);

    // The open page says how many, and each card in Building shows its own agent's line.
    const tab = browser ? await browser.newPage() : undefined;
    if (tab) {
      await tab.goto(page.url);
      const lines = tab.locator('#board [data-column="building"] .card .live .now');
      await lines.nth(2).waitFor();
      assert.deepEqual((await lines.allInnerTexts()).sort(), [jump, coins, score].map((id) => `working on ${id}`).sort());
      assert.equal(await tab.locator('#runner').innerText(), '● Agents: building 3');
      assert.match((await tab.locator('#runner').getAttribute('title'))!, /on up to 3 threads at once\./);
    }

    // A fourth waits in Build: there is room for three.
    assert.equal((await page.post('move', { id: mute, to: 'build' })).status, 200);
    await pause(1500);
    assert.deepEqual([state(mute), running(await page.board())], ['ready', [jump, coins, score]]);

    // One finishes by itself, and the thread that waited takes its place while the other two work on.
    s.write(`go-${coins}`, '');
    await until('the finished thread is done and the waiting one is being built', async () => state(coins) === 'done' && running(await page.board()).join() === [jump, score, mute].join());
    assert.deepEqual([jump, score, mute].map(state), ['active', 'active', 'active']);
    if (tab) await until('the open page shows the thread in Done', async () => (await tab.locator('#board [data-column="done"] .card').count()) === 1);

    // The rest finish, each on its own.
    s.write('go', '');
    await until('every thread is done', async () => [jump, coins, score, mute].every((id) => state(id) === 'done'));
    const after = await until('the agents have gone', async () => { const b = await page.board(); return !b.runner.running.length && b; });
    assert.deepEqual(after.runner.recent.map((r: { outcome: string }) => r.outcome), ['done', 'done', 'done', 'done']);
    assert.deepEqual(s.read('runs.txt').trim().split('\n').sort(), [jump, coins, score, mute].sort(), 'each thread was built once');
  } finally {
    page.child.kill();
    await browser?.close();
    s.cleanup();
  }
});

test('one thread at a time unless the user says more; a thread dragged into Building is the next one taken', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const [jump, coins, score] = ['Tighten the jump arc', 'Make coins readable at sunset', 'Pause button under the score'].map((title) => s.id('task', title)) as [string, string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  s.sp('build', jump, coins);
  const page = await startPage(CLI, s, '--run', '--agent', worker(s), '--port', String(34500 + (process.pid % 1500)));
  try {
    // Nothing set: one agent, and the second thread waits behind it.
    await until('the first thread is being built', async () => running(await page.board()).join() === jump);
    await pause(1500);
    const one = await page.board();
    assert.deepEqual([one.runner.parallel, running(one), state(coins)], [1, [jump], 'ready']);

    // Dragged into Building while the agent is busy: it is next, ahead of what was in Build before it.
    const dragged = await page.post('move', { id: score, to: 'building' });
    assert.deepEqual([dragged.status, dragged.text], [200, 'Next up, once an agent is free: Pause button under the score']);
    assert.equal(state(score), 'ready');
    s.write(`go-${jump}`, '');
    await until('the dragged thread is built next', async () => running(await page.board()).join() === score);
    assert.deepEqual([state(jump), state(coins)], ['done', 'ready']);

    // The setting is read fresh: raised while the page runs, the waiting thread starts beside the other.
    settings(s, { parallel: 2 });
    await until('both are being built', async () => running(await page.board()).join() === [score, coins].join());
    s.write('go', '');
    await until('every thread is done', async () => [jump, coins, score].every((id) => state(id) === 'done'));
  } finally {
    page.child.kill();
    s.cleanup();
  }
});

test('the page does not restart onto new code until every one of its agents has gone', async () => {
  // The page is run from a copy of Spool, so that the code on disk can be changed under it.
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-copy-')));
  const repo = path.dirname(path.dirname(CLI));
  fs.cpSync(path.join(repo, 'src'), path.join(copy, 'dist'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills'), path.join(copy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'spool-copy', version: '9.9.9', type: 'module' }));

  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const [jump, coins] = ['Tighten the jump arc', 'Make coins readable at sunset'].map((title) => s.id('task', title)) as [string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  s.sp('build', jump, coins);
  settings(s, { parallel: 2 });
  const page = await startPage(path.join(copy, 'dist', 'cli.ts'), s, '--run', '--agent', worker(s), '--port', String(36000 + (process.pid % 1500)));
  try {
    await until('both threads are being built', async () => running(await page.board()).length === 2);
    const first = (await page.board()).build;
    assert.match(first, /^[0-9a-f]{12}$/);

    // New code lands while two agents work, and one of them finishes. The other is still at it, so the page stays as it is.
    fs.appendFileSync(path.join(copy, 'dist', 'watch.ts'), '\n// built again\n');
    s.write(`go-${jump}`, '');
    await until('the first agent has gone', async () => state(jump) === 'done' && running(await page.board()).join() === coins);
    await pause(3500);
    const during = await page.board();
    assert.deepEqual([during.build, running(during), state(coins)], [first, [coins], 'active']);

    // The last agent goes, and the page restarts onto the new build with nothing lost.
    s.write('go', '');
    const next = await until('the page is on the new build', async () => { const b = await page.board(); return b.build !== first && b; }, 30);
    assert.deepEqual([state(coins), next.runner.on, next.runner.running, next.runner.parallel], ['done', true, [], 2]);
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
