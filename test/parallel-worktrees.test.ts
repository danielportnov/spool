/**
 * The page building several threads at once, each in a git worktree of its own.
 *
 * The agents are stand-ins: shell scripts that drive the real CLI from wherever the page started
 * them. Everything a test keeps of its own (the scripts, what they write down) is under the
 * sandbox's `.home`, which git is told to ignore, so the checkout stays as clean as a real one.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

/** Where a test keeps its own files: out of git's sight. */
const kept = (s: Sandbox, name: string): string => path.join(s.root, '.home', 't', name);

/** A stand-in agent: it keeps its prompt and the folder it was started in, then does `script`. */
function agent(s: Sandbox, script: string): string {
  const file = kept(s, 'agent.sh');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = [
    '#!/bin/sh',
    `spool() { "${process.execPath}" "${CLI}" "$@"; }`,
    `T="${path.dirname(file)}"`,
    'cat > "$T/prompt-$SPOOL_TASK"',
    'pwd -P > "$T/cwd-$SPOOL_TASK"',
    'echo "$SPOOL_TASK" >> "$T/runs"',
  ];
  fs.writeFileSync(file, `${[...head, script].join('\n')}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Waits until `go`, or `go-<thread>`, is there. */
const WAIT = 'while [ ! -f "$T/go" ] && [ ! -f "$T/go-$SPOOL_TASK" ]; do sleep 0.1; done';

/** A project in a git repository of its own, with something committed. */
function repo(): Sandbox {
  const s = new Sandbox();
  s.gitInit();
  fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\n');
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('physics.txt', 'gravity 9\n');
  s.commitAll('start');
  return s;
}

function settings(s: Sandbox, config: Record<string, unknown>): void {
  s.write(path.join('.home', '.config', 'spool', 'config.json'), JSON.stringify(config));
}

type Board = Record<string, any>;

interface Running {
  child: ChildProcess;
  board: () => Promise<Board>;
  post: (action: string, body: unknown) => Promise<{ status: number; text: string }>;
}

function startPage(s: Sandbox, port: number, ...args: string[]): Promise<Running> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, '--port', String(port), ...args], {
    env: { ...process.env, HOME: `${s.root}/.home`, SPOOL_ACTOR: undefined, SPOOL_AGENT: undefined, SPOOL_PAGE_RESUME: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
    child.stdout!.on('data', async (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (!found) return;
      clearTimeout(timer);
      const url = found[1]!;
      const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())![1]!;
      resolve({
        child,
        board: async () => (await (await fetch(`${url}api/board`)).json()) as Board,
        post: async (action, body) => {
          const res = await fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
          return { status: res.status, text: ((await res.json()) as { text: string }).text };
        },
      });
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

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
const running = (b: Board): string[] => b.runner.running.map((run: { id: string }) => run.id);
const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
/** The port for one test of this file: each its own, from this file's two ranges. */
const port = (base: number, n: number): number => base + ((process.pid + n * 300) % 1500);

test('three threads moved to Build are built at once, each in a worktree of its own, and land as three clean sets of commits', async () => {
  const s = repo();
  const base = s.git('rev-parse', 'HEAD');
  const ids = ['Tighten the jump arc', 'Make coins readable at sunset', 'Pause button under the score'].map((title) => s.id('task', title));
  const state = (id: string): string => s.json('show', id).item.state;
  const worker = agent(s, [WAIT, 'echo "$SPOOL_TASK" > "file-$SPOOL_TASK.txt"', 'git add -A && git commit -q -m "Add a file for $SPOOL_TASK" -m "Spool: $SPOOL_TASK"', 'spool done "$SPOOL_TASK" -m "finished" > "$T/done-$SPOOL_TASK" 2>&1'].join('\n'));
  const page = await startPage(s, port(9000, 0), '--run', '--agent', worker);
  try {
    // Nothing set: three at once, since this project can have worktrees.
    assert.equal((await page.board()).runner.parallel, 3);
    const moved = Date.now();
    for (const id of ids) assert.equal((await page.post('move', { id, to: 'build' })).status, 200);
    const busy = await until('all three are being built', async () => { const b = await page.board(); return running(b).length === 3 && ids.every((id) => read(kept(s, `cwd-${id}`))) && b; });
    assert.ok(Date.now() - moved < 5000, 'within a few seconds');
    assert.deepEqual(ids.map(state), ['active', 'active', 'active']);

    // Each in its own folder under .spool/worktrees, which the card names, and the brief tells its agent.
    for (const id of ids) {
      const dir = path.join(s.root, '.spool', 'worktrees', id);
      assert.equal(read(kept(s, `cwd-${id}`)), dir);
      assert.equal(busy.columns.building.find((c: { id: string }) => c.id === id).worktree, `.spool/worktrees/${id}`);
      const prompt = read(kept(s, `prompt-${id}`));
      assert.ok(prompt.includes(`skyhop · work in ${dir}\nWORKTREE — this thread has a checkout of its own there, on the branch spool/${id}. Work and commit only in it`), 'the brief names the worktree');
    }
    assert.equal(s.git('rev-parse', 'HEAD'), base, 'nothing reaches the checkout while they are being built');

    fs.writeFileSync(kept(s, 'go'), '');
    await until('all three are done', async () => ids.every((id) => state(id) === 'done'));
    const after = await until('the agents have gone', async () => { const b = await page.board(); return !b.runner.running.length && b; });
    assert.deepEqual(after.runner.recent.map((r: { outcome: string }) => r.outcome), ['done', 'done', 'done']);
    assert.deepEqual(after.columns.done.map((c: { id: string }) => c.id).sort(), [...ids].sort());

    // Three commits in a straight line on the checkout, one a thread, each with its trailer; nothing else left behind.
    const landed = s.git('log', '--format=%B%x00', `${base}..HEAD`).split('\0').map((m) => m.trim()).filter(Boolean);
    assert.equal(landed.length, 3);
    assert.deepEqual(landed.map((m) => /Spool: (t-\w+)$/.exec(m)?.[1]).sort(), [...ids].sort());
    assert.equal(s.git('rev-list', '--merges', 'HEAD'), '');
    assert.deepEqual(ids.map((id) => s.read(`file-${id}.txt`)), ids.map((id) => `${id}\n`));
    assert.equal(s.git('status', '--porcelain'), '');
    assert.equal(s.git('worktree', 'list').split('\n').length, 1);
    assert.equal(s.git('branch', '--list', 'spool/*'), '');
    for (const id of ids) assert.match(read(kept(s, `done-${id}`)), /landed 1 commit\(s\) on main/);
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});

test('a project with no git repository is built one thread at a time, in its own folder, and its log says why once', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const [jump, coins] = ['Tighten the jump arc', 'Make coins readable at sunset'].map((title) => s.id('task', title)) as [string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  const worker = agent(s, ['echo "working"', WAIT, 'spool done "$SPOOL_TASK" -m "finished" > /dev/null'].join('\n'));
  settings(s, { parallel: 3 });
  s.sp('build', jump, coins);
  const page = await startPage(s, port(10500, 0), '--run', '--agent', worker);
  try {
    await until('the first is being built', async () => running(await page.board()).join() === jump);
    await pause(1500);
    const one = await page.board();
    assert.deepEqual([one.runner.parallel, running(one), state(coins)], [1, [jump], 'ready'], 'one at a time, whatever parallel says');
    assert.equal(read(kept(s, `cwd-${jump}`)), s.root);
    assert.equal(one.columns.building[0].worktree, '');
    const said = /page: built in the project's own folder, not a worktree of its own: it is not a git repository, so its threads are built one at a time/g;
    assert.equal(s.item(jump).match(said)?.length, 1);

    // Stopped and carried on, it is built there again, and the log does not say it twice.
    assert.equal((await page.post('stop', { id: jump })).status, 200);
    await until('it is stopped', async () => state(jump) === 'ready' && running(await page.board()).join() === coins);
    fs.writeFileSync(kept(s, `go-${coins}`), '');
    await until('the second is done', async () => state(coins) === 'done');
    assert.equal((await page.post('move', { id: jump, to: 'building' })).status, 200);
    await until('it is built again', async () => read(kept(s, 'runs')).split('\n').filter((id) => id === jump).length === 2);
    fs.writeFileSync(kept(s, 'go'), '');
    await until('it is done', async () => state(jump) === 'done');
    assert.equal(s.item(jump).match(said)?.length, 1);
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});

test('Abort on a thread being built in a worktree leaves no worktree, no branch and no change in the checkout', async () => {
  const s = repo();
  const base = s.git('rev-parse', 'HEAD');
  const jump = s.id('task', 'Tighten the jump arc');
  const worker = agent(
    s,
    ['echo "gravity 20" > physics.txt', 'git commit -q -am "Raise gravity" -m "Spool: $SPOOL_TASK"', 'echo draft > draft.txt', 'echo "committed"', 'sleep 30'].join('\n'),
  );
  s.sp('build', jump);
  const page = await startPage(s, port(9000, 1), '--run', '--agent', worker);
  try {
    await until('the agent has committed in its worktree', async () => (await page.board()).runner.running[0]?.lines.includes('committed'));
    const dir = path.join(s.root, '.spool', 'worktrees', jump);
    assert.equal(fs.readFileSync(path.join(dir, 'physics.txt'), 'utf8'), 'gravity 20\n');
    assert.equal(s.read('physics.txt'), 'gravity 9\n');

    const abort = await page.post('abort', { id: jump });
    assert.deepEqual([abort.status, abort.text], [200, 'Stopped, and back in the backlog. What the agent changed is being undone.']);
    const after = await until('the agent is ended and its work undone', async () => { const b = await page.board(); return !b.runner.running.length && b.runner.recent[0] && b; });
    assert.equal(after.runner.recent[0].outcome, 'back in the backlog; edits undone: its worktree and branch are gone, with the 1 commit(s) made there; nothing had reached the checkout');
    assert.equal(s.json('show', jump).item.state, 'proposed');
    assert.equal(fs.existsSync(dir), false, 'no worktree');
    assert.equal(s.git('branch', '--list', 'spool/*'), '', 'no branch');
    assert.equal(s.git('worktree', 'list').split('\n').length, 1);
    assert.deepEqual([s.git('rev-parse', 'HEAD'), s.git('status', '--porcelain'), s.read('physics.txt')], [base, '', 'gravity 9\n'], 'no change in the checkout');
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});

test('Stop keeps the worktree, and Carry on builds the thread in it again', async () => {
  const s = repo();
  const jump = s.id('task', 'Tighten the jump arc');
  const worker = agent(s, ['if [ -f draft.txt ]; then echo "found my draft"; else echo draft > draft.txt; echo "drafting"; fi', 'sleep 30'].join('\n'));
  s.sp('build', jump);
  const page = await startPage(s, port(9000, 2), '--run', '--agent', worker);
  try {
    await until('the agent has left a draft', async () => (await page.board()).runner.running[0]?.lines.includes('drafting'));
    const dir = path.join(s.root, '.spool', 'worktrees', jump);
    assert.equal((await page.post('stop', { id: jump })).status, 200);
    await until('it waits in Build, stopped', async () => { const b = await page.board(); return !b.runner.running.length && b.runner.stopped.join() === jump; });
    const stopped = s.json('show', jump).item;
    assert.deepEqual([stopped.state, stopped.worktree, stopped.branch], ['ready', `.spool/worktrees/${jump}`, `spool/${jump}`]);
    assert.equal(fs.readFileSync(path.join(dir, 'draft.txt'), 'utf8'), 'draft\n', 'the worktree is kept, with what was in it');

    assert.equal((await page.post('move', { id: jump, to: 'building' })).status, 200);
    await until('it is built again, in the same worktree', async () => (await page.board()).runner.running[0]?.lines.includes('found my draft'));
    assert.equal(read(kept(s, `cwd-${jump}`)), dir);
    assert.equal(s.git('worktree', 'list').split('\n').length, 2);
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});

test('parallel 1 builds one thread at a time, still in a worktree of its own', async () => {
  const s = repo();
  const [jump, coins] = ['Tighten the jump arc', 'Make coins readable at sunset'].map((title) => s.id('task', title)) as [string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  const worker = agent(s, ['echo "working"', WAIT, 'spool done "$SPOOL_TASK" -m "finished" > /dev/null'].join('\n'));
  settings(s, { parallel: 1 });
  s.sp('build', jump, coins);
  const page = await startPage(s, port(10500, 1), '--run', '--agent', worker);
  try {
    await until('the first is being built', async () => running(await page.board()).join() === jump);
    await pause(1500);
    const one = await page.board();
    assert.deepEqual([one.runner.parallel, running(one), state(coins)], [1, [jump], 'ready']);
    assert.equal(read(kept(s, `cwd-${jump}`)), path.join(s.root, '.spool', 'worktrees', jump));
    fs.writeFileSync(kept(s, 'go'), '');
    await until('both are done', async () => state(jump) === 'done' && state(coins) === 'done');
    assert.equal(read(kept(s, `cwd-${coins}`)), path.join(s.root, '.spool', 'worktrees', coins));
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});
