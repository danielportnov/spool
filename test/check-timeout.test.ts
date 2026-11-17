/**
 * A check that never ends is ended at its limit, with everything it started. Its thread is refused
 * with the reason, and the landing waiting behind it goes by itself.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, Sandbox, spool, until } from './helpers.ts';

function repo(): Sandbox {
  const s = spool();
  s.gitInit();
  s.write('.gitignore', 'node_modules/\n.home/\n');
  s.write('physics.txt', 'gravity = 9.8\n');
  s.commitAll('init');
  return s;
}

function finish(s: Sandbox, id: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, 'done', id, '-m', 'Landed'],
      { cwd: path.join(s.dir, '.spool', 'worktrees', id), env: { ...process.env, HOME: path.join(s.root, '.home'), XDG_CONFIG_HOME: '' } },
      (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout}${stderr}` }),
    );
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a check that hangs is ended at its limit, its thread refused, and the landing behind it carries on', async () => {
  const s = repo();
  // A thread without ok.txt hangs, and leaves a grandchild running that holds the pipe; one with it passes.
  s.exec(['checks', 'test -f ok.txt || { sleep 61 & echo $! > "$HOME/grandchild.pid"; sleep 60; }', '--timeout', '0.05'], { tty: true });
  assert.match(s.sp('checks'), /ended after 0\.05 minutes/);
  const [hung, fine] = [['hang', 'a.txt'], ['fine', 'ok.txt']].map(([name, file]) => {
    const id = s.id('task', `Add ${name}`);
    s.sp('start', id, '--worktree');
    const w = s.cd(`.spool/worktrees/${id}`);
    w.write(file!, 'x\n');
    w.commitAll(`Add ${name}\n\nSpool: ${id}`);
    return id;
  }) as [string, string];

  const first = finish(s, hung);
  await until('the hung check is running', () => fs.existsSync(path.join(s.root, '.home', 'grandchild.pid')));
  const second = finish(s, fine);
  await until('the second says it waits', () => /behind it/.test(String(s.json('status').projects[0].board.landing)));
  const waiting = s.json('status').projects[0].board.landing as string;
  assert.match(waiting, new RegExp(`${hung} is landing[\\s\\S]*${fine} has waited`));
  assert.match(s.sp('status'), /Landing: .*behind it/);

  const [refused, landed] = await Promise.all([first, second]);
  assert.equal(refused.ok, false);
  assert.match(refused.out, /the check took longer than 0\.05 minutes/);
  assert.equal(s.json('show', hung).item.status === 'done', false);
  assert.equal(landed.ok, true, landed.out);
  assert.equal(s.json('show', fine).item.status, 'done');
  // What the check started went with it.
  const pid = Number(fs.readFileSync(path.join(s.root, '.home', 'grandchild.pid'), 'utf8'));
  assert.equal(alive(pid), false);
  assert.equal(fs.existsSync(path.join(s.dir, '.git', 'spool-landing.lock')), false);
  assert.equal(s.json('status').projects[0].board.landing, null);
  s.cleanup();
});

test('--timeout is set beside the check and shown, and the default is ten minutes', () => {
  const s = repo();
  s.sp('checks', 'true');
  assert.match(s.sp('checks'), /ended after 10 minutes/);
  assert.match(s.fails('checks', '--timeout', '2'), /the human's to change/);
  s.exec(['checks', '--timeout', '2'], { tty: true });
  assert.equal(s.json('checks').timeoutMinutes, 2);
  assert.match(s.exec(['checks', '--timeout', 'soon'], { tty: true }).err, /not a number of minutes/);
  s.exec(['checks', '--timeout', 'default'], { tty: true });
  assert.equal(s.json('checks').timeoutMinutes, 10);
  s.cleanup();
});
