/**
 * The page keeping its own code current.
 *
 * A page serves the code it was started from, so work that changes Spool itself is not on the
 * page until that code is rebuilt and the page restarted. These tests run the page from a copy
 * of Spool, so that "the code on disk" can be changed under it without touching the real one.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Browser, chromium } from 'playwright-core';
import { CLI, Sandbox } from './helpers.ts';

/** A copy of Spool as a package of its own: its code in dist/, its skills, and a package.json beside them. */
function copyOfSpool(pkg: Record<string, unknown> = {}): { root: string; cli: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-copy-')));
  const repo = path.dirname(path.dirname(CLI));
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills'), path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'spool-copy', version: '9.9.9', type: 'module', ...pkg }));
  return { root, cli: path.join(root, 'dist', 'cli.ts') };
}

/** A stand-in agent: a shell script that reads its prompt and drives the real CLI. */
function agent(s: Sandbox, name: string, script: string): string {
  const file = path.join(s.root, name);
  fs.writeFileSync(file, `#!/bin/sh\nspool() { "${process.execPath}" "${CLI}" "$@"; }\ncat > /dev/null\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

interface Running {
  child: ChildProcess;
  url: string;
  /** Everything the page, and any page that took over from it, has printed. */
  out: () => string;
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
      resolve({ child, url: found[1]!, out: () => out });
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

/** Wait for something to become true. A page that is restarting is away for a moment: a look that finds nobody is tried again. */
async function until<T>(what: string, look: () => Promise<T | false | undefined | null | 0 | ''>, seconds = 30): Promise<T> {
  for (let i = 0; i < seconds * 10; i++) {
    try {
      const found = await look();
      if (found) return found;
    } catch {
      // Nobody answered; look again.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return assert.fail(`never happened: ${what}`);
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gone = (child: ChildProcess): Promise<void> => new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', () => r())));

type Board = Record<string, any>;
const boardOf = async (url: string): Promise<Board> => (await (await fetch(`${url}api/board`)).json()) as Board;
const tokenOf = async (url: string): Promise<string> => /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())![1]!;
const post = async (url: string, action: string, body: unknown): Promise<number> =>
  (await fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': await tokenOf(url) }, body: JSON.stringify(body) })).status;

test('the page restarts onto new code once no agent of its own is running, and the open page reloads itself', async () => {
  const copy = copyOfSpool();
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  s.sp('build', jump);
  // An agent that works until it is told it may finish.
  const go = path.join(s.root, 'go.txt');
  const worker = agent(s, 'worker.sh', `echo "working"\nwhile [ ! -f "${go}" ]; do sleep 0.1; done\nspool done "$SPOOL_TASK" -m "finished" > /dev/null`);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = undefined; // No Chrome on this machine: the server is still tested, the open page is not.
  }

  const page = await startPage(copy.cli, s, '--run', '--agent', worker, '--port', String(59500 + (process.pid % 1500)));
  try {
    await until('the agent is heard working', async () => (await boardOf(page.url)).runner.running[0]?.lines.length);
    const first = await boardOf(page.url);
    assert.match(first.build, /^[0-9a-f]{12}$/, 'the board names the build that serves it');
    assert.ok((await (await fetch(page.url)).text()).includes(`const BUILD = '${first.build}';`), 'and the page knows which build it came from');
    const tab = browser ? await browser.newPage() : undefined;
    if (tab) {
      await tab.goto(page.url);
      await tab.locator('#board [data-column="building"] .card').waitFor();
      assert.equal(await tab.evaluate('BUILD'), first.build);
    }

    // New code lands on disk while the agent works. The page stays as it is: a restart would end the agent.
    fs.appendFileSync(path.join(copy.root, 'dist', 'watch.ts'), '\n// built again\n');
    await pause(3500);
    const during = await boardOf(page.url);
    assert.deepEqual([during.build, during.runner.running[0]?.id, s.json('show', jump).item.state], [first.build, jump, 'active']);

    // The agent finishes. Nothing of this page's is being built, so it restarts: the same address, agents still on, the new build.
    fs.writeFileSync(go, '');
    const next = await until('the page is on the new build', async () => {
      const b = await boardOf(page.url);
      return b.build !== first.build && b;
    });
    assert.equal(s.json('show', jump).item.status, 'done');
    assert.match(next.build, /^[0-9a-f]{12}$/);
    assert.deepEqual([next.runner.on, next.runner.running, next.notice], [true, [], '']);
    assert.ok((await (await fetch(page.url)).text()).includes(`const BUILD = '${next.build}';`), 'a page loaded now is the new one');
    await until('the page that took over says where it is', async () => /Restarted on the new build: http/.test(page.out()));
    // The page the human had open is the new one too, and nobody reloaded it.
    if (tab) {
      await until('the open page reloads itself onto the new build', async () => (await tab.evaluate('BUILD')) === next.build);
      await tab.locator('#board [data-column="done"] .card', { hasText: 'Tighten the jump arc' }).waitFor();
    }

    // The page that took over builds as the one before it did.
    assert.equal(await post(page.url, 'move', { id: coins, to: 'build' }), 200);
    await until('the next thread is built', async () => s.json('show', coins).item.status === 'done');
    await until('its agent has gone', async () => !(await boardOf(page.url)).runner.running.length);
    assert.equal((await boardOf(page.url)).build, next.build, 'and with no new code, it stays as it is');

    // Stopping the process that was started stops the page that took over from it.
    page.child.kill();
    await gone(page.child);
    await assert.rejects(fetch(page.url), 'nothing is left listening');
  } finally {
    page.child.kill();
    await browser?.close();
    s.cleanup();
    fs.rmSync(copy.root, { recursive: true, force: true });
  }
});

test('Spool building Spool: once Build and Building are empty the page rebuilds it and restarts, and says so when it cannot', async (t) => {
  if (spawnSync('npm --version', { shell: true, stdio: 'ignore' }).status !== 0) {
    t.skip('no npm on this machine to run a build with');
    return;
  }
  // A checkout of Spool that is itself the project: its code in dist/, its sources in src/, and a build that makes one from the other.
  const copy = copyOfSpool({ scripts: { build: 'node build.mjs' } });
  fs.mkdirSync(path.join(copy.root, 'src'));
  fs.writeFileSync(
    path.join(copy.root, 'build.mjs'),
    [
      "import * as fs from 'node:fs';",
      "if (fs.existsSync('broken.txt')) {",
      "  console.error('src/page.ts(1,1): error TS1005: it does not compile');",
      '  process.exit(2);',
      '}',
      "fs.appendFileSync('builds.txt', 'built\\n');",
      "fs.appendFileSync('dist/watch.ts', '\\n// built again\\n');",
      '',
    ].join('\n'),
  );
  const s = new Sandbox(copy.root);
  s.sp('init', '--name', 'spool', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  const worker = agent(s, 'worker.sh', 'spool done "$SPOOL_TASK" -m "finished" > /dev/null');
  const builds = (): number => (s.exists('builds.txt') ? s.read('builds.txt').trim().split('\n').length : 0);

  const page = await startPage(copy.cli, s, '--run', '--agent', worker, '--port', String(61000 + (process.pid % 1500)));
  try {
    // Opening the page rebuilds nothing: nothing has been built that it does not already show.
    const first = await boardOf(page.url);
    await pause(2500);
    assert.deepEqual([builds(), (await boardOf(page.url)).build], [0, first.build]);

    // A thread is built. Build and Building are empty again, so Spool is rebuilt, and the page restarts onto what was built.
    assert.equal(await post(page.url, 'move', { id: jump, to: 'build' }), 200);
    const next = await until('the page is on the rebuilt code', async () => {
      const b = await boardOf(page.url);
      return b.build !== first.build && b;
    });
    assert.equal(s.json('show', jump).item.status, 'done');
    assert.deepEqual([builds(), next.runner.on, next.notice], [1, true, '']);
    await pause(2500);
    assert.equal(builds(), 1, 'built once: the page that took over does not build it again');

    // A build that fails changes nothing, and the page says why it is still the one from before.
    s.write('broken.txt', '');
    assert.equal(await post(page.url, 'move', { id: coins, to: 'build' }), 200);
    const told = await until('the page says the rebuild failed', async () => {
      const b = await boardOf(page.url);
      return /failed/.test(b.notice) && b;
    });
    assert.equal(s.json('show', coins).item.status, 'done');
    assert.match(told.notice, /^Rebuilding Spool failed \(exit \d+\), so this page is still the build from before: .*error TS1005: it does not compile$/);
    assert.deepEqual([told.build, builds()], [next.build, 1]);
  } finally {
    page.child.kill();
    await gone(page.child);
    s.cleanup();
  }
});
