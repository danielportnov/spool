/**
 * A thread's worktree refuses `git push`; the project's own folder does not.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

function repo(): { s: Sandbox; remote: string } {
  const s = spool();
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.write('a.txt', 'a\n');
  s.commitAll('init');
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  s.git('remote', 'add', 'origin', remote);
  return { s, remote };
}

const push = (dir: string) => spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/probe'], { cwd: dir, encoding: 'utf8' });

test('git push is refused in a thread worktree with a line naming the policy, and works from the checkout', () => {
  const { s, remote } = repo();
  try {
    const t = s.id('task', 'Guard it');
    s.sp('start', t, '--worktree', '--as', 'Claude Opus 5.5', '--model', 'opus');
    const w = s.cd(`.spool/worktrees/${t}`);
    const refused = push(w.dir);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Agents never push/);
    assert.equal(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'refs/heads/probe']).status, 1);
    // The user's own folder is unchanged.
    const ok = push(s.dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.notEqual(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: s.dir }).status, 0);
  } finally {
    s.cleanup();
  }
});

test('the checkout\'s own hooks still run in the worktree, and nothing is left behind when it goes', () => {
  const { s } = repo();
  try {
    const hooks = path.join(s.dir, '.git', 'hooks');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho ran > "$(git rev-parse --git-common-dir)/../hook-ran"\nexit 0\n', { mode: 0o755 });
    const t = s.id('task', 'Guard it');
    s.sp('start', t, '--worktree', '--as', 'Claude Opus 5.5', '--model', 'opus');
    const w = s.cd(`.spool/worktrees/${t}`);
    w.write('b.txt', 'b\n');
    w.git('add', '-A');
    w.git('commit', '-q', '-m', 'b');
    assert.ok(fs.existsSync(path.join(s.dir, 'hook-ran')));
    const admin = path.resolve(w.dir, w.git('rev-parse', '--git-dir'));
    assert.ok(fs.existsSync(path.join(admin, 'spool-hooks', 'pre-push')));
    s.sp('drop', t, '-m', 'not wanted');
    assert.ok(!fs.existsSync(admin), 'the worktree admin folder, and the hooks in it, are gone');
  } finally {
    s.cleanup();
  }
});
