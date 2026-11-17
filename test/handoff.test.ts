/**
 * `spool handoff`: an agent out of usage gives its thread to one with usage, which carries it on
 * from the same worktree and the work so far.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

function repo(): Sandbox {
  const s = spool();
  s.gitInit();
  s.write('.gitignore', '.home/\n');
  s.write('physics.txt', 'gravity = 9.8\n');
  s.commitAll('init');
  return s;
}

test('a thread handed off to Codex keeps its work, waits for Codex, and Codex carries it on and lands it', () => {
  const s = repo();
  try {
    const t = s.id('task', 'Make the jump higher');
    s.sp('start', t, '--worktree', '--as', 'Claude Opus 5.5', '--model', 'opus');
    const w = s.cd(`.spool/worktrees/${t}`);
    w.write('physics.txt', 'gravity = 9.8\njump = 7\n');

    // Out of usage: the work so far is committed, with the trailer, and the thread is back in Build.
    const said = s.sp('handoff', t, '-m', 'jump is raised; the test for it is left', '--to', 'codex', '--as', 'Claude Opus 5.5');
    assert.match(said, /Handed off .*: back in Build, only Codex is handed it\./);
    assert.equal(w.git('status', '--porcelain'), '');
    assert.match(w.git('log', '-1', '--format=%B'), /^Hand-off checkpoint: jump is raised[\s\S]*\nSpool: t-/);
    const sha = w.git('rev-parse', '--short=7', 'HEAD');
    assert.match(s.item(t), new RegExp(`Claude Opus 5\\.5: handed off to Codex: jump is raised; the test for it is left \\(work so far at ${sha}\\); back in build`));
    assert.equal(s.json('show', t).item.state, 'ready');
    assert.match(s.sp('list'), /handed off to Codex by Claude Opus 5\.5/);

    // Kept for Codex: Claude is not handed it, and cannot take it without --force.
    assert.equal(s.json('next', '--claim', '--as', 'Claude Opus 5.5').task, null);
    assert.match(s.fails('start', t, '--as', 'Claude Opus 5.5'), /handed off to Codex/);

    // Codex takes it: back in the same worktree, the note at the top of its brief, and no step up.
    const brief = s.sp('next', '--claim', '--as', 'Codex GPT-6');
    assert.match(brief, new RegExp(`HANDED OFF — Claude Opus 5\\.5 stopped here, for Codex: jump is raised; the test for it is left\\. Its work so far is committed on the branch, at ${sha}`));
    assert.match(brief, /its own from before/);
    assert.doesNotMatch(brief, /stepped up/);
    assert.equal(w.read('physics.txt'), 'gravity = 9.8\njump = 7\n');

    w.write('jump.test.txt', 'jump is 7\n');
    w.commitAll(`Test the jump\n\nSpool: ${t}`);
    s.sp('done', t, '-m', 'The jump is higher', '--steps', 'Jump', '--as', 'Codex GPT-6');
    assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 7\n');
    assert.ok(s.exists('jump.test.txt'));
    // Once it is done, the hand-off is history: the brief no longer leads with it.
    assert.doesNotMatch(s.sp('show', t), /handed off to Codex by/);
  } finally {
    s.cleanup();
  }
});

test('handed off to a smaller model, the next claim is built on it, and it is not a failed run', () => {
  const s = repo();
  try {
    const t = s.id('task', 'Tidy the physics');
    s.sp('start', t, '--as', 'Claude Opus 5.5');
    s.sp('handoff', t, '-m', 'half tidied', '--to', 'sonnet', '--as', 'Claude Opus 5.5');
    const picked = s.json('start', t, '--as', 'Claude Opus 5.5');
    assert.equal(picked.model.model, 'sonnet');
    assert.match(picked.model.why, /handed off to it by Claude Opus 5\.5/);

    // A second hand-off, with --to left off: anyone may take it, and the next claim goes by its size, not one up.
    s.sp('handoff', t, '-m', 'still half tidied', '--as', 'Claude Opus 5.5');
    const again = s.json('start', t, '--as', 'Codex GPT-6');
    assert.equal(again.model.model, 'gpt-6.1-sol', 'Codex goes by its own size table');
    assert.match(again.model.why, /by its size/);
  } finally {
    s.cleanup();
  }
});

test('a hand-off needs a note, a thread being built, and its own builder; --to is an agent or a model', () => {
  const s = repo();
  try {
    const t = s.id('task', 'Add wind');
    assert.match(s.fails('handoff', t, '-m', 'x'), /is not being built/);
    s.sp('start', t, '--as', 'Claude Opus 5.5');
    assert.match(s.fails('handoff', t, '--as', 'Claude Opus 5.5'), /where it stopped is missing/);
    assert.match(s.fails('handoff', t, '-m', 'x', '--as', 'Codex GPT-6'), /being built by Claude Opus 5\.5/);
    assert.match(s.fails('handoff', t, '-m', 'x', '--to', 'Gemini', '--as', 'Claude Opus 5.5'), /neither an agent on the roster nor a model/);
  } finally {
    s.cleanup();
  }
});
