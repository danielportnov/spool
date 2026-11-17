import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

/** A finished thread, ready to be undone. */
function finished(s: Sandbox, title: string): string {
  const id = s.id('task', title);
  s.sp('done', id, '-m', `${title}, done`);
  return id;
}

test('a revert with a reason becomes a lesson the next agent reads', () => {
  const s = spool();
  const task = finished(s, 'Parse the config');
  const out = s.sp('revert', task, '-m', 'undo that, never add a dependency for this');
  assert.match(out, /kept as a lesson/);
  assert.match(out, /spool lessons --drop 1/);

  // In the policy, as plain text he can edit.
  assert.match(s.read('.spool/policy.md'), /## What was undone here, and why[\s\S]*- "undo that, never add a dependency for this" \(t-\w+, 2026-01-01\)/);

  // The worker's rules carry it once, in its own section, and so does the context-only version.
  for (const args of [['prime'], ['prime', 'worker', '--context']]) {
    const prime = s.sp(...args);
    assert.match(prime, /What was undone here, and why/);
    assert.equal(prime.split('never add a dependency for this').length, 2, 'once, not again inside the policy');
    assert.ok(prime.includes(`"undo that, never add a dependency for this" (${task}, 2026-01-01)`));
  }

  // The rework of the thread is briefed with it.
  s.sp('build', task);
  assert.match(s.sp('start', task), /UNDONE BEFORE, AND WHY[\s\S]*never add a dependency for this/);

  assert.match(s.sp('lessons'), /1 {2}"undo that, never add a dependency for this"/);
  s.cleanup();
});

test('a later thread in the same lineage is briefed with the lesson, an unrelated one is not', () => {
  const s = spool();
  const task = finished(s, 'Redo the login screen');
  s.sp('revert', task, '-m', 'keep the old colours');
  const part = s.id('task', 'Login: the form', '--from', task);
  const deeper = s.id('task', 'Login: the error text', '--from', part);
  const other = s.id('task', 'Unrelated');
  assert.match(s.sp('start', deeper), /UNDONE BEFORE[\s\S]*"keep the old colours"/);
  assert.doesNotMatch(s.sp('start', other), /UNDONE BEFORE/);
  s.cleanup();
});

test('drop forgets a lesson; a revert with no reason, or by an agent, keeps none', () => {
  const s = spool();
  const a = finished(s, 'First');
  s.sp('revert', a, '-m', 'too loud');
  const b = finished(s, 'Second');
  s.sp('revert', b);
  const c = finished(s, 'Third');
  s.sp('revert', c, '-m', 'an agent talking to itself', '--as', 'Claude');
  assert.doesNotMatch(s.sp('revert', finished(s, 'Fourth')), /lesson/);

  const listed = s.json('lessons').lessons;
  assert.deepEqual(listed.map((l: { words: string }) => l.words), ['too loud']);
  assert.match(s.sp('lessons', '--drop', '1'), /Forgotten: "too loud"/);
  assert.match(s.sp('lessons'), /Nothing has been undone here/);
  assert.doesNotMatch(s.sp('prime', 'worker', '--context'), /What was undone here/);
  assert.doesNotMatch(s.read('.spool/policy.md'), /too loud/);
  assert.match(s.fails('lessons', '--drop', '1'), /no lessons/);
  s.cleanup();
});

test('the worker reads the ten newest, newest first; lessons lists them all', () => {
  const s = spool();
  for (let i = 1; i <= 12; i++) {
    const t = finished(s, `Thread ${i}`);
    s.advance(24);
    s.sp('revert', t, '-m', `reason number ${i}`);
  }
  const prime = s.sp('prime');
  const shown = [...prime.matchAll(/"reason number (\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(shown, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.equal(s.json('lessons').lessons.length, 12);

  // Dropping by number takes that one, as listed.
  s.sp('lessons', '--drop', '2');
  assert.deepEqual(
    s.json('lessons').lessons.slice(0, 3).map((l: { words: string }) => l.words),
    ['reason number 12', 'reason number 10', 'reason number 9'],
  );
  s.cleanup();
});
