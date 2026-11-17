import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

/** Claim a thread, commit `files` changed files under its trailer, and finish it. */
function ship(s: Sandbox, id: string, summary: string, files = 1): void {
  s.sp('start', id);
  for (let i = 0; i < files; i++) s.write(`src/${id}-${i}.txt`, `${summary} ${i}\n`);
  s.commitAll(`${summary}\n\nSpool: ${id}`);
  s.sp('done', id, '-m', summary);
}

function sandbox(): Sandbox {
  const s = spool();
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  return s;
}

test('with nothing shipped, the brief says so in a line, and that nothing needs you', () => {
  const s = sandbox();
  const out = s.sp('brief');
  assert.match(out, /^🌅 Nothing shipped since you last looked · nothing needs you\n\nNothing needs you: /);
  assert.doesNotMatch(out, /WORTH A LOOK|SHIPPED|CALLS|approve --all/);
  assert.match(out, /The board: spool page/);
  s.cleanup();
});

test('a night of work: what needs you first, then the threads worth a look and why, then the rest', () => {
  const s = sandbox();
  const big = s.id('task', 'Rebuild the level editor', '-s', 'l');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 's');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  s.sp('sprint', 'Polish');
  const menu = s.id('task', 'Round the menu corners', '-s', 'xs', '--sprint', 'Polish');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const music = s.id('task', 'Fade the music between levels', '-s', 's');

  s.advance(1);
  ship(s, big, 'The editor saves as you go, and undo works across levels', 9);
  s.sp('start', coins);
  s.sp('assume', 'Outline the coins, or turn them teal?', '--chose', 'A dark outline', '--for', coins);
  s.write('src/coins.txt', 'outlined\n');
  s.commitAll(`Outline the coins\n\nSpool: ${coins}`);
  s.sp('done', coins, '-m', 'Coins have a dark outline, so they show against the sunset');
  s.advance(2);
  ship(s, typo, 'The title says Spool, not Sppol');
  ship(s, menu, 'Menu corners are rounded');
  // One the agent walked away from, and one it asked about.
  s.sp('start', jump);
  s.sp('log', jump, 'I could not find where the jump arc is set');
  s.sp('build', '--abort', jump);
  s.sp('ask', 'Fade over one second, or two?', '--option', 'One second', '--option', 'Two seconds', '--recommend', '2', '--for', music);
  s.advance(5);

  const out = s.sp('brief');
  const lines = out.split('\n');
  assert.equal(lines[0], '🌅 4 threads shipped since you last looked, over 2h · 2 need you');
  for (const l of lines) assert.ok([...l].length <= 100, `short enough for a phone: ${l}`);
  const at = (text: string) => out.indexOf(text);
  assert.ok(at('NEEDS YOU') < at('WORTH A LOOK') && at('WORTH A LOOK') < at('ALSO SHIPPED') && at('ALSO SHIPPED') < at('CALLS AGENTS MADE'), out);

  // Needs you: the question with its options, and the thread that was stopped, with what its agent last said.
  assert.match(out, /🔴 NEEDS YOU {2}2\n {2}❓ Fade over one second, or two\? {2}· blocks 1 thread · d-\w+\n {5}1\) One second · 2\) Two seconds ← I would pick\n {5}spool answer d-\w+ 2/);
  assert.match(out, new RegExp(`↺ Tighten the jump arc {2}· ${jump}\\n {5}stopped while agent was building it, \\d+h ago\\n {5}last said: “I could not find where the jump arc is set”`));

  // Worth a look: the large one first, then the one an agent made a call on; each with what changed and why.
  assert.match(out, new RegExp(`🟡 WORTH A LOOK {2}2\\n {2}1\\. Rebuild the level editor {2}· ${big}\\n {5}The editor saves as you go[^\\n]*\\n {5}why: large · 9 files changed\\n {2}2\\. Make coins readable at sunset {2}· ${coins}\\n {5}Coins have a dark outline[^\\n]*\\n {5}why: 1 call an agent made`));

  // The rest, a line each, the sprint's under its name.
  assert.match(out, new RegExp(`🟢 ALSO SHIPPED {2}2\\n {2}✓ Fix the typo on the title screen — The title says Spool, not Sppol {2}· ${typo}\\n {2}🏁 Polish\\n {4}✓ Round the menu corners — Menu corners are rounded {2}· ${menu}`));
  assert.match(out, /🧾 CALLS AGENTS MADE {2}1[^\n]*\n {2}Outline the coins, or turn them teal\? → A dark outline {2}· d-\w+/);
  assert.match(lines.at(-1)!, /^All good\? spool approve --all {3}· {3}The board: spool page/);

  // Approved, it is all looked at: the next brief starts from there.
  s.sp('approve', '--all');
  assert.match(s.sp('brief'), /^🌅 Nothing shipped since you last looked · 2 need you\n/);
  s.cleanup();
});

test('a thread redone after a revert, or whose check failed first, is worth a look', () => {
  const s = sandbox();
  const redo = s.id('task', 'Speed up the loading screen', '-s', 's');
  ship(s, redo, 'Loads in half the time');
  s.sp('revert', redo, '-m', 'it flickers now');
  s.sp('build', redo);
  ship(s, redo, 'Loads in half the time, without the flicker');
  const tried = s.id('task', 'Save high scores', '-s', 's');
  ship(s, tried, 'High scores are kept between runs');
  // What a page run keeps of the agent: here, the check refusing its first spool done.
  s.write(`.spool/runs/${tried}/2026-01-01T00-00-00-000Z.jsonl`, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'spool: the check failed (exit 1): npm test' }] } })}\n`);

  const out = s.sp('brief');
  assert.match(out, new RegExp(`Speed up the loading screen {2}· ${redo}\\n[^\\n]*\\n {5}why: redone after a revert`));
  assert.match(out, new RegExp(`Save high scores {2}· ${tried}\\n[^\\n]*\\n {5}why: the check failed once first`));
  s.cleanup();
});

test('--since narrows it to threads finished since then', () => {
  const s = sandbox();
  const early = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const late = s.id('task', 'Round the menu corners', '-s', 'xs');
  ship(s, early, 'The title is spelled right');
  s.advance(12);
  ship(s, late, 'Menu corners are rounded');

  const out = s.sp('brief', '--since', '8h');
  assert.match(out, /^🌅 1 thread shipped in the last 8h · nothing needs you\n/);
  assert.match(out, /Round the menu corners/);
  assert.doesNotMatch(out, /Fix the typo/);
  assert.match(s.sp('brief'), /^🌅 2 threads shipped since you last looked, over 12h/);
  assert.match(s.sp('brief', '--since', '2026-01-01'), /^🌅 2 threads shipped since 2026-01-01/);
  assert.match(s.fails('brief', '--since', 'last full moon'), /"last full moon" is not a time to start from/);
  s.cleanup();
});

test('--json gives the same brief as data, for a page to draw', () => {
  const s = sandbox();
  const big = s.id('task', 'Rebuild the level editor', '-s', 'l');
  const small = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const wait = s.id('task', 'Fade the music between levels', '-s', 's');
  ship(s, big, 'The editor saves as you go', 2);
  ship(s, small, 'The title is spelled right');
  const d = s.id('ask', 'Fade over one second, or two?', '--option', 'One', '--option', 'Two', '--for', wait);

  const b = s.json('brief');
  assert.equal(b.headline, '2 threads shipped since you last looked, over 3m · 1 needs you');
  assert.equal(b.since, null);
  assert.equal(b.shipped, 2);
  assert.deepEqual(b.needsYou.questions, [{ id: d, title: 'Fade over one second, or two?', options: ['One', 'Two'], recommend: null, blocks: 1, project: 'demo' }]);
  assert.deepEqual(b.needsYou.plans, []);
  assert.deepEqual(b.needsYou.stopped, []);
  assert.deepEqual(b.worthALook, [{ id: big, title: 'Rebuild the level editor', summary: 'The editor saves as you go', steps: [], size: 'l', files: 2, reasons: ['large'], project: 'demo', pictures: 0 }]);
  assert.deepEqual(b.alsoShipped, [{ sprint: null, threads: [{ id: small, title: 'Fix the typo on the title screen', summary: 'The title is spelled right', project: 'demo' }] }]);
  assert.deepEqual(b.calls, []);
  assert.equal(b.approve, 'spool approve --all');
  assert.equal(b.board, 'spool page');
  const since = s.json('brief', '--since', '8h').since;
  assert.equal(since.said, '8h');
  assert.ok(Number.isFinite(Date.parse(since.from)));
  s.cleanup();
});
