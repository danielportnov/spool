/**
 * The page keeping its own code current while several agents build at once.
 *
 * With room for more than one, a finished thread makes room for the next, and a moment with no
 * agent at work might never come. So once new code is on disk the page starts nothing new, lets
 * the agents at work finish, then restarts onto it. The page is run from a copy of Spool, so that
 * the code on disk can be changed under it, as in test/upkeep.test.ts.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, pause, startPage, until } from './helpers.ts';

function copyOfSpool(): { root: string; cli: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-copy-')));
  const repo = path.dirname(path.dirname(CLI));
  fs.cpSync(path.join(repo, 'src'), path.join(root, 'dist'), { recursive: true });
  fs.cpSync(path.join(repo, 'skills'), path.join(root, 'skills'), { recursive: true });
  fs.cpSync(path.join(repo, 'rules'), path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'spool-copy', version: '9.9.9', type: 'module' }));
  return { root, cli: path.join(root, 'dist', 'cli.ts') };
}

type Board = Record<string, any>;
const boardOf = async (url: string): Promise<Board> => (await (await fetch(`${url}api/board`)).json()) as Board;
const running = (b: Board): string[] => b.runner.running.map((run: { id: string }) => run.id);

test('with new code on disk, the page starts nothing new, lets its agents finish, then restarts onto it', async () => {
  const copy = copyOfSpool();
  const s = new Sandbox();
  s.gitInit();
  fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\n');
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('README.md', 'Sky Hop\n');
  s.commitAll('start');
  const [jump, coins, score] = ['Tighten the jump arc', 'Make coins readable at sunset', 'Pause button under the score'].map((title) => s.id('task', title)) as [string, string, string];
  const state = (id: string): string => s.json('show', id).item.state;
  s.write(path.join('.home', '.config', 'spool', 'config.json'), JSON.stringify({ parallel: 2 }));
  // Works until `go-<thread>` is there, then finishes.
  const t = path.join(s.root, '.home', 't');
  fs.mkdirSync(t, { recursive: true });
  const worker = path.join(t, 'worker.sh');
  fs.writeFileSync(
    worker,
    [
      '#!/bin/sh',
      `spool() { "${process.execPath}" "${CLI}" "$@"; }`,
      'cat > /dev/null',
      `echo "$SPOOL_TASK" >> "${t}/runs"`,
      'echo "working"',
      `while [ ! -f "${t}/go-$SPOOL_TASK" ]; do sleep 0.1; done`,
      'spool done "$SPOOL_TASK" -m "finished" > /dev/null',
      '',
    ].join('\n'),
  );
  fs.chmodSync(worker, 0o755);
  const runs = (): string[] => (fs.existsSync(path.join(t, 'runs')) ? fs.readFileSync(path.join(t, 'runs'), 'utf8').trim().split('\n') : []);
  s.sp('build', jump, coins, score);

  const page = await startPage({ sandbox: s, cli: copy.cli }, '--run', '--agent', worker);
  try {
    await until('two are being built', async () => running(await boardOf(page.url)).join() === [jump, coins].join());
    const first = (await boardOf(page.url)).build;

    // New code lands, and one agent finishes. There is room for the third, but it is not started: the page is draining.
    fs.appendFileSync(path.join(copy.root, 'dist', 'watch.ts'), '\n// built again\n');
    // The page has seen it before the agent finishes: from then on it starts nothing.
    await until('the page sees the new build', async () => /^A new build of Spool is on disk/.test((await boardOf(page.url)).notice));
    fs.writeFileSync(path.join(t, `go-${jump}`), '');
    await until('the first is done and its agent gone', async () => state(jump) === 'done' && running(await boardOf(page.url)).join() === coins);
    await pause(2500);
    const during = await boardOf(page.url);
    assert.deepEqual([during.build, running(during), state(score), runs().sort()], [first, [coins], 'ready', [jump, coins].sort()]);
    assert.match(during.notice, /^A new build of Spool is on disk\. Nothing new is started until the agents at work now have finished; then this page restarts onto it\.$/);

    // The last agent goes: the page restarts onto the new build, and that one takes the third.
    fs.writeFileSync(path.join(t, `go-${coins}`), '');
    fs.writeFileSync(path.join(t, `go-${score}`), '');
    const next = await until('the page is on the new build', async () => { const b = await boardOf(page.url); return b.build !== first && b; });
    assert.equal(next.notice, '');
    await until('the third is built by the page that took over', async () => state(score) === 'done');
    assert.deepEqual(runs().slice(2), [score], 'built once, after the others');
  } finally {
    await page.stop();
    s.cleanup();
    fs.rmSync(copy.root, { recursive: true, force: true });
  }
});

test('Spool rebuilding itself never reads a thread’s worktree: the build and the check look only in src and test', () => {
  // A worktree is a whole checkout, sources and all, kept at .spool/worktrees/<id> inside the project.
  const repo = path.dirname(path.dirname(CLI));
  const build = JSON.parse(fs.readFileSync(path.join(repo, 'tsconfig.build.json'), 'utf8')) as { include: string[] };
  const check = JSON.parse(fs.readFileSync(path.join(repo, 'tsconfig.json'), 'utf8')) as { include: string[] };
  assert.deepEqual(build.include, ['src']);
  assert.deepEqual(check.include, ['src', 'test']);
});
