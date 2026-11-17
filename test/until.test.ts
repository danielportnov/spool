import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endOfClock, minutesOf } from '../src/until.ts';
import { Sandbox } from './helpers.ts';

test('a time of day is the next time the clock shows it, an hour without am or pm the sooner of its two', () => {
  const at = (h: number, m = 0) => { const d = new Date(2026, 10, 16, h, m); return d; };
  const ten = at(10);
  assert.equal(endOfClock('1:00', ten)!.getHours(), 13);
  assert.equal(endOfClock('1:00', at(23))!.getHours(), 1);
  assert.equal(endOfClock('1:00', at(23))!.getDate(), 17);
  assert.equal(endOfClock('13:30', ten)!.getHours(), 13);
  assert.equal(endOfClock('1am', ten)!.getDate(), 17);
  assert.equal(endOfClock('11pm', ten)!.getHours(), 23);
  assert.equal(endOfClock('0:15', ten)!.getHours(), 0);
  assert.equal(endOfClock('2h', ten), null);
  assert.equal(endOfClock('25:00', ten), null);
  assert.equal(minutesOf('2h'), 120);
  assert.equal(minutesOf('90m'), 90);
  assert.equal(minutesOf('1h30m'), 90);
  assert.equal(minutesOf('1.5h'), 90);
  assert.equal(minutesOf('1:00'), null);
  assert.equal(minutesOf('30h'), null);
});

test('with a time to work set, the chat passes big threads by as the end nears and takes nothing after it', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    s.sp('builder', 'chat');
    const large = s.id('task', 'Rework the level editor', '-p', '0', '-s', 'l');
    const small = s.id('task', 'Tighten the jump', '-p', '1', '-s', 's');
    const tiny = s.id('task', 'Fix the typo', '-p', '2', '-s', 'xs');
    s.sp('build', large, small, tiny);

    assert.match(s.sp('until'), /^No time to work set/);
    assert.match(s.sp('for', '2h'), /^Time to work: until \d+:\d\d, 2h left\./);
    assert.equal(s.json('until').time.leftMinutes, 119);
    // Plenty of time: the large one comes first, by its priority.
    assert.equal(s.json('next').task.id, large);

    // 108 minutes in, 90% of the window is gone: only up to S, the large one passed by with a line.
    s.advance(1.75);
    const next = s.sp('next', '--claim', '--as', 'Claude Opus 5.5');
    assert.match(next, new RegExp(`^Passed by ${large} \\(L\\): near the end of the budget, time to work until \\d+:\\d\\d, \\d+ min left: only up to S now\\.`));
    assert.equal(s.json('show', small).item.status, 'active');
    assert.match(s.sp('usage', '--weekly', '10', '--as', 'Claude Opus 5.5'), /Near the end: time to work until \d+:\d\d, \d+ min left, so take only up to S now[\s\S]*spool handoff/);

    // Past the end: a soft stop. What is being built lands; nothing new is taken.
    s.advance(0.25);
    const stop = s.sp('usage', '--weekly', '10', '--as', 'Claude Opus 5.5');
    assert.match(stop, /^Stop: the time to work until \d+:\d\d, and it has passed\.\n {2}Claim no new thread\. Finish and land/);
    assert.equal(s.json('usage', '--weekly', '10').keepBuilding, false);
    assert.match(s.fails('start', tiny, '--as', 'Claude Opus 5.5'), new RegExp(`${tiny} is XS, and the chat is past the end of the budget[\\s\\S]*spool until`));
    s.sp('done', small, '-m', 'Tighter', '--as', 'Claude Opus 5.5');
    assert.match(s.sp('next', '--as', 'Claude Opus 5.5'), /^Nothing ready fits what is left: past the end of the budget/);

    // Taken off, the chat builds again.
    assert.match(s.sp('until', 'none'), /^No time to work set/);
    assert.equal(s.json('next').task.id, large);
    assert.match(s.fails('until', 'soon'), /is not a time of day/);
  } finally {
    s.cleanup();
  }
});
