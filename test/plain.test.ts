import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { board } from '../src/board.ts';
import { Workspace } from '../src/store.ts';
import { plain } from '../src/plain.ts';
import { spool } from './helpers.ts';

test('Spool’s own thread lines read in plain words, old and new alike, and unknown lines are left as they are', () => {
  assert.equal(plain('builder model: sonnet · medium, by its size'), 'Builder: Sonnet, medium effort (its size)');
  assert.equal(plain('built on opus; Spool suggested opus · medium, by its size'), 'Built on Opus. Spool would have picked Opus, medium effort (its size)');
  assert.equal(plain('started, in its own worktree on spool/t-abcd'), 'Started, in its own copy of the project');
  assert.equal(plain('moved to build, taking over the backlog: weekly 63% of 100%'), 'Took it from the backlog: usage 63% of 100%');
  assert.equal(plain('check passed: npm run check && npm test (96s)'), 'Checks passed in 96s');
  assert.equal(plain('landed 3 commit(s) on main'), 'Landed: 3 commits on main');
  assert.equal(plain('reverted 1 commit(s): wrong'), 'Undid 1 commit: wrong');
  assert.equal(plain('stepped up from haiku to sonnet · medium: its last run was undone'), 'Moved up from Haiku to Sonnet, medium effort: its last run was undone');
  assert.equal(plain('handed to `claude -p --model opus --effort high`'), 'Handed to an agent on Opus, high effort');
  assert.equal(plain('The tip page is up: three boxes.'), 'The tip page is up: three boxes.');
});

test('the stored lines keep their old wording for the code that reads them back; the board shows them plain', () => {
  const s = spool();
  const id = s.id('task', 'Fix a typo', '--size', 'xs');
  s.sp('start', id);
  const stored = fs.readFileSync(`${s.dir}/.spool/items/${id}.md`, 'utf8');
  assert.match(stored, /: started\n/, 'the stored line is the old one');
  assert.match(stored, /: builder model: haiku · medium, by its size/);
  const b = board(Workspace.open(s.dir, () => new Date()));
  const card = Object.values(b.columns).flat().find((c) => c.id === id)!;
  const shown = card.thread.feed.map((p) => p.text);
  assert.ok(shown.includes('Builder: Haiku, medium effort (its size)'), shown.join(' | '));
  assert.ok(!shown.some((t) => t.startsWith('builder model')));
  s.cleanup();
});
