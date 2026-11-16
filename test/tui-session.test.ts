/**
 * One agent, watched in the terminal: the session beside the queue. First as screens drawn from
 * a board made by hand, then for real, with three stand-in agents at work under a real page.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Board } from '../src/board.ts';
import type { Ctx } from '../src/context.ts';
import { pageUp } from '../src/detach.ts';
import { width } from '../src/term.ts';
import { type State, frame, key, settle, threadAt, watchQueue } from '../src/tui.ts';
import { Sandbox, startPage, until } from './helpers.ts';
import { Keyboard, Process, Screen } from './term-standin.ts';
import { JUMP_LINES, card, fixture, stateOf } from './tui-fixture.ts';

/** What is beside the queue on a screen, a line each, without the spaces that fill it out. Every line of the screen is held to the terminal's width first. */
function beside(board: Board, state: State, cols: number, rows: number): string[] {
  const lines = frame(board, state, cols, rows);
  assert.equal(lines.length, rows);
  for (const line of lines) assert.equal(width(line), cols, line);
  return lines.slice(2, rows - 4).map((line) => line.slice(line.indexOf('│') + 1).trimEnd());
}

const press = (board: Board, state: State, ...keys: string[]): State => keys.reduce((now, k) => settle(key(now, k, board).state, board), settle(state, board));

/** A run of `n` lines, as the page gives them. */
const run = (id: string, n: number): NonNullable<State['run']> => ({ id, run: '2026-01-01T11-53-48-000Z', next: n, lines: Array.from({ length: n }, (_, i) => `line ${i + 1} of the run`), live: true });

test('beside a thread being built is its agent\'s session: what it was started with, where, and every line it said', () => {
  const board = fixture();
  const said = beside(board, stateOf(80, 24, { at: 'building:t-4kq7' }), 80, 24);
  assert.deepEqual(said.slice(0, 13), [
    ' t-4kq7  Tighter jump     opus · high · 6m',
    ' .spool/worktrees/t-4kq7  session 3b7f38ef',
    '───────────────────────────────────────────',
    ' Reading the jump code first.',
    ' → Read: src/player/jump.ts',
    ' → Edit: src/player/jump.ts',
    ' Gravity is up from 28 to 34 at the top',
    '   of the arc.',
    ' → Bash: npm test',
    ' ✗ 1 test failed: "clears the small',
    '   platform"',
    ' The small platform is 3px too far now.',
    '   Shortening the hang time instead.',
  ]);
  // The other agent has its own, and nothing of the first one's.
  const other = beside(board, stateOf(80, 24, { at: 'building:t-b81c' }), 80, 24);
  assert.deepEqual(other.slice(0, 5), [' t-b81c  Coins at su… sonnet · medium · 2m', ' .spool/worktrees/t-b81c  session 9c41d0aa', '───────────────────────────────────────────', ' → Read: src/world/coins.ts', ' The coins use the noon sprite at every']);
  assert.ok(!other.join('\n').includes('jump'));

  // Built in the project's own folder, started with nothing said, and nothing heard yet.
  const plain = fixture();
  plain.columns.building[0] = { ...plain.columns.building[0]!, worktree: '', run: { model: '', effort: '', why: '', session: '' } };
  plain.runner.running[0]!.lines = [];
  assert.deepEqual(beside(plain, stateOf(80, 24, { at: 'building:t-4kq7' }), 80, 24).slice(0, 4), [' t-4kq7  Tighter jump                   6m', ' the project’s own folder', '───────────────────────────────────────────', ' Nothing said yet.']);

  // A thread a chat is building is not this page's to hear, and the screen says so.
  const chat = fixture();
  chat.runner.running = [];
  chat.columns.building[0] = { ...chat.columns.building[0]!, thread: { ...chat.columns.building[0]!.thread, by: 'claude' }, live: { since: '2026-01-01T11:53:48Z', note: 'Halfway through the arc.' } };
  const outside = beside(chat, stateOf(80, 24, { at: 'building:t-4kq7', run: run('t-4kq7', 5) }), 80, 24).join('\n');
  assert.match(outside, / claude is building this outside the page,\n so its lines are not here\. Its last note:\n Halfway through the arc\./);
  assert.doesNotMatch(outside, /of the run/, 'lines kept from an earlier run are not shown as what it is doing now');
});

test('the run\'s own lines take over from the few the board carries, and the session follows its end', () => {
  const board = fixture();
  const at = { at: 'building:t-4kq7' };
  // The board has the newest lines of the run; the page, asked, has all of it.
  let said = beside(board, stateOf(80, 24, { ...at, run: run('t-4kq7', 40) }), 80, 24);
  assert.deepEqual(said.slice(3, 5), [' line 26 of the run', ' line 27 of the run']);
  assert.equal(said.at(-1), ' line 40 of the run', 'the newest line is the last on the screen');
  assert.ok(!said.join('\n').includes(JUMP_LINES[0]!));
  // Lines held for another thread are not this one's: the board's show until its own arrive.
  said = beside(board, stateOf(80, 24, { ...at, run: run('t-b81c', 40) }), 80, 24);
  assert.equal(said[3], ` ${JUMP_LINES[0]}`);

  // As lines arrive, the end stays in sight.
  said = beside(board, stateOf(80, 24, { ...at, run: run('t-4kq7', 41) }), 80, 24);
  assert.deepEqual([said[3], said.at(-1)], [' line 27 of the run', ' line 41 of the run']);
  // On a taller screen there is room for more of it.
  said = beside(board, stateOf(120, 40, { ...at, run: run('t-4kq7', 41) }), 120, 40);
  assert.deepEqual([said[3], said.at(-1)], [' line 11 of the run', ' line 41 of the run']);
});

test('scrolled up, the session holds still while lines arrive; End follows it again', () => {
  const board = fixture();
  let state = press(board, stateOf(80, 24, { at: 'building:t-4kq7', run: run('t-4kq7', 40) }), 'pageup');
  assert.equal(state.scroll, 11, 'a page up from the end: 40 lines in 15 rows, less one row kept in sight');
  let said = beside(board, state, 80, 24);
  assert.deepEqual([said[3], said[16]], [' line 12 of the run', ' line 25 of the run']);
  assert.equal(said.at(-1), ' … 14 more lines: end follows them again');
  assert.equal(state.at, 'building:t-4kq7', 'the cursor has not moved');

  // Ten more lines are said. What he is reading has not moved; only the count below has.
  state = { ...state, run: run('t-4kq7', 50) };
  said = beside(board, state, 80, 24);
  assert.deepEqual([said[3], said[16]], [' line 12 of the run', ' line 25 of the run']);
  assert.equal(said.at(-1), ' … 24 more lines: end follows them again');

  // Further up, to the start, and it stops there.
  state = press(board, state, 'pageup', 'pageup');
  assert.equal(state.scroll, 0);
  assert.equal(beside(board, state, 80, 24)[3], ' line 1 of the run');
  state = press(board, state, 'pagedown');
  assert.equal(state.scroll, 14);

  // End: it follows again, and is not scrolled at all.
  state = press(board, state, 'end');
  assert.equal(state.scroll, null);
  assert.equal(beside(board, state, 80, 24).at(-1), ' line 50 of the run');
  state = { ...state, run: run('t-4kq7', 51) };
  assert.equal(beside(board, state, 80, 24).at(-1), ' line 51 of the run');
  // Paging down to the end is the same as End.
  assert.equal(press(board, { ...state, scroll: 30 }, 'pagedown').scroll, null);
  assert.equal(press(board, state, 'home').scroll, 0);

  // Moving to another thread starts that one at its own end.
  state = press(board, press(board, state, 'pageup'), 'down');
  assert.deepEqual([state.at, state.scroll], ['building:t-b81c', null]);
});

test('tab moves between the queue and the session, and the arrows go with it', () => {
  const board = fixture();
  let state = press(board, stateOf(80, 24, { at: 'building:t-4kq7', run: run('t-4kq7', 40) }), 'tab');
  assert.equal(state.focus, 'side');
  const keys = frame(board, state, 80, 24)[22]!.trimEnd();
  assert.equal(keys, ' up/down scroll · pgup/pgdn a page · home/end its ends · tab back to the queue');
  // In the session, up and down scroll it a line at a time and leave the cursor alone.
  state = press(board, state, 'up', 'up', 'k');
  assert.deepEqual([state.at, state.scroll], ['building:t-4kq7', 22]);
  state = press(board, state, 'down', 'j', 'down');
  assert.equal(state.scroll, null, 'back at the end, it follows');
  // The keys that act still act on the thread in focus.
  assert.deepEqual(key(state, 's', board).action, { do: 'post', action: 'stop', body: { id: 't-4kq7' }, done: 'Stopped. It waits in Build until you carry on.' });
  state = press(board, state, 'tab');
  assert.equal(state.focus, 'queue');
  assert.equal(frame(board, state, 80, 24)[22]!.trimEnd(), ' s stop its agent · tab its session · pgup/pgdn scroll it');
  assert.equal(press(board, state, 'down').at, 'building:t-b81c');
  // Esc goes back to the queue too, and Enter goes in as Tab does.
  assert.equal(press(board, state, 'enter').focus, 'side');
  assert.equal(press(board, state, 'tab', 'esc').focus, 'queue');
});

test('a thread that is not being built shows what its agent last said, once the page has been asked', () => {
  const board = fixture();
  assert.equal(threadAt(board, settle(stateOf(80, 24, { at: 'done:t-5aa1' }), board)), 't-5aa1');
  assert.equal(threadAt(board, settle(stateOf(80, 24, { at: 'needs:d-9d2a' }), board)), '', 'a question has no run');
  assert.equal(threadAt(board, settle(stateOf(80, 24, { at: 'backlog:' }), board)), '');
  const held = { id: 't-5aa1', run: '2026-01-01T10-41-00-000Z', next: 3, lines: ['→ Bash: npm test', '→ Bash: spool done t-5aa1', 'finished · 12 turns — Coyote time is in.'], live: false };
  const said = beside(board, stateOf(120, 40, { at: 'done:t-5aa1', run: held }), 120, 40).join('\n');
  assert.match(said, / Its agent last said\n {3}→ Bash: npm test\n {3}→ Bash: spool done t-5aa1\n {3}finished · 12 turns — Coyote time is in\.$/m);
  assert.doesNotMatch(said, /Last lines/);
  // With no run to read, it is the last of what is written on the thread.
  assert.match(beside(board, stateOf(120, 40, { at: 'done:t-5aa1' }), 120, 40).join('\n'), / Last lines\n {3}01-01 10:41 page: handed to/);
});

test('wide letters in what an agent says wrap inside the session, and never past its edge', () => {
  const board = fixture();
  board.columns.building.push(card('t-9zzz', '全角のタイトル', 'building', { live: { since: '2026-01-01T11:59:00Z', note: '' }, worktree: '.spool/worktrees/t-9zzz' }));
  const lines = ['日本語の行がとても長くて折り返さなければならない場合のテストです。', '→ Read: src/プレイヤー/ジャンプ.ts', '👩‍💻 pairing 👩‍💻 with 👩‍💻 emoji 👩‍💻 that 👩‍💻 join 👩‍💻 and é marks', 'a\ttab, a bell\x07 and \x1b[31mcolour\x1b[0m'];
  board.runner.running.push({ id: 't-9zzz', seconds: 60, lines, listens: false, asking: null });
  for (const [cols, rows] of [[80, 24], [93, 27], [120, 40]] as const) {
    const said = beside(board, stateOf(cols, rows, { at: 'building:t-9zzz' }), cols, rows);
    for (const line of said) assert.ok(width(line) <= cols - Math.max(36, Math.min(48, Math.floor(cols * 0.4))) - 1, line);
    assert.equal(said[3], cols === 80 ? ' 日本語の行がとても長くて折り返さなけれ' : said[3]);
    assert.ok(said.some((line) => line === ' a tab, a bell and colour'), 'nothing that moves the cursor is drawn');
  }
});

// ------------------------------------------------------------------ for real

/** A stand-in agent: it says which thread it is on, a hundred lines at once, and then a line every fifth of a second until `go` is there. */
function talker(s: Sandbox): string {
  const file = path.join(s.root, 'talker.sh');
  const script = [
    '#!/bin/sh',
    'cat > /dev/null',
    'echo "I am on $SPOOL_TASK"',
    'n=0',
    'while [ $n -lt 100 ]; do n=$((n + 1)); echo "$SPOOL_TASK early line $n"; done',
    `while [ ! -f "${path.join(s.root, 'go')}" ]; do`,
    '  n=$((n + 1))',
    '  echo "$SPOOL_TASK says line $n"',
    '  sleep 0.2',
    'done',
  ];
  fs.writeFileSync(file, `${script.join('\n')}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('three agents at work: moving between them shows each one\'s own lines within a second, from the start of its run', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  // A git repository, so each thread has a worktree of its own and three are built at once.
  s.gitInit();
  fs.writeFileSync(path.join(s.root, '.git', 'info', 'exclude'), '.home/\ntalker.sh\ngo\n');
  s.write('README.md', 'Sky Hop\n');
  s.commitAll('start');
  const ids = [s.id('task', 'Tighten the jump arc'), s.id('task', 'Make coins readable at sunset'), s.id('task', 'Add a pause menu')];
  s.sp('build', ...ids);
  const page = await startPage(s, '--run', '--agent', talker(s));
  const input = new Keyboard();
  try {
    const ctx: Ctx = { cwd: s.root, env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined }, out: () => {}, err: () => {}, now: () => new Date(), stdin: () => '', lines: () => {}, color: false, inherit: false, tty: true };
    const record = pageUp(ctx, s.root);
    assert.ok(record);
    let last: string[] = [];
    const proc = new Process();
    const left = watchQueue({ ctx, root: s.root, page: record, started: false, io: { input, output: new Screen(100, 30) }, color: false, proc, seen: (lines) => (last = lines), every: 100 });
    const text = (): string => last.map((line) => line.trimEnd()).join('\n');
    /** What is beside the queue now. */
    const side = (): string[] => last.slice(2, -4).map((line) => line.slice(line.indexOf('│') + 1).trimEnd());
    /** The thread the cursor is on, read off the screen. */
    const cursorOn = (): string => /^> +\S+ (t-[a-z0-9]+)/m.exec(text())?.[1] ?? '';

    await until('three agents at work', () => /BUILDING {2}3 of 3/.test(text()) && ids.every((id) => text().includes(`${id} says line`)));
    // Each row in Building has its own agent's last line under it.
    for (const id of ids) assert.match(text(), new RegExp(`^[ >] \\* ${id} .*\\n {5}${id} says line \\d+`, 'm'));

    for (const id of ids) {
      // Down, until the cursor is on this thread.
      for (let i = 0; i < 6 && cursorOn() !== id; i++) {
        input.type('j');
        await until('the key was taken', () => true);
      }
      await until(`the cursor is on ${id}`, () => cursorOn() === id, { timeout: 1000 });
      // Its own lines, and nobody else's, within a second of getting there: the board already carries its newest.
      await until(`${id}'s own lines`, () => side().some((line) => line.startsWith(` ${id} says line`)), { timeout: 1000 });
      for (const other of ids.filter((x) => x !== id)) assert.ok(!side().some((line) => line.includes(other)), `none of ${other}'s lines beside ${id}`);
      assert.match(side()[0]!, new RegExp(`^ ${id} {2}.* \\d+s$`), 'its heading: the thread and how long');
      assert.equal(side()[1], ` .spool/worktrees/${id}`, 'and the folder it is built in');
    }

    // The session goes back to the start of the run: further than the lines the board carries.
    const watched = ids[2]!;
    input.type('\x1b[H');
    await until('the start of the run', () => side()[3] === ` I am on ${watched}`);
    assert.equal(side()[4], ` ${watched} early line 1`);
    // Scrolled up, it holds still while the agent goes on talking below.
    const below = (): number => Number(/… (\d+) more lines: end follows them again$/.exec(side().at(-1) ?? '')?.[1] ?? 0);
    const before = below();
    assert.ok(before > 60, 'more than the board holds');
    await until('more has been said', () => below() >= before + 3);
    assert.equal(side()[3], ` I am on ${watched}`);
    // End follows again: the newest line is at the foot, and keeps being.
    input.type('\x1b[F');
    const newest = (): number => Number(new RegExp(`^ ${watched} says line (\\d+)$`).exec(side().findLast((line) => line.trim()) ?? '')?.[1] ?? 0);
    const now = await until('the newest line', newest);
    await until('it follows', () => newest() >= now + 3);

    // Tab into the session and stop it from there: that agent ends, and the other two work on.
    input.type('\t');
    input.type('s');
    await until('it has stopped', () => new RegExp(`! ${watched} .* stopped`).test(text()));
    assert.match(text(), /BUILDING {2}2 of 3/);
    input.type('q');
    assert.deepEqual(await left, { url: page.url, building: 2 });
    assert.equal(page.child.exitCode, null);
  } finally {
    input.type('\x03');
    fs.writeFileSync(path.join(s.root, 'go'), '');
    await page.stop();
    s.cleanup();
  }
});
