import assert from 'node:assert/strict';
import { test } from 'node:test';
import { section } from '../src/builtin.ts';
import { Sandbox } from './helpers.ts';

test('a sprint reached says to cut its version, and keeps the version it became', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    const made = s.json('sprint', 'Polish', '--goal', 'Everything looks finished');
    const sprint = made.sprint.id;
    const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '--sprint', 'Polish');
    const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs', '--sprint', 'Polish');
    s.exec(['play', 'Polish'], { tty: true });
    s.sp('start', jump);
    assert.doesNotMatch(s.sp('done', jump, '-m', 'Snappier'), /cut it now/);
    s.sp('start', coins);
    const done = s.sp('done', coins, '-m', 'Outlined');
    assert.match(done, new RegExp(`Sprint finished: Polish\\. Everything in it is done\\.\\n {2}A sprint reached is a version: cut it now, the changelog led by its name and goal, then spool edit ${sprint} --version <x\\.y\\.z>`));

    // The sprint records the version it became, and its threads take it with it.
    const edited = s.sp('edit', sprint, '--version', 'v0.13.0');
    assert.match(edited, /Updated version 0\.13\.0, 2 of its threads stamped/);
    assert.equal(s.json('show', sprint).item.version, '0.13.0');
    assert.equal(s.json('show', jump).item.version, '0.13.0');
    assert.match(s.item(coins), /version 0\.13\.0, with the sprint Polish/);
    assert.match(s.sp('show', sprint), /^\S+ r-\w+ {2}Polish {2}· done · 2 of 2 done · v0\.13\.0/);
    assert.match(s.sp('list', '-k', 'sprint', '--all'), /Polish {2}· done · 2 of 2 done · v0\.13\.0/);

    // A thread already stamped keeps its own; tags are still only for threads.
    const other = s.json('sprint', 'Later', '--goal', 'More');
    const own = s.id('task', 'Something else', '-s', 'xs', '--sprint', 'Later', '--version', '0.12.9');
    s.exec(['play', 'Later'], { tty: true });
    s.sp('start', own);
    s.sp('done', own, '-m', 'Done');
    s.sp('edit', other.sprint.id, '--version', '0.14.0');
    assert.equal(s.json('show', own).item.version, '0.12.9');
    assert.match(s.fails('edit', sprint, '--tag', 'x'), /only tasks have tags/);
    const note = s.id('capture', 'an idea');
    assert.match(s.fails('edit', note, '--version', '1.0.0'), /only tasks and sprints have a version/);
  } finally {
    s.cleanup();
  }
});

test('a version is cut when a sprint is reached, and work in no sprint at the end of a run', () => {
  // The rule is the worker's, so it is in the worker's rules: whoever builds reads it there.
  const rule = section('A version for what shipped').replace(/\s+/g, ' ');
  assert.match(rule, /\*\*A sprint reached is a version:\*\* when `spool done` says a sprint is finished, cut its version then, before the next thread\. Work that shipped in no sprint is versioned as before\. Once per run/);
  assert.match(rule, /For a sprint, lead with its name and goal, then its threads\./);
  assert.match(rule, /For a sprint, `spool edit <r-id> --version <x\.y\.z>` does it in one: the sprint records the version it became/);
});
