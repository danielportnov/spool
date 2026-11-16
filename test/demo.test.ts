import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { Sandbox } from './helpers.ts';

test('spool demo makes a sample project with a full board, and its sample runs', () => {
  const s = new Sandbox();
  try {
    const out = s.sp('demo', 'tips');
    const dir = path.join(s.root, 'tips');
    assert.match(out, new RegExp(`A demo project is ready: ${dir}`));
    assert.match(out, /spool page -C /);
    assert.match(out, /press play on the sprint "First round"/);
    assert.match(out, /Agents build only what is in Build/);
    assert.match(out, new RegExp(`rm -rf ${dir}`));

    // A git repository with one first commit, the spool ignored and nothing left over.
    const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(git('log', '--format=%s'), 'A bill splitter, with its test');
    assert.equal(git('status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(dir, '.spool', 'config.json')));

    // The sample is real: its test passes, and the program runs, rough edges and all.
    // Run as a person would run it, not as a part of this test run.
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
    const tested = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    assert.match(tested.stdout, /pass 2/);
    const ran = spawnSync(process.execPath, ['tip.js', '84.50', '3', '18'], { cwd: dir, encoding: 'utf8' });
    assert.equal(ran.stdout, 'Total with tip: 99.71\nEach of 3 pays: 33.24\n');
    assert.match(spawnSync(process.execPath, ['tip.js'], { cwd: dir, encoding: 'utf8' }).stdout, /NaN/, 'the bug its first thread fixes');

    // The board has something in every place a newcomer should see.
    const ws = Workspace.open(dir, () => new Date());
    let b;
    try {
      b = board(ws);
    } finally {
      ws.close();
    }
    assert.equal(b.project, 'tip-splitter');
    assert.equal(b.gate, true, 'agents build only what is moved to Build');
    const titles = (column: keyof typeof b.columns) => b.columns[column].map((c) => c.title);
    assert.ok(titles('proposed').includes('Say how to use it when the numbers are missing'));
    assert.ok(titles('proposed').includes('Read the README as someone who has never seen this project'));
    const ready = b.columns.build.find((c) => c.title === 'Accept a tip written with a percent sign');
    assert.ok(ready && !ready.question, 'one is ready to build now');
    const waiting = b.columns.build.find((c) => c.title === 'Make the shares add up to the bill');
    assert.equal(waiting?.question?.options.length, 2, 'one waits on a question with two options');
    assert.deepEqual(titles('done').sort(), ['Make it a page that works on a phone', 'Round each share to the cent']);
    assert.ok(b.columns.done.every((c) => c.note.includes(' · ')), 'each finished thread says what it did');
    assert.equal(b.columns.building.length, 0);
    const [sprint] = b.sprints;
    assert.deepEqual([b.sprints.length, sprint?.name, sprint?.total, sprint?.waiting], [1, 'First round', 3, 3]);
    assert.match(sprint?.goal ?? '', /never prints nonsense/);

    // Every thread has its spec, and a few carry the human's own words.
    const listed = s.json('-C', dir, 'list', '--all', '-k', 'task').items;
    assert.equal(listed.length, 10);
    for (const t of listed) assert.match(s.json('-C', dir, 'show', t.id).item.body, /What: .+\nWhy: .+\nDone when: .+/, t.title);
    assert.equal(listed.filter((t: any) => t.type === 'plan').length, 1);
    const parts = listed.filter((t: any) => t.title === 'Draw the tip page: total, people and tip' || t.title === 'Show each share as you type');
    assert.equal(parts.length, 2, 'the plan has two parts');
    assert.equal(s.json('-C', dir, 'review').questions.length, 1);
    assert.match(fs.readFileSync(path.join(dir, '.spool', 'items', `${listed.find((t: any) => t.title.startsWith('Accept a tip')).id}.md`), 'utf8'), /> can I type 18% instead of 18\? I always do/);
  } finally {
    s.cleanup();
  }
});

test('spool demo goes in the temp directory unless told, and never into a folder with files', () => {
  const s = new Sandbox();
  let made = '';
  try {
    made = s.json('demo').dir;
    assert.ok(path.basename(made).startsWith('spool-demo-'));
    assert.ok(fs.existsSync(path.join(made, 'tip.js')));

    s.write('mine/notes.txt', 'keep me');
    assert.match(s.fails('demo', 'mine'), /already has files in it/);
    assert.deepEqual(fs.readdirSync(path.join(s.root, 'mine')), ['notes.txt'], 'nothing was written');

    // Not inside someone's repository or spool either: it would show up there.
    s.sp('init', '--name', 'theirs');
    assert.match(s.fails('demo', 'sub/demo'), /is inside /);
    assert.ok(!fs.existsSync(path.join(s.root, 'sub')));
  } finally {
    s.cleanup();
    if (made) fs.rmSync(made, { recursive: true, force: true });
  }
});
