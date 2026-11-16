/**
 * `--steps <step>…` takes several steps after one --steps, on `done` and on `edit`, and drops none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

test('every step after one --steps is kept, on done and on edit', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Shorten the jump');
    s.sp('start', t);
    s.sp('done', t, '-m', 'the arc is shorter', '--steps', 'Open level one', 'Jump: it lands sooner');
    assert.deepEqual(s.json('show', t).item.steps, ['Open level one', 'Jump: it lands sooner']);

    // Given again, and mixed with other options, still all kept, in order.
    s.sp('edit', t, '--steps', 'One', 'Two', '-p', '1', '--steps', 'Three');
    assert.deepEqual(s.json('show', t).item.steps, ['One', 'Two', 'Three']);
  } finally {
    s.cleanup();
  }
});

test('words after --steps with no -m are not guessed at, and - or none stand alone', () => {
  const s = spool();
  try {
    const t = s.id('task', 'Shorten the jump');
    s.sp('start', t);
    assert.match(s.fails('done', t, '--steps', 'Open level one', 'fixed the arc'), /"fixed the arc" could be a step or what changed[\s\S]*-m/);
    assert.match(s.fails('edit', t, '--steps', 'none', 'Two'), /stand alone/);
    // Words before any option are still the summary, as they were.
    s.sp('done', t, 'the arc is shorter', '--steps', 'Open level one');
    const item = s.json('show', t).item;
    assert.equal(item.summary, 'the arc is shorter');
    assert.deepEqual(item.steps, ['Open level one']);
  } finally {
    s.cleanup();
  }
});
