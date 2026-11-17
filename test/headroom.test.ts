import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sizeForBudget } from '../src/usage.ts';
import { Sandbox } from './helpers.ts';

/** A project in Chat mode with a weekly target of 100%, and a large and a small thread in Build. */
function nearTheEnd(): { s: Sandbox; large: string; small: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  s.sp('builder', 'chat');
  s.sp('target', '--weekly', '100');
  const large = s.id('task', 'Rework the level editor', '-p', '0', '-s', 'l');
  const small = s.id('task', 'Tighten the jump', '-p', '1', '-s', 's');
  s.sp('build', large, small);
  return { s, large, small };
}

test('the size a budget allows shrinks step by step as it is used', () => {
  const steps: Array<[number, 'xs' | 's' | 'm']> = [[75, 'm'], [90, 's'], [97, 'xs']];
  assert.equal(sizeForBudget(50, steps), null);
  assert.equal(sizeForBudget(75, steps), 'm');
  assert.equal(sizeForBudget(92, steps), 's');
  assert.equal(sizeForBudget(99, steps), 'xs');
});

test('at 92% of the target the chat passes a large thread by, saying why, takes a small one, and hears to wrap up', () => {
  const { s, large, small } = nearTheEnd();
  try {
    // Plenty left: the large one comes first, by its priority.
    s.sp('usage', '--weekly', '40', '--as', 'Claude Opus 5.5');
    assert.equal(s.json('next').task.id, large);

    const said = s.sp('usage', '--weekly', '92', '--as', 'Claude Opus 5.5');
    assert.match(said, /^Keep building: weekly 92% of 100%\.\n {2}Near the end: weekly 92% of 100%, so take only up to S now/);
    assert.match(said, /Finish and land what you are building, or leave a hand-off note \(spool log\) and stop\./);
    assert.deepEqual(s.json('usage').headroom, { used: 92, upTo: 's', why: 'weekly 92% of 100%' });

    const next = s.sp('next', '--claim', '--as', 'Claude Opus 5.5');
    assert.match(next, new RegExp(`^Passed by ${large} \\(L\\): near the end of the budget, weekly 92% of 100%: only up to S now\\.`));
    assert.equal(s.json('show', small).item.status, 'active');
    assert.equal(s.json('show', large).item.status, 'open');

    // Started by name, the large one is refused in words; the one being built goes on.
    assert.match(s.fails('start', large, '--as', 'Claude Opus 5.5'), new RegExp(`${large} is L, and the chat is near the end of the budget[\\s\\S]*Wrap up what you are building`));
    s.sp('start', small, '--as', 'Claude Opus 5.5');

    // Nothing more that fits: it is told to wrap up, not handed the large one.
    s.sp('done', small, '-m', 'Tighter', '--as', 'Claude Opus 5.5');
    assert.match(s.sp('next', '--as', 'Claude Opus 5.5'), /^Nothing ready fits what is left: near the end of the budget, weekly 92% of 100%: only up to S now\. 1 waits for more room\.\n {2}Finish and land/);

    // A plan's limit with no target counts against the whole limit.
    s.sp('target', '--weekly', 'none');
    s.sp('usage', '--weekly', '98', '--as', 'Claude Opus 5.5');
    assert.match(s.sp('next', '--as', 'Claude Opus 5.5'), /weekly 98% of 100%: only up to XS now/);
  } finally {
    s.cleanup();
  }
});

test('taking over, the chat passes by what does not fit, with the line on the build', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const typed = (...args: string[]) => {
      const r = s.exec(args, { tty: true });
      if (r.code !== 0) throw new Error(r.err);
    };
    typed('builder', 'chat');
    typed('target', '--weekly', '100');
    typed('takeover', 'on');
    const large = s.id('task', 'Rework the level editor', '-p', '0', '-s', 'l');
    const small = s.id('task', 'Tighten the jump', '-p', '1', '-s', 'xs');
    s.sp('usage', '--weekly', '92', '--as', 'Claude');
    const built = s.sp('build', '--takeover', '--as', 'Claude');
    assert.match(built, new RegExp(`^Passed by ${large} \\(L\\): near the end[\\s\\S]*In build:\\n.*Tighten the jump`));
    assert.equal(s.json('show', small).item.status, 'open');
    assert.equal(s.json('show', large).item.status, 'proposed');
  } finally {
    s.cleanup();
  }
});

test('the human sets how near is near, and default brings the default back', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    assert.doesNotMatch(s.sp('target'), /Near the end/, 'the default goes without saying');
    assert.match(s.sp('target', '--headroom', '50:m,80:xs'), /Near the end of the budget a chat takes up to M from 50% of the budget used, XS from 80%/);
    assert.deepEqual(s.json('target').headroom, [[50, 'm'], [80, 'xs']]);
    assert.match(s.fails('target', '--headroom', '80:huge'), /"80:huge" is not a headroom step/);
    s.sp('target', '--headroom', 'default');
    assert.deepEqual(s.json('target').headroom, [[80, 'm'], [90, 's'], [97, 'xs']]);
  } finally {
    s.cleanup();
  }
});
