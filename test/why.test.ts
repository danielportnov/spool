import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { spool } from './helpers.ts';

const SPEC = 'What: a shorter hang at the top\nWhy: the jump feels floaty, and players overshoot\n  the first gap\nDone when: the first level feels snappy';

test('each open thread says why it exists, in the loop\'s list and the brief one', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-b', SPEC);
  s.id('task', 'Fix the typo | on the title screen', '-s', 'xs', '-b', 'What: the typo\nWhy: it reads "Sky Hpo" | not "Sky Hop"');
  s.sp('start', jump);

  const table = s.sp('overview', '--table').split('\n');
  // The reason rides with the name, in one line: a reason that runs over two lines is joined.
  assert.ok(table.includes('| 1 | **Tighten the jump arc** — the jump feels floaty, and players overshoot the first gap | Small | Normal | 🔵 Being built now |'), table.join('\n'));
  assert.ok(table.some((l) => l.startsWith('| 2 | **Fix the typo \\| on the title screen** — it reads "Sky Hpo" \\| not "Sky Hop" |')), 'a pipe in the reason does not break the table');

  const brief = s.sp('overview', '--brief');
  assert.match(brief, /Building: Tighten the jump arc \(the jump feels floaty, and players overshoot the first gap\)/);
  assert.match(brief, /Next in build: Fix the typo \| on the title screen \(it reads "Sky Hpo" \| not "Sky Hop"\)/);
  s.cleanup();
});

test('a Why is read from the spec only: never from the user\'s quoted words, and a thread with none shows nothing', () => {
  const s = spool();
  const note = s.id('capture', 'Why: is the sky so pale at night?');
  const quoted = s.id('task', 'Darker night sky', '--from', note);
  const plain = s.id('task', 'Bare thread');
  const table = s.sp('overview', '--table');
  assert.match(table, /\*\*Darker night sky\*\* \|/, 'the user\'s words are not the spec');
  assert.match(table, /\*\*Bare thread\*\* \|/);

  // spool check names every open thread with no reason, and is quiet once one is given.
  const warned = s.json('check').warnings as string[];
  assert.deepEqual(warned.filter((w) => w.includes('no Why')).map((w) => w.split(' ')[0]).sort(), [plain, quoted].sort());
  s.sp('edit', plain, '-b', '**Why:** so it is not bare');
  s.sp('drop', quoted);
  assert.deepEqual((s.json('check').warnings as string[]).filter((w) => w.includes('no Why')), [], 'a closed thread needs none, and bold labels count');

  // An idea an agent suggested carries its reason with it.
  s.sp('task', 'Remember the last level', '--suggested', 'players come back mid-way');
  assert.deepEqual((s.json('check').warnings as string[]).filter((w) => w.includes('no Why')), []);
  s.cleanup();
});

test('the card carries its Why, and an idea with its own Why does not say it twice', () => {
  const s = spool();
  s.sp('init', '--gate', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc', '-b', SPEC);
  const idea = s.id('task', 'Remember the last level', '--suggested', 'players come back mid-way');
  const both = s.id('task', 'Save mid-level', '--suggested', 'an agent noticed', '-b', 'Why: losing a run hurts');
  const ws = Workspace.open(s.dir, () => new Date('2026-01-01T01:00:00Z'));
  try {
    const cards = Object.fromEntries(board(ws).columns.proposed.map((c) => [c.id, c]));
    assert.equal(cards[jump]!.why, 'the jump feels floaty, and players overshoot the first gap');
    assert.deepEqual([cards[idea]!.why, cards[idea]!.note], ['', 'Why: players come back mid-way']);
    assert.deepEqual([cards[both]!.why, cards[both]!.note], ['losing a run hurts', '']);
  } finally {
    ws.close();
  }
  s.cleanup();
});
