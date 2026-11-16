import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board } from '../src/page.ts';
import { Workspace } from '../src/store.ts';
import { type Sandbox, spool } from './helpers.ts';

function ship(s: Sandbox, id: string, summary: string): void {
  s.sp('start', id);
  s.write(`src/${id}.txt`, `${summary}\n`);
  s.commitAll(`${summary}\n\nSpool: ${id}`);
  s.sp('done', id, '-m', summary);
}

test('the board carries the morning brief, made again only when the spool changed', () => {
  const s = spool();
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  const big = s.id('task', 'Rebuild the level editor', '-s', 'l');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const music = s.id('task', 'Fade the music between levels', '-s', 's');
  const read = () => board(Workspace.open(s.root, () => new Date('2026-01-02T00:00:00Z')));

  // Nothing shipped and nothing needs him: there is no brief to show.
  assert.equal(read().brief, null);

  ship(s, big, 'The editor saves as you go');
  ship(s, typo, 'The title is spelled right');
  s.sp('start', jump);
  s.sp('log', jump, 'I could not find where the jump arc is set');
  s.sp('build', '--abort', jump);
  const asked = s.id('ask', 'Fade over one second, or two?', '--option', 'One', '--option', 'Two', '--for', music);

  const b = read().brief!;
  assert.match(b.headline, /^2 threads shipped since you last looked, over \d+m · 2 need you$/);
  assert.deepEqual(b.needsYou.questions.map((q) => [q.id, q.options]), [[asked, ['One', 'Two']]]);
  assert.deepEqual(b.needsYou.stopped.map((t) => [t.id, t.lastSaid]), [[jump, 'I could not find where the jump arc is set']]);
  assert.deepEqual(b.worthALook.map((t) => [t.id, t.reasons]), [[big, ['large']]]);
  assert.deepEqual(b.alsoShipped.flatMap((g) => g.threads.map((t) => t.id)), [typo]);
  assert.equal(b.approve, 'spool approve --all');

  // Asked again with nothing changed, it is the one already made: git is not asked again.
  assert.equal(read().brief, b);

  // Approved and answered, nothing shipped is left to look at; the stopped thread still needs him.
  s.sp('approve', '--all');
  s.sp('answer', asked, '2');
  const after = read().brief!;
  assert.notEqual(after, b);
  assert.equal(after.shipped, 0);
  assert.deepEqual(after.needsYou.questions, []);
  assert.deepEqual(after.needsYou.stopped.map((t) => t.id), [jump]);
  s.cleanup();
});
