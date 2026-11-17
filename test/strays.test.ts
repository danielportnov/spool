import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/** A project with a first commit, a thread's commit, a commit made by hand, two version commits and a stray file. */
function project(): { s: Sandbox; t: string; hand: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('a.txt', 'a\n');
  s.commitAll('First commit');
  const t = s.id('task', 'Add b');
  s.write('b.txt', 'b\n');
  s.commitAll(`Add b\n\nSpool: ${t}`);
  s.write('c.txt', 'c\n');
  const hand = s.commitAll('Add c by hand');
  s.write('VERSION', '0.2.0\n');
  s.commitAll('Version 0.2.0');
  s.write('VERSION', '0.3.0\n');
  s.commitAll('Version 0.3.0\n\nSpool-Version: 0.3.0');
  s.write('logo.svg', '<svg/>\n');
  s.write('.claude/settings.local.json', '{}\n');
  return { s, t, hand };
}

test('status names a commit that landed on no thread and a file git does not know, and leaves out versions, older history and harness folders', () => {
  const { s, hand } = project();
  const found = s.json('status').projects[0].noThread;
  assert.deepEqual(found.commits.map((c: { sha: string }) => c.sha), [hand]);
  assert.deepEqual(found.untracked, ['logo.svg']);
  assert.equal(found.versions, 2);
  const text = s.sp('status');
  assert.match(text, /a commit landed on no thread:/);
  assert.match(text, new RegExp(`${hand.slice(0, 7)} Add c by hand`));
  assert.match(text, /logo\.svg/);
  assert.doesNotMatch(text, /First commit|Version 0|\.claude/);
  assert.match(text, /spool adopt <sha> --for <t-id>/);
  s.cleanup();
});

test('the brief and doctor name it too', () => {
  const { s, hand } = project();
  assert.match(s.sp('brief'), new RegExp(`ON NO THREAD[\\s\\S]*${hand.slice(0, 7)} Add c by hand`));
  assert.equal(s.json('brief').noThread[0].commits[0].sha, hand);
  const strays = JSON.parse(s.exec(['doctor', '--json']).out).checks.find((c: { id: string }) => c.id === 'strays');
  assert.equal(strays.status, 'advice');
  assert.match(strays.label, /Add c by hand/);
  s.cleanup();
});

test('a restored commit belongs to its thread in status, brief and doctor', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('a.txt', 'a\n');
  s.commitAll('First commit');
  const t = s.id('task', 'Add b');
  s.write('b.txt', 'b\n');
  s.commitAll(`Add b\n\nSpool: ${t}`);
  s.write('b.txt', 'restored\n');
  const restored = s.commitAll(`Put b back\n\nSpool-Restore: ${t}`);

  assert.deepEqual(s.json('status').projects[0].noThread.commits, []);
  assert.deepEqual(s.json('brief').noThread, []);
  const strays = JSON.parse(s.exec(['doctor', '--json']).out).checks.find((c: { id: string }) => c.id === 'strays');
  assert.equal(strays.status, 'ok');
  assert.doesNotMatch(s.sp('status'), new RegExp(restored.slice(0, 7)));
  s.cleanup();
});

test('spool adopt puts a commit on a thread: status stops naming it, and the thread lists it', () => {
  const { s, t, hand } = project();
  assert.match(s.sp('adopt', hand.slice(0, 7), '--for', t, '--as', 'Claude'), new RegExp(`is on ${t} now`));
  assert.deepEqual(s.json('status').projects[0].noThread.commits, []);
  assert.match(s.item(t), new RegExp(hand));
  assert.match(s.item(t), /Claude: adopted .*Add c by hand/);
  assert.match(s.fails('adopt', hand, '--for', t), new RegExp(`is on ${t} already`));
  assert.match(s.fails('adopt', 'nope', '--for', t), /there is no commit nope/);
  // Undoing the thread takes the adopted commit back with its own.
  s.sp('start', t, '--as', 'Claude');
  s.sp('done', t, '-m', 'b and c', '--as', 'Claude');
  s.sp('revert', t, '-m', 'not this');
  assert.equal(s.exists('c.txt'), false);
  assert.equal(s.exists('b.txt'), false);
  s.cleanup();
});

test('before anything has landed on a thread, nothing is named', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.gitInit();
  s.write('a.txt', 'a\n');
  s.commitAll('First commit');
  s.write('b.txt', 'b\n');
  s.commitAll('Second commit');
  const found = s.json('status').projects[0].noThread;
  assert.deepEqual(found.commits, []);
  assert.equal(found.from, null);
  s.cleanup();
});
