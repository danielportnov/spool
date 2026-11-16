/**
 * A page started at a folder of projects builds several threads at once across them: the user's
 * number is for the whole page, a git project's threads each get a worktree, and a project with
 * no git is built one thread at a time in its own folder. Each board says what its project gets.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, pause, startPage, until } from './helpers.ts';

type Board = Record<string, any>;

test('a page over a folder of projects builds three at once across them, and one at a time where there is no git', async () => {
  // The top folder is no git repository, as the owner's is; two projects below it are, and one is not.
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const repo = (name: string): Sandbox => {
    const p = s.cd(name);
    p.gitInit();
    p.sp('init', '--name', name);
    p.write('readme.txt', `${name}\n`);
    p.commitAll('start');
    return p;
  };
  const tips = repo('tips');
  const notes = repo('notes');
  const site = s.cd('site');
  site.sp('init', '--name', 'site');

  // A stand-in agent: it writes down where it was started and when it began and ended, and waits for its go.
  const t = path.join(s.root, '.home', 't');
  fs.mkdirSync(t, { recursive: true });
  const agent = path.join(t, 'agent.sh');
  fs.writeFileSync(
    agent,
    [
      '#!/bin/sh',
      `T="${t}"`,
      'cat > /dev/null',
      'pwd -P > "$T/cwd-$SPOOL_TASK"',
      'echo "start $SPOOL_TASK" >> "$T/log"',
      'while [ ! -f "$T/go" ] && [ ! -f "$T/go-$SPOOL_TASK" ]; do sleep 0.1; done',
      'echo "end $SPOOL_TASK" >> "$T/log"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(agent, 0o755);
  const go = (id: string): void => fs.writeFileSync(path.join(t, `go-${id}`), '');
  const cwd = (id: string): string => fs.readFileSync(path.join(t, `cwd-${id}`), 'utf8').trim();

  const [tip1, tip2] = ['Round the tip', 'Split by three'].map((title) => tips.id('task', title));
  const [note1, note2] = ['Pin a note', 'Search notes'].map((title) => notes.id('task', title));
  const [site1, site2] = ['A contact page', 'A footer'].map((title) => site.id('task', title));
  for (const [p, id] of [[tips, tip1], [tips, tip2], [notes, note1], [notes, note2]] as const) p.sp('build', id!);

  const page = await startPage(s, '--run', '--agent', agent);
  try {
    const board = async (project: string): Promise<Board> => (await (await fetch(`${page.url}api/board?project=${project}`)).json()) as Board;
    const running = async (): Promise<string[]> => (await Promise.all(['tips', 'notes', 'site'].map(board))).flatMap((b) => b.runner.running.map((r: { id: string }) => r.id));

    // What each project will really get from this page: the total where it can have worktrees, one where it cannot.
    assert.deepEqual(await Promise.all(['tips', 'notes', 'site'].map(async (p) => (await board(p)).runner.parallel)), [3, 3, 1]);

    // Three at once across the two git projects, and no fourth: the user's number is for the whole page.
    const first = await until('three agents at work', async () => {
      const now = await running();
      return now.length === 3 && now;
    });
    await pause(1500);
    assert.deepEqual((await running()).sort(), [...first].sort(), 'no more than three at once');
    const roots = new Set([tips.dir, notes.dir].map((d) => fs.realpathSync(d)));
    const folders = first.map(cwd);
    assert.equal(new Set(folders).size, 3, 'each in a folder of its own');
    for (const f of folders) assert.ok(!roots.has(f), `${f} is a worktree, not the project's own folder`);

    // The project with no git gets threads too, and builds them one at a time in its own folder.
    site.sp('build', site1!);
    site.sp('build', site2!);
    for (const id of first.slice(0, 2)) go(id);
    const second = await until('the site has an agent at work', async () => {
      const now = await running();
      return now.some((id) => id === site1 || id === site2) && now;
    });
    await pause(2000);
    const now = await running();
    assert.equal(now.filter((id) => id === site1 || id === site2).length, 1, `one of the site's at a time: ${now.join(' ')}`);
    assert.equal(now.length, 3, 'the page is full again: the third slot went to the last git thread');
    const onSite = second.find((id) => id === site1 || id === site2)!;
    assert.equal(cwd(onSite), fs.realpathSync(site.dir), 'built in the site\'s own folder');

    // Once that one is over, the site's other thread starts.
    go(onSite);
    const other = onSite === site1 ? site2! : site1!;
    await until('the site\'s other thread is at work', async () => (await running()).includes(other));
    fs.writeFileSync(path.join(t, 'go'), '');
    await until('every agent is done', async () => (await running()).length === 0);

    // Never two of the site's at once, from what the agents wrote down.
    let atOnce = 0;
    let most = 0;
    for (const line of fs.readFileSync(path.join(t, 'log'), 'utf8').trim().split('\n')) {
      const [word, id] = line.split(' ');
      if (id !== site1 && id !== site2) continue;
      atOnce += word === 'start' ? 1 : -1;
      most = Math.max(most, atOnce);
    }
    assert.equal(most, 1);
  } finally {
    fs.writeFileSync(path.join(t, 'go'), '');
    await page.stop();
    s.cleanup();
  }
});
