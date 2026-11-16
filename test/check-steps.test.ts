import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { type Sandbox, spool } from './helpers.ts';

function sandbox(): Sandbox {
  const s = spool();
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  return s;
}

/** Claim a thread and commit a change under its trailer, ready to be finished. */
function work(s: Sandbox, title: string, ...args: string[]): string {
  const id = s.id('task', title, ...args);
  s.sp('start', id);
  s.write(`src/${id}.txt`, `${title}\n`);
  s.commitAll(`${title}\n\nSpool: ${id}`);
  return id;
}

function cardOf(s: Sandbox, id: string) {
  const ws = Workspace.open(s.dir, () => new Date());
  try {
    return board(ws).columns.done.find((c) => c.id === id);
  } finally {
    ws.close();
  }
}

test('a change finished with steps keeps them, and shows them in show, --json, on its card and in the brief', () => {
  const s = sandbox();
  const id = work(s, 'Rebuild the level editor', '-s', 'l');
  const out = s.sp('done', id, '-m', 'The editor saves as you go', '--steps', 'Open the editor', '--steps', 'Draw a wall and close the window', '--steps', 'Open it again: the wall is there');
  assert.doesNotMatch(out, /No steps to check it by/);
  const steps = ['Open the editor', 'Draw a wall and close the window', 'Open it again: the wall is there'];

  assert.match(s.sp('show', id), /The editor saves as you go\n\nTO CHECK\n {2}1\. Open the editor\n {2}2\. Draw a wall and close the window\n {2}3\. Open it again: the wall is there/);
  assert.deepEqual(s.json('show', id).item.steps, steps);
  assert.deepEqual(cardOf(s, id)!.steps, steps);

  // A large change is worth a look, and its steps are right under it.
  assert.match(s.sp('brief'), /why: large[^\n]*\n {5}to check:\n {7}1\) Open the editor\n {7}2\) Draw a wall and close the window\n {7}3\) Open it again: the wall is there/);
  assert.deepEqual(s.json('brief').worthALook[0].steps, steps);
  assert.match(s.sp('review'), /The editor saves as you go\n {8}1\. Open the editor/);
  s.cleanup();
});

test('steps can come from stdin, one a line, and a pasted list keeps only its words', () => {
  const s = sandbox();
  const id = work(s, 'Round the menu corners');
  const done = s.exec(['done', id, '-m', 'Menu corners are rounded', '--steps', '-'], { stdin: '1. Open the game\n\n- Press Escape: the menu has round corners\n' });
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(s.json('show', id).item.steps, ['Open the game', 'Press Escape: the menu has round corners']);
  s.cleanup();
});

test('a change finished without steps still finishes, and says in one line how to add them', () => {
  const s = sandbox();
  const id = work(s, 'Fix the typo on the title screen');
  const out = s.sp('done', id, '-m', 'The title says Spool, not Sppol');
  assert.match(out, /^t-\w+ done\./);
  const told = out.split('\n').filter((l) => l.includes('No steps to check it by'));
  assert.equal(told.length, 1);
  assert.match(told[0]!, new RegExp(`spool edit ${id} --steps "<step>"`));
  assert.equal(s.json('show', id).item.status, 'done');
  assert.deepEqual(cardOf(s, id)!.steps, []);
  assert.doesNotMatch(s.sp('show', id), /TO CHECK/);

  // Added after, they show as if given at the finish.
  const edited = s.sp('edit', id, '--steps', 'Open the game', '--steps', 'The title reads Spool');
  assert.match(edited, /2 step\(s\) to check it by/);
  assert.deepEqual(s.json('show', id).item.steps, ['Open the game', 'The title reads Spool']);
  assert.deepEqual(cardOf(s, id)!.steps, ['Open the game', 'The title reads Spool']);
  assert.match(s.sp('show', id), /TO CHECK\n {2}1\. Open the game\n {2}2\. The title reads Spool/);
  s.sp('edit', id, '--steps', 'none');
  assert.deepEqual(s.json('show', id).item.steps, []);
  s.cleanup();
});

test('an audit is not asked for steps', () => {
  const s = sandbox();
  const id = s.id('audit', 'Look at the level editor through a new player’s eyes');
  s.sp('start', id);
  const out = s.exec(['done', id, '-m', 'Three things confuse a new player', '--report', '-'], { stdin: '# Findings\n\nThe save button is hidden.\n' });
  assert.equal(out.code, 0, out.err);
  assert.doesNotMatch(out.out, /No steps/);
  s.cleanup();
});
