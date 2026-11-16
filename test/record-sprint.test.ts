import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';
import { Sandbox } from './helpers.ts';

test('the recorder sees the open sprints with their goals, and files a thread straight into one', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--gate');
    s.sp('sprint', 'Polish', '--goal', 'Everything looks finished');
    s.sp('sprint', 'Launch', '--goal', 'A build a stranger can finish', '--serves', 'a first level nobody gets stuck on');
    s.sp('sprint', 'Old', '--goal', 'Long done');
    const corners = s.id('task', 'Round the menu corners', '-s', 'xs', '--sprint', 'Launch');
    s.exec(['play', 'Launch'], { tty: true });
    const last = s.id('task', 'Last thing', '-s', 'xs', '--sprint', 'Old');
    s.exec(['play', 'Old'], { tty: true });
    s.sp('start', last);
    s.sp('done', last, '-m', 'Done');

    const context = s.sp('prime', 'recorder', '--context');
    const block = context.split('\n\n').find((b) => b.startsWith('SPRINTS'))!;
    assert.deepEqual(block.trim().split('\n').map((l) => l.replace(/r-\w+/, 'r-id')), [
      'SPRINTS  a thread that serves one goes in it: --sprint <name>',
      '  r-id  Launch · being played · serves a first level nobody gets stuck on — A build a stranger can finish',
      '  r-id  Polish · planned — Everything looks finished',
    ], 'the one being played first, a finished one not at all');
    assert.match(s.sp('prime', 'recorder'), /# Spool · recorder protocol[\s\S]*\*\*Put each in the plan\.\*\*[\s\S]*SPRINTS/);

    // Filed with --sprint, a thread is in the plan from the start, and says so.
    const filed = s.sp('task', 'A menu that says what each button does', '-s', 's', '--sprint', 'Launch');
    assert.match(filed, /proposed · Launch/);
    const sprint = s.json('list', '-k', 'sprint').items.find((i: { title: string }) => i.title === 'Launch');
    assert.equal(s.json('show', sprint.id).item.threads.length, 2);
    assert.ok(s.json('show', sprint.id).item.threads.includes(corners));
  } finally {
    s.cleanup();
  }
});

test('the record skill says where each thread goes, and names commands that exist', () => {
  const rules = shipped('spool-record').replace(/\s+/g, ' ');
  assert.match(rules, /A thread that serves the goal of the sprint being played goes in it; failing that, a planned sprint whose goal it serves; failing both, it stays loose\./);
  assert.match(rules, /`--sprint <name>` as you file it, or later `spool edit <t-id> --sprint <name>`/);
  assert.match(rules, /which sprint each went into or that it is loose/);
});
