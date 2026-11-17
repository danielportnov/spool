import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

const VISION = 'I want the first five minutes to feel finished.\nA stranger should get through level one without asking me anything.';

test('a sprint is made and filled in one go, and keeps the vision in his words', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const menu = s.id('task', 'A menu that says what each button does', '-s', 's');
    const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
    const pause = s.id('task', 'Pause button under the score', '-s', 's');

    const made = s.exec(['sprint', 'First five minutes', '--vision', '-', '--goal', 'A stranger finishes level one alone', '--why', 'the beta opens Friday', '--done-when', 'three testers clear level one', '--add', menu, coins, '--json'], { stdin: VISION });
    assert.equal(made.code, 0, made.err);
    const data = JSON.parse(made.out);
    assert.equal(data.made, true);
    assert.deepEqual(data.added.sort(), [menu, coins].sort());
    const sprint = data.sprint;
    assert.equal(sprint.title, 'First five minutes', 'the ids after --add are not part of the name');
    assert.equal(sprint.goal, 'A stranger finishes level one alone');
    assert.equal(sprint.vision, VISION);
    assert.deepEqual(sprint.threads.sort(), [menu, coins].sort());
    assert.equal(s.json('show', menu).item.sprint, sprint.id);
    assert.match(s.item(menu), /agent: put in the sprint First five minutes/);

    // Shown whole: his words quoted and signed, then what it is for, then what is in it.
    const shown = s.sp('show', sprint.id);
    assert.match(shown, /> I want the first five minutes to feel finished\.\n> A stranger should get through level one without asking me anything\.\n> — the vision, 2026-01-01\n\nGoal: A stranger finishes level one alone\nWhy: the beta opens Friday\nDone when: three testers clear level one/);
    assert.match(shown, /IN IT\n {2}.*A menu that says what each button does[\s\S]*Make coins readable at sunset/);

    // An existing sprint is filled by name: a thread is added, nothing else changes.
    const filled = s.sp('sprint', 'first five minutes', '--add', pause);
    assert.match(filled, /^Sprint First five minutes: 1 added\./);
    assert.match(filled, /the user starts it: spool play/);
    assert.equal(s.json('list', '-k', 'sprint').items.length, 1, 'no second sprint of the same name');
    assert.equal(s.json('show', sprint.id).item.threads.length, 3);
    assert.match(s.sp('overview', '--table'), /🏁 \*\*First five minutes\*\* · planned · 0 of 3 done — A stranger finishes level one alone/);
    assert.match(s.fails('sprint', 'First five minutes'), /there is already a sprint called "First five minutes"/);
  } finally {
    s.cleanup();
  }
});

test('a vision can come from a note he gave, and stands in for a goal not yet written', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const note = s.id('capture', 'make the whole game feel calmer, softer sounds and slower menus');
    const one = s.id('task', 'Softer jump sound', '-s', 'xs');
    const out = s.json('sprint', 'Calm', '--from', note, '--add', one);
    assert.equal(out.sprint.vision, 'make the whole game feel calmer, softer sounds and slower menus');
    assert.deepEqual(out.sprint.from, [note]);
    assert.equal(s.json('show', note).item.status, 'filed', 'the note is filed into the sprint');
    assert.match(s.sp('show', out.sprint.id), new RegExp(`> make the whole game feel calmer[^\\n]*\\n> — \\[\\[${note}\\]\\], 2026-01-01`));
    // No goal yet: the list shows his words instead, and says how to write one.
    assert.match(s.sp('overview', '--table'), /🏁 \*\*Calm\*\* · planned · 0 of 1 done — “make the whole game feel calmer, softer sounds and slower menus”/);
    assert.match(s.sp('sprint', 'Calm', '--goal', 'Nothing in the game startles'), /^Sprint Calm: goal\./);
    assert.match(s.sp('overview', '--table'), /🏁 \*\*Calm\*\* · planned · 0 of 1 done — Nothing in the game startles/);
  } finally {
    s.cleanup();
  }
});

test('filling a sprint says no to what cannot go in it', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const done = s.id('task', 'Already shipped', '-s', 'xs');
    s.sp('build', done);
    s.sp('start', done);
    s.sp('done', done, '-m', 'Shipped');
    const open = s.id('task', 'Still to do', '-s', 'xs');
    assert.match(s.fails('sprint', 'Polish', '--add', done), /is done/);
    assert.equal(s.json('list', '-k', 'sprint').items.length, 0, 'refused, nothing is made');
    assert.match(s.fails('sprint', 'Polish', '--vision', 'a', '--from', 'n-xxxx'), /give the vision once/);
    assert.match(s.fails('sprint', 'Polish', '--add', 'n-nope'), /no item "n-nope"/);
    // A thread in a running sprint waits for the user's play: adding it starts nothing.
    s.sp('sprint', 'Polish', '--add', open);
    const other = s.id('task', 'One more', '-s', 'xs');
    s.exec(['play', 'Polish'], { tty: true });
    const added = s.sp('sprint', 'Polish', '--add', other);
    assert.match(added, /it is running: what was added waits in the backlog until the user presses play again/);
    assert.equal(s.json('show', other).item.state, 'proposed');
  } finally {
    s.cleanup();
  }
});
