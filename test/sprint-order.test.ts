import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/**
 * Two sprints the user made, one of them played, a third made after, and loose threads beside
 * them: a crash, a typo and an idea in no sprint.
 */
function planned() {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.sp('sprint', 'Polish', '--goal', 'Everything looks finished');
  s.sp('sprint', 'Launch', '--goal', 'A build a stranger can finish');
  s.sp('sprint', 'Extras', '--goal', 'Small things players asked for');
  const corners = s.id('task', 'Round the menu corners', '-s', 'xs', '--sprint', 'Launch');
  const menu = s.id('task', 'A menu that says what each button does', '-s', 's', '--sprint', 'Launch');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'm', '--sprint', 'Launch');
  const shelved = s.id('task', 'A trailer for the store page', '-s', 's', '--sprint', 'Launch');
  const pause = s.id('task', 'Pause button under the score', '-s', 's', '--sprint', 'Polish');
  const levels = s.id('task', 'A level select screen', '-s', 'xs', '--sprint', 'Extras');
  const crash = s.id('task', 'The game crashes on launch', '-s', 'xs', '-p', '1');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const grand = s.id('task', 'A Grand Prix mode', '-s', 'm');
  // One of the sprint's threads is built already, and one is put out of sight.
  s.sp('build', corners);
  s.sp('start', corners);
  s.sp('done', corners, '-m', 'Rounded');
  s.sp('archive', shelved);
  s.sp('build', crash, typo);
  s.sp('play', 'Launch');
  return { s, corners, menu, coins, shelved, pause, levels, crash, typo, grand };
}

/** The threads in build, in the order they will be handed out. */
const order = (s: Sandbox): string[] => s.json('overview').projects[0].ready.map((t: { id: string }) => t.id);

test('the list shows the plan: the sprint being played first, under its goal, then the planned ones, then loose threads', () => {
  const { s } = planned();
  try {
    assert.deepEqual(s.sp('overview', '--table').split('\n'), [
      '**🧶 skyhop** · 4 threads in build · 3 proposed · 1 done',
      '',
      '🏁 **Launch** · running · 1 of 3 done — A build a stranger can finish',
      '',
      '| # | 🧵 Thread | Difficulty | Priority | Note |',
      '| --- | --- | --- | --- | --- |',
      '| 2 | **A menu that says what each button does** | Small | Normal |  |',
      '| 3 | **Make coins readable at sunset** | Medium | Normal |  |',
      '',
      '🏁 **Polish** · planned · 0 of 1 done — Everything looks finished',
      '',
      '| # | 🧵 Thread | Difficulty | Priority | Note |',
      '| --- | --- | --- | --- | --- |',
      '| 6 | **Pause button under the score** | Small | Normal | 🟠 Proposed · in Polish |',
      '',
      '🏁 **Extras** · planned · 0 of 1 done — Small things players asked for',
      '',
      '| # | 🧵 Thread | Difficulty | Priority | Note |',
      '| --- | --- | --- | --- | --- |',
      '| 5 | **A level select screen** | Tiny | Normal | 🟠 Proposed · in Extras |',
      '',
      '🧵 **Loose threads** · in no sprint',
      '',
      '| # | 🧵 Thread | Difficulty | Priority | Note |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | **The game crashes on launch** | Tiny | High |  |',
      '| 4 | **Fix the typo on the title screen** | Tiny | Normal |  |',
      '| 7 | **A Grand Prix mode** | Medium | Normal | 🟠 Proposed |',
    ]);

    // A number is a place in line, so every thread has one and no two share it, whatever group it is under.
    const rows = s.json('overview').projects[0].rows.map((r: { n: number }) => r.n);
    assert.deepEqual(rows, [1, 2, 3, 4, 5, 6, 7]);

    // The short list leads with the sprint being played.
    assert.deepEqual(s.sp('overview', '--brief').split('\n').slice(0, 3), [
      '**🧶 skyhop** · 4 threads in build · 3 proposed · 1 done',
      '🏁 **Launch** · running · 1 of 3 done — A build a stranger can finish',
      'Next in build: The game crashes on launch · A menu that says what each button does · Make coins readable at sunset · +1 more',
    ]);
  } finally {
    s.cleanup();
  }
});

test('next hands out the sprint being played ahead of loose work of the same priority, and never ahead of a higher one', () => {
  const { s, menu, coins, crash, typo, pause, grand, shelved } = planned();
  try {
    // The crash is urgent, so it goes first. Then the sprint, though the typo is smaller than either of its threads.
    assert.deepEqual(order(s), [crash, menu, coins, typo]);
    assert.equal(s.json('next').task.id, crash);

    // Work moved to build on its own from a sprint that is only planned is loose work for this rule.
    s.sp('build', pause, grand);
    assert.deepEqual(order(s), [crash, menu, coins, typo, pause, grand]);

    // Someday work in the sprint still waits behind loose work that matters more.
    s.sp('edit', coins, '-p', '3');
    assert.deepEqual(order(s), [crash, menu, typo, pause, grand, coins]);

    // A place the user gave beats all of it.
    s.sp('order', grand, '--first');
    assert.deepEqual(order(s), [grand, crash, menu, typo, pause, coins]);
    assert.equal(s.json('next').task.id, grand);

    // What is done or archived is not handed out, and not on the list.
    assert.ok(!order(s).includes(shelved));
    assert.doesNotMatch(s.sp('overview', '--table'), /Round the menu corners|A trailer for the store page/);
  } finally {
    s.cleanup();
  }
});

test('one pick in four still goes to large work while a sprint is full of small things', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    s.sp('sprint', 'Polish');
    const small = ['Round the menu corners', 'Fix the pause icon', 'Brighter coins', 'Softer music'].map((t) => s.id('task', t, '-s', 'xs', '--sprint', 'Polish'));
    const big = s.id('task', 'Online multiplayer', '-s', 'l');
    s.sp('build', big);
    s.sp('play', 'Polish');
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = s.json('next').task.id;
      picked.push(id);
      s.sp('start', id);
    }
    assert.deepEqual(picked, [small[0], small[1], small[2], big]);
  } finally {
    s.cleanup();
  }
});
