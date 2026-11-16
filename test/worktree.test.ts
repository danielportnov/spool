import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { findHome } from '../src/store.ts';
import { type Sandbox, spool } from './helpers.ts';

/** A project in a repository of its own, with a folder git ignores that a check would need. */
function repo(share = false): Sandbox {
  const s = spool();
  if (share) s.sp('init', '--share');
  s.gitInit();
  s.write('.gitignore', 'node_modules/\n.home/\n');
  s.write('node_modules/dep/index.js', 'module.exports = 1;\n');
  s.write('physics.txt', 'gravity = 9.8\njump = 5\n');
  s.commitAll('init');
  return s;
}

test('from inside a thread’s worktree, spool is the project’s one queue, never the copy the worktree carries', () => {
  const s = repo(true);
  const id = s.id('task', 'Tighten the jump');
  s.commitAll('the queue is kept in git here');
  // A worktree where Spool keeps them, made by hand: all that matters here is where it stands.
  s.git('worktree', 'add', '-q', '-b', `spool/${id}`, `.spool/worktrees/${id}`);
  const w = s.cd(`.spool/worktrees/${id}`);
  const copy = `.spool/items/${id}.md`;
  assert.ok(w.exists(copy) && w.exists('.spool/config.json'), 'the worktree holds the queue as it was when it was cut');
  const stale = w.read(copy);

  assert.equal(findHome(w.dir), s.dir);
  assert.equal(findHome(path.join(w.dir, 'src', 'deep')), s.dir);
  assert.equal(findHome(s.dir), s.dir);

  // log, ask, a new thread, show: all of them reach the project's queue, from anywhere in the worktree.
  w.sp('log', id, 'the arc is in physics.txt');
  const question = w.id('ask', 'Snappy or heavy?', '--option', 'Snappy', '--option', 'Heavy');
  const found = w.cd('.spool').id('task', 'Found on the way');
  assert.match(s.item(id), /agent: the arc is in physics\.txt/);
  assert.ok(s.exists(`.spool/items/${question}.md`) && s.exists(`.spool/items/${found}.md`));
  assert.equal(w.json('show', id).item.file, path.join(s.dir, copy));
  assert.match(w.sp('init'), /Spool is already set up in demo[\s\S]*Nothing was changed/);

  // The copy is exactly as git gave it.
  assert.equal(w.read(copy), stale);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, '.spool', 'items')), [`${id}.md`]);
  assert.equal(w.git('status', '--porcelain'), '');
  s.cleanup();
});
