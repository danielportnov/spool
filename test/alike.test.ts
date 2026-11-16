import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spool } from './helpers.ts';

// Fifteen threads about different things: none shares three words with another.
const UNRELATED = [
  'Pick a better font for the menu',
  'Coins are hard to see at sunset',
  'Save the best score between visits',
  'Add a pause button on phones',
  'Music stops when the tab loses focus',
  'Slow the camera when the player lands',
  'Show a hint after three deaths',
  'Rename the settings page to preferences',
  'Export a run as a short video',
  'Make the boss telegraph its dash',
  'Translate the title screen to Spanish',
  'Stop the leaderboard from flickering on reload',
  'Add a colour-blind palette',
  'Fix the typo in the credits',
  'Let the player remap the keys',
];

function backlog() {
  const s = spool();
  for (const t of UNRELATED) s.id('task', t);
  return s;
}

test('two near-duplicates among fifteen unrelated threads are listed as one pair, with how to merge them', () => {
  const s = backlog();
  const noteA = s.id('capture', 'the jump is floaty over long gaps');
  const a = s.id('task', 'The jump feels floaty over long gaps', '--from', noteA);
  const noteB = s.id('capture', 'jump still floaty on long gaps');
  const b = s.id('task', 'Jump feels floaty on long gaps', '--from', noteB);
  const out = s.sp('list', '--alike');
  assert.equal(out.split('\n').filter((l) => /^ {2}\S+ +t-\w+/.test(l)).length, 2, out);
  assert.match(out, new RegExp(`${a}[^\\n]*\\n[^\\n]*${b}`));
  assert.match(out, /both say: .*jump.*floaty/);
  assert.match(out, new RegExp(`spool file ${noteB} --into ${a}, then spool drop ${b}`));
  assert.match(out, new RegExp(`spool archive ${b}`));
  assert.match(out, /^1 pair looks alike\.$/m);
});

test('a wish said a little differently is found, though the bar at filing lets it by', () => {
  const s = spool();
  const a = s.id('task', 'Show a hint after three deaths');
  const filed = s.sp('task', 'Show a hint when the player dies three times');
  assert.doesNotMatch(filed, /looks like/);
  const b = /(t-\w+)/.exec(filed)![1]!;
  const out = s.sp('list', '--alike');
  assert.match(out, new RegExp(a));
  assert.match(out, new RegExp(b));
});

test('three alike are three pairs, closest first, each once', () => {
  const s = spool();
  s.id('task', 'The jump feels floaty over long gaps');
  s.id('task', 'Jump feels floaty on long gaps');
  s.id('task', 'Jump feels floaty over long gaps');
  const data = s.json('list', '--alike');
  assert.equal(data.pairs.length, 3);
  const keys = data.pairs.map((p: { a: { id: string }; b: { id: string } }) => [p.a.id, p.b.id].sort().join());
  assert.equal(new Set(keys).size, 3);
  const scores = data.pairs.map((p: { score: number }) => p.score);
  assert.deepEqual(scores, [...scores].sort((x: number, y: number) => y - x));
  assert.match(s.sp('list', '--alike'), /^3 pairs look alike\.$/m);
});

test('done, dropped and archived threads are left out; held ones are not', () => {
  const s = spool();
  const keep = s.id('task', 'The jump feels floaty over long gaps');
  const done = s.id('task', 'Jump feels floaty on long gaps', '-s', 's');
  s.sp('done', done, '-m', 'Fixed.');
  const dropped = s.id('task', 'Jump feels floaty across long gaps');
  s.sp('drop', dropped, '-m', 'no');
  const archived = s.id('task', 'Jump feels floaty with long gaps');
  s.sp('archive', archived);
  assert.match(s.sp('list', '--alike'), /^Nothing alike/);
  const held = s.id('task', 'Jump is floaty over long gaps');
  s.sp('hold', held, '-m', 'later');
  const out = s.sp('list', '--alike');
  assert.match(out, new RegExp(keep));
  assert.match(out, new RegExp(held));
  for (const id of [done, dropped, archived]) assert.doesNotMatch(out, new RegExp(id));
});

test('threads cut from one note are not repeats of each other', () => {
  const s = spool();
  const note = s.id('capture', 'jump floaty long gaps, and the jump floaty feel again');
  s.id('task', 'The jump feels floaty over long gaps', '--from', note);
  s.id('task', 'Jump feels floaty on long gaps', '--from', note);
  assert.match(s.sp('list', '--alike'), /^Nothing alike/);
});

test('--json gives the pairs with a score; nothing alike says so in one line', () => {
  const s = backlog();
  assert.equal(s.sp('list', '--alike'), 'Nothing alike: no two open threads share enough words.');
  assert.deepEqual(s.json('list', '--alike').pairs, []);
  const a = s.id('task', 'The jump feels floaty over long gaps');
  const b = s.id('task', 'Jump feels floaty on long gaps');
  const { pairs } = s.json('list', '--alike');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a.id, a);
  assert.equal(pairs[0].b.id, b);
  assert.ok(pairs[0].score >= 0.5 && pairs[0].score <= 1);
  assert.ok(pairs[0].words.includes('floaty'));
});
