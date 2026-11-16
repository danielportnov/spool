/**
 * Small wordings a person reads: the look-alike notice with nothing to merge, and the count a
 * backlog run ends on, which leaves nothing it did out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

test('a look-alike that came from no note says it can be dropped or left, with nothing dangling', () => {
  const s = spool();
  try {
    const first = s.id('task', 'The jump feels floaty over long gaps');
    const out = s.sp('task', 'Jump feels floaty on long gaps');
    const second = /(t-\w+)/.exec(out.split('\n')[1]!)![1]!;
    assert.match(out, new RegExp(`This looks like a thread already there:\\n.*${first}`));
    assert.match(out, new RegExp(`\\n {2}Drop it if it is the same \\(spool drop ${second}\\), or leave it as it is\\.$`));
    assert.doesNotMatch(out, /^\s*Or leave it/m);
  } finally {
    s.cleanup();
  }
});

test('the end of a backlog run counts what it archived and put on hold too', () => {
  const s = spool();
  try {
    const old = s.id('task', 'A level editor for players');
    const later = s.id('task', 'Music for the menu');
    const unsized = s.id('task', 'Remember the last level played');
    const sheet = s.sp('manage', '--start', '--as', 'Claude');
    const run = /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!;
    const as = (...args: string[]) => {
      const r = s.exec([...args, '--as', 'Claude'], { env: { SPOOL_RUN: run } });
      assert.equal(r.code, 0, r.err);
    };
    as('archive', old);
    as('hold', later, '-m', 'after the beta');
    as('edit', unsized, '--size', 's');
    const ended = s.exec(['manage', '--end', '-m', 'Tidied', '--as', 'Claude'], { env: { SPOOL_RUN: run } });
    assert.equal(ended.code, 0, ended.err);
    assert.match(ended.out, /\n {2}3 items changed: 1 sized · 1 archived · 1 put on hold\n/);
  } finally {
    s.cleanup();
  }
});
