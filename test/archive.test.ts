import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { Sandbox } from './helpers.ts';

function gated(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  return s;
}

const ids = (data: { items: { id: string }[] }) => data.items.map((i) => i.id).sort();

test('an archived thread is out of sight, not dropped: off the lists and the counts, never handed out', () => {
  const s = gated();
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-b', 'Why: it feels floaty');
  const grand = s.id('task', 'A Grand Prix mode', '-b', 'Why: players asked');
  const idea = s.id('task', 'Remember the last level', '--hold', 'just an idea', '-b', 'Why: players come back');
  s.sp('archive', grand, idea);

  // Kept, with all it had: its status and its hold are just as they were.
  const shown = s.json('show', grand).item;
  assert.deepEqual([shown.status, shown.state, typeof shown.archived], ['proposed', 'archived', 'string']);
  assert.equal(s.json('show', idea).item.hold, 'just an idea');
  assert.match(s.item(grand), /human: archived/, 'acting for the human unless told otherwise');

  // Gone from the loop's list, the brief one, the overview's counts and the plain list.
  const table = s.sp('overview', '--table');
  assert.match(table, /^\*\*🧶 skyhop\*\* · 0 threads in build · 1 proposed · 0 done/);
  assert.doesNotMatch(table, /Grand Prix|last level/);
  assert.doesNotMatch(s.sp('overview'), /Grand Prix|last level|on hold/);
  assert.deepEqual(ids(s.json('list')), [jump]);
  assert.deepEqual(ids(s.json('list', '-s', 'proposed')), [jump], 'a status filter does not reach into the archive');
  assert.deepEqual(ids(s.json('list', '--archived')), [grand, idea].sort());
  assert.match(s.sp('list', '--archived'), /▪ t-\S+ +p2 +A Grand Prix mode {2}· archived \d+m ago/);
  assert.deepEqual(ids(s.json('list', '--all')), [grand, idea, jump].sort());
  assert.ok(!s.sp('check').includes('no Why'));

  // Never handed out, even moved to build behind the archive's back.
  const raw = s.item(grand).replace('status: proposed', 'status: open');
  s.write(`.spool/items/${grand}.md`, raw);
  assert.equal(s.json('next').task, null);
  assert.match(s.fails('start', grand), /is archived[\s\S]*spool archive --undo/);
  s.write(`.spool/items/${grand}.md`, raw.replace('status: open', 'status: proposed'));

  // Brought back just as it was: proposed, or still on hold.
  s.sp('archive', '--undo', grand, idea);
  assert.equal(s.json('show', grand).item.state, 'proposed');
  assert.deepEqual([s.json('show', idea).item.state, s.json('show', idea).item.hold], ['proposed', 'just an idea']);
  assert.match(s.item(grand), /human: brought back from the archive/);
  assert.match(s.fails('archive', '--undo', grand), /is not archived/);
  s.cleanup();
});

test('moving an archived thread to build brings it back; what is built or finished cannot be archived', () => {
  const s = gated();
  const jump = s.id('task', 'Tighten the jump arc', '-b', 'Why: floaty');
  const done = s.id('task', 'Fix the typo', '-b', 'Why: it is wrong');
  s.sp('build', done);
  s.sp('start', done);
  assert.match(s.fails('archive', done), /is being built[\s\S]*spool propose --abort/);
  s.sp('done', done, '-m', 'fixed');
  assert.match(s.fails('archive', done), /already done/);
  assert.match(s.fails('archive'), /what to archive is missing/);

  s.sp('archive', jump);
  s.sp('build', jump);
  const item = s.json('show', jump).item;
  assert.deepEqual([item.state, item.archived], ['ready', undefined]);
  assert.match(s.item(jump), /moved to build \(was archived\)/);
  s.cleanup();
});

test('a sprint keeps an archived thread, but playing it does not move it and its count leaves it out', () => {
  const s = gated();
  const sprint = s.json('sprint', 'Launch').sprint.id;
  const jump = s.id('task', 'Tighten the jump arc', '-b', 'Why: floaty');
  const grand = s.id('task', 'A Grand Prix mode', '-b', 'Why: asked');
  s.sp('edit', jump, '--sprint', sprint);
  s.sp('edit', grand, '--sprint', sprint);
  s.sp('archive', grand);
  assert.deepEqual(s.json('play', sprint).build, [jump]);
  assert.equal(s.json('show', grand).item.state, 'archived');
  s.sp('archive', '--undo', grand);
  assert.equal(s.json('show', grand).item.sprint, sprint, 'back in its sprint');
  s.cleanup();
});

test('the board leaves archived threads off its columns, and lists them apart, newest first', () => {
  const s = gated();
  const jump = s.id('task', 'Tighten the jump arc', '-b', 'Why: floaty');
  const grand = s.id('task', 'A Grand Prix mode', '-b', 'Why: players asked for it');
  const old = s.id('task', 'An old idea');
  s.sp('archive', old);
  s.advance(3);
  s.sp('archive', grand);
  const ws = Workspace.open(s.dir, () => new Date(Date.parse('2026-01-01T04:00:00Z')));
  try {
    const b = board(ws);
    assert.deepEqual(b.columns.proposed.map((c) => c.id), [jump]);
    assert.deepEqual(b.archived.map((c) => [c.id, c.column, c.why]), [[grand, 'proposed', 'players asked for it'], [old, 'proposed', '']]);
    assert.match(b.archived[1]!.note, /^Archived \dh ago$/);
  } finally {
    ws.close();
  }
  s.cleanup();
});
