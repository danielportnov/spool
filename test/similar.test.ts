import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

const FLOATY = 'The jump feels floaty over long gaps';
const FLOATY_AGAIN = 'Jump feels floaty on long gaps';

test('recording the same wish twice says so the second time, naming the first and how to join them', () => {
  const s = spool();
  const first = s.id('task', FLOATY, '--from', s.id('capture', 'the jump is floaty over long gaps'));
  assert.doesNotMatch(s.sp('task', 'Something else entirely: pick a better font for the menu'), /looks like/);

  const note = s.id('capture', 'jump still feels floaty on the long gaps');
  const out = s.sp('task', FLOATY_AGAIN, '--from', note);
  const second = /(t-\w+)/.exec(out.split('\n')[1]!)![1]!;
  assert.match(out, /This looks like a thread already there:\n {2}.*t-\w+.*floaty over long gaps/);
  assert.match(out, new RegExp(`spool file ${note} --into ${first}, then spool drop ${second}`));
  assert.match(out, /Or leave it as it is\./);
  assert.ok(out.indexOf('Queued in') < out.indexOf('This looks like'), 'after the usual lines');
  assert.ok(second, 'it was filed anyway');
});

test('--json carries the matches', () => {
  const s = spool();
  const first = s.id('task', FLOATY);
  const data = s.json('task', FLOATY_AGAIN);
  assert.equal(data.similar.length, 1);
  assert.equal(data.similar[0].id, first);
  assert.equal(data.similar[0].how, 'open');
  assert.deepEqual(s.json('task', 'Pick a better font for the menu').similar, []);
});

test('a thread finished lately is named, with a check rather than an offer to join it', () => {
  const s = spool();
  const note = s.id('capture', 'coins are hard to see at sunset');
  const done = s.id('task', 'Make the coins readable against the sunset sky', '-s', 's');
  s.sp('done', done, '-m', 'Coins have a dark outline now.');
  const out = s.sp('task', 'Coins are hard to read against the sunset sky', '--from', note);
  assert.match(out, new RegExp(`${done}`));
  assert.match(out, /finished lately/);
  assert.doesNotMatch(out, /spool file/, 'a finished thread cannot take more words');
  const found = s.json('task', 'Coins are hard to read against the sunset sky').similar;
  assert.ok(found.some((m: { id: string; how: string }) => m.id === done && m.how === 'done'));

  // Finished long ago, it is history.
  const later = spool();
  const old = later.id('task', 'Make the coins readable against the sunset sky', '-s', 's');
  later.sp('done', old, '-m', 'Coins have a dark outline now.');
  later.advance(24 * 40);
  assert.doesNotMatch(later.sp('task', 'Coins are hard to read against the sunset sky'), /looks like/);
});

test('a dropped thread is only a hint, with the reason it was dropped', () => {
  const s = spool();
  const old = s.id('task', 'Add a double jump to the player');
  s.sp('drop', old, '-m', 'it breaks the level 2 gap');
  const out = s.sp('task', 'Add a double jump for the player');
  assert.match(out, /This looks like a thread already there:/);
  assert.match(out, /this was dropped before: it breaks the level 2 gap/);
  assert.doesNotMatch(out, /spool file/);
});

test('threads cut from one note are parts of one message, not repeats', () => {
  const s = spool();
  const note = s.id('capture', 'the pause menu needs a resume button and a quit button');
  s.sp('task', 'Add a resume button to the pause menu', '--from', note);
  assert.doesNotMatch(s.sp('task', 'Add a quit button to the pause menu', '--from', note), /looks like/);
});

test('unrelated threads in a backlog of twenty say nothing, even on one subject', () => {
  const s = spool();
  const titles = [
    'Tighten the jump arc',
    'Jump sound plays late',
    'Make coins readable at sunset',
    'Fix the typo on the title screen',
    'Add a pause button to the game',
    'Save the high score between runs',
    'Music is too loud in the menu',
    'Show a loading bar on the first level',
    'Enemies spawn inside walls on level 3',
    'Let the player rebind the keys',
    'Add a credits screen',
    'The title screen flickers on resize',
    'Slow the camera when the player lands',
    'Rename the settings button to options',
    'Add a gamepad cursor to the menu',
    'Cap the frame rate at sixty',
    'Particles when a coin is collected',
    'Ladders let the player climb down',
    'Fade the music between levels',
    'Sound effect when the menu opens',
  ];
  for (const title of titles) assert.doesNotMatch(s.sp('task', title), /looks like/, title);
  assert.doesNotMatch(s.sp('task', 'The jump feels too short on the second platform'), /looks like/);
  assert.doesNotMatch(s.sp('task', 'Make the title screen music louder'), /looks like/);
});
