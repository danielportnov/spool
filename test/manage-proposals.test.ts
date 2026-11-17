import assert from 'node:assert/strict';
import { test } from 'node:test';
import { change } from '../src/act.ts';
import { engineCtx } from './claude.ts';
import { spool } from './helpers.ts';

/** A run with two proposals on it, ended. */
function setup() {
  const s = spool();
  const shipped = s.id('task', 'Draw the tip page', '-s', 's');
  const cold = s.id('task', 'A Grand Prix mode', '-s', 'm');
  const run = /^SPOOL_RUN=(t-\w+)$/m.exec(s.sp('manage', '--start', '--as', 'Mgr'))![1]!;
  s.sp('manage', '--propose', 'drop', shipped, '-m', 'Shipped in abc1234: the tip page is drawn', '--as', 'Mgr');
  s.sp('manage', '--propose', 'archive', cold, '-m', 'Cold for a month', '--as', 'Mgr');
  s.sp('manage', '--end', '-m', 'Tidied: 1 looks shipped, 1 cold', '--as', 'Mgr');
  return { s, run, shipped, cold };
}

test('a run puts what it would do on its thread, and the brief says so in one line that opens it', () => {
  const { s, run } = setup();
  try {
    const b = s.json('brief');
    assert.equal(b.needsYou.proposals.length, 1);
    assert.deepEqual({ ...b.needsYou.proposals[0], project: '' }, { id: run, headline: 'Tidied: 1 looks shipped, 1 cold', count: 2, project: '' });
    assert.match(s.sp('brief'), /The manager proposes 2 changes/);
    assert.match(b.headline, /1 needs you|1 need you/);
    // A question is no part of it: it is asked on its thread.
    assert.deepEqual(b.needsYou.questions, []);
  } finally {
    s.cleanup();
  }
});

test('a yes on the page drops the thread with the run\'s reason, and a no leaves it alone', () => {
  const { s, run, shipped, cold } = setup();
  try {
    const ctx = engineCtx(s);
    assert.equal(change(ctx, 'proposal', { id: run, n: 1, said: 'yes' }).ok, true);
    assert.match(s.sp('show', shipped), /^. t-\w+ .*dropped/m);
    assert.match(s.sp('show', shipped), /dropped: Shipped in abc1234: the tip page is drawn/);
    assert.equal(change(ctx, 'proposal', { id: run, n: 2, said: 'no' }).ok, true);
    assert.doesNotMatch(s.sp('show', cold), /archived/);
    assert.equal(s.json('brief').needsYou.proposals.length, 0, 'nothing waits once each is answered');
  } finally {
    s.cleanup();
  }
});

test('a proposal needs a verb that puts a thread out of the way, a thread and a reason', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Draw the tip page', '-s', 's');
    s.sp('manage', '--start', '--as', 'Mgr');
    assert.match(s.fails('manage', '--propose', 'delete', t, '-m', 'why', '--as', 'Mgr'), /a proposal is a verb/);
    assert.match(s.fails('manage', '--propose', 'drop', t, '--as', 'Mgr'), /needs its reason/);
  } finally {
    s.cleanup();
  }
});
