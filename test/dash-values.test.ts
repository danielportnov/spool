/**
 * Text given to a command is text, even where it starts with a dash: a list of goals, a summary,
 * a title that names a flag. Where it truly cannot be told from an option, the error says how to give it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

test('an option takes the text after it, whatever it starts with', () => {
  const s = spool();
  try {
    s.sp('goals', '--edit', '- first goal\n- second goal');
    assert.equal(s.json('goals').text.trim(), '- first goal\n- second goal');

    const held = s.id('task', 'Wait for the art', '--hold', '-- not yet');
    assert.equal(s.json('show', held).item.hold, '-- not yet');
    const t = s.id('task', 'Tighten the jump', '-b', '- a body that is a list');
    assert.match(s.json('show', t).item.body, /- a body that is a list/);
    s.sp('start', t);
    s.sp('done', t, '-m', '- the arc is shorter');
    assert.equal(s.json('show', t).item.summary, '- the arc is shorter');

    const u = s.id('task', 'Something to drop');
    s.sp('drop', u, '-m', '-1 is not wanted');
    assert.match(s.item(u), /-1 is not wanted/);

    const v = s.id('task', 'Something to hold');
    s.sp('hold', v, '-m', '- after the beta');
    assert.equal(s.json('show', v).item.hold, '- after the beta');

    const { sprint } = s.json('sprint', 'First round', '--goal', '- ship it', '--why', '- the beta', '--done-when', '- three testers', '--serves', '- the launch', '--vision', '- their words');
    assert.equal(sprint.goal, '- ship it');
    assert.equal(sprint.vision, '- their words');
  } finally {
    s.cleanup();
  }
});

test('a title that starts with two dashes is a title, and one that cannot be told from a flag says how', () => {
  const s = spool();
  try {
    const t = s.id('task', '--steps takes several steps');
    assert.equal(s.json('show', t).item.title, '--steps takes several steps');
    const after = JSON.parse(s.sp('task', '--json', '--', '--bogus')).task.id;
    assert.equal(s.json('show', after).item.title, '--bogus');

    const bare = s.fails('task', '--bogus');
    assert.match(bare, /Unknown option '--bogus'/);
    assert.match(bare, /put it after -- \(spool task -- "--like this"\)/);
    // A value that is exactly one of the command's options is the one case left: = gives it.
    const ambiguous = s.fails('done', t, '-m', '--as', 'me');
    assert.match(ambiguous, /ambiguous/);
    assert.match(ambiguous, /join it to its option with =/);
  } finally {
    s.cleanup();
  }
});
