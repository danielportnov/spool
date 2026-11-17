/**
 * The terminal interface, with no terminal: `frame` draws a screen from a board and a state, and
 * `key` turns a key into a new state and maybe an action. Screens are compared as text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board } from '../src/board.ts';
import { width } from '../src/term.ts';
import { type State, frame, key, opening, rowsOf, settle } from '../src/tui.ts';
import { briefFixture, card, fixture, stateOf } from './tui-fixture.ts';

/**
 * A screen as text. It must be exactly as many lines as the terminal has rows, and every line
 * exactly as wide as the terminal; the spaces at the end of each line are then left off, to read.
 */
function screen(board: Board | null, state: State, cols: number, rows: number): string {
  const lines = frame(board, state, cols, rows);
  assert.equal(lines.length, rows, 'as many lines as rows');
  for (const line of lines) assert.equal(width(line), cols, `as wide as the terminal: "${line}"`);
  return lines.map((line) => line.trimEnd()).join('\n');
}

/** Press keys one after another, as the loop does, and give back the state and what each asked for. */
function press(board: Board, state: State, ...keys: string[]): { state: State; actions: unknown[] } {
  const actions: unknown[] = [];
  let now = settle(state, board);
  for (const k of keys) {
    const out = key(now, k, board);
    now = settle(out.state, board);
    if (out.action) actions.push(out.action);
  }
  return { state: now, actions };
}

const QUEUE_80 = `
 ▐▚▌── spool · skyhop 0.16.0   agents on · 2 building · 2 need you · page :4747
────────────────────────────────────┬───────────────────────────────────────────
 NEEDS YOU  2                       │ t-4kq7  Tighter jump     opus · high · 6m
  ? d-9d2a  Which font for the… 1-3 │ .spool/worktrees/t-4kq7  session 3b7f38ef
  ! t-e2b7  Credits screen  stopped │───────────────────────────────────────────
                                    │ Reading the jump code first.
 BUILDING  2 of 3                   │ → Read: src/player/jump.ts
> * t-4kq7  Tighter jump         6m │ → Edit: src/player/jump.ts
     The small platform is 3px too… │ Gravity is up from 28 to 34 at the top
  * t-b81c  Coins at sunset      2m │   of the arc.
     The coins use the noon sprite… │ → Bash: npm test
                                    │ ✗ 1 test failed: "clears the small
 BUILD  2              sprint: Feel │   platform"
  1 t-c0de  Double jump           m │ The small platform is 3px too far now.
  2 t-e2b7  Credits screen  stopped │   Shortening the hang time instead.
                                    │
 DONE, TO CHECK  2                  │
  + t-5aa1  Coyote time     +38 -12 │
  + t-0b2c  Fix wall clip     +6 -2 │
 BACKLOG  5                         │
────────────────────────────────────┴───────────────────────────────────────────

 r reply · esc interrupt · s stop · o open in Claude Code · tab its session
 up/down move · g agents · / add · ? keys · q leave, agents carry on`;

const QUEUE_120 = `
 ▐▚▌── spool · skyhop 0.16.0                                           agents on · 2 building · 2 need you · page :4747
────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────
 NEEDS YOU  2                                   │ t-4kq7  Tighter jump                                 opus · high · 6m
  ? d-9d2a  Which font for the HUD?         1-3 │ .spool/worktrees/t-4kq7                              session 3b7f38ef
  ! t-e2b7  Credits screen              stopped │───────────────────────────────────────────────────────────────────────
                                                │ Reading the jump code first.
 BUILDING  2 of 3                               │ → Read: src/player/jump.ts
> * t-4kq7  Tighter jump                     6m │ → Edit: src/player/jump.ts
     The small platform is 3px too far now. Sh… │ Gravity is up from 28 to 34 at the top of the arc.
  * t-b81c  Coins at sunset                  2m │ → Bash: npm test
     The coins use the noon sprite at every ho… │ ✗ 1 test failed: "clears the small platform"
                                                │ The small platform is 3px too far now. Shortening the hang time
 BUILD  2                          sprint: Feel │   instead.
  1 t-c0de  Double jump                       m │
  2 t-e2b7  Credits screen              stopped │
                                                │
 DONE, TO CHECK  2                              │
  + t-5aa1  Coyote time                 +38 -12 │
  + t-0b2c  Fix wall clip                 +6 -2 │
 BACKLOG  5                                     │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
                                                │
────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────

 r reply · esc interrupt · s stop · o open in Claude Code · tab its session
 up/down move · g agents on/off · / add a thread · ? all keys · q leave, agents carry on`;

test('the queue at 80 by 24: every section, and beside it the session of the agent the cursor is on', () => {
  assert.equal(`\n${screen(fixture(), stateOf(80, 24, { at: 'building:t-4kq7' }), 80, 24)}`, QUEUE_80);
});

test('the queue at 120 by 40: the same board, with room for all of it', () => {
  assert.equal(`\n${screen(fixture(), stateOf(120, 40, { at: 'building:t-4kq7' }), 120, 40)}`, QUEUE_120);
});

test('a terminal smaller than 80 by 24 is told so, plainly', () => {
  for (const [cols, rows] of [[79, 24], [80, 23], [40, 10]] as const) {
    const said = screen(fixture(), stateOf(cols, rows), cols, rows);
    assert.match(said.replace(/\s+/g, ' '), new RegExp(`Spool needs a terminal of 80 by 24 or more: this one is ${cols} by ${rows}\\.`));
    assert.match(said.replace(/\s+/g, ' '), /press q to leave\. spool --plain prints the status instead\./);
    assert.doesNotMatch(said, /NEEDS YOU/);
  }
  // Too small to act in: keys do nothing but leave.
  const small = stateOf(60, 20);
  assert.deepEqual(key(small, 'b', fixture()), { state: small });
  assert.deepEqual(key(small, 'q', fixture()).action, { do: 'quit' });
});

test('the header says who builds, how much, what needs him, and where the page is', () => {
  const top = (board: Board | null, over: Partial<State> = {}, cols = 80): string => screen(board, stateOf(cols, 24, over), cols, 24).split('\n')[0]!;
  const board = fixture();
  assert.equal(top(board), ' ▐▚▌── spool · skyhop 0.16.0   agents on · 2 building · 2 need you · page :4747');
  // A page this run started says so. Short of room, the project's version is the first thing to go.
  assert.equal(top(board, { page: { url: 'http://127.0.0.1:4747/', started: true, lost: false } }), ' ▐▚▌── spool · skyhop  agents on · 2 building · 2 need you · started page :4747');
  assert.equal(top(board, { page: { url: 'http://127.0.0.1:4747/', started: true, lost: false } }, 90), ' ▐▚▌── spool · skyhop 0.16.0     agents on · 2 building · 2 need you · started page :4747');
  assert.match(top(board, { page: { url: 'http://127.0.0.1:4747/', started: false, lost: true } }), /page :4747 not answering$/);
  // Then the end of the project's name: the right side is never cut.
  assert.equal(top({ ...board, project: 'skyhop-the-sequel' }, { page: { url: 'http://127.0.0.1:14747/', started: true, lost: false } }), ' ▐▚▌── spool · skyho… agents on · 2 building · 2 need you · started page :14747');
  assert.match(top({ ...board, runner: { ...board.runner, on: false } }), /agents off · 2 building/);
  assert.match(top({ ...board, runner: { ...board.runner, builder: 'chat' } }), /a chat builds · 2 building/);
  assert.match(top({ ...board, needs: { ...board.needs, questions: [] } }), /1 needs you/);
  // In colour, the mark is the one the terminal was given, and the line is as wide as it was.
  const painted = frame(board, stateOf(80, 24, { mark: '\x1b[38;5;202m▐▚▌\x1b[39m\x1b[2m──\x1b[22m \x1b[1mspool\x1b[22m' }), 80, 24)[0]!;
  assert.ok(painted.startsWith(' \x1b[38;5;202m▐▚▌\x1b[39m\x1b[2m──\x1b[22m \x1b[1mspool\x1b[22m · skyhop 0.16.0 '));
  assert.equal(width(painted), 80);
  // Before the page has answered, there is only where it is.
  assert.equal(top(null), ' ▐▚▌── spool                                                         page :4747');
  assert.match(screen(null, stateOf(80, 24), 80, 24), /Asking the page at :4747 for the board…/);
  assert.match(screen(null, stateOf(80, 24, { page: { url: '', started: true, lost: false } }), 80, 24), /Starting the page in the background…/);
});

test('up and down, and j and k, move the cursor through every row, and stop at the ends', () => {
  const board = fixture();
  const keys = rowsOf(board, stateOf(80, 24)).map((r) => r.key);
  assert.deepEqual(keys, ['needs:d-9d2a', 'needs:t-e2b7', 'building:t-4kq7', 'building:t-b81c', 'build:t-c0de', 'build:t-e2b7', 'done:t-5aa1', 'done:t-0b2c', 'backlog:']);

  let state = settle(stateOf(80, 24), board);
  assert.equal(state.at, 'needs:d-9d2a', 'it starts on the first thing that needs him');
  state = press(board, state, 'up', 'k').state;
  assert.equal(state.at, 'needs:d-9d2a');
  state = press(board, state, 'down', 'j').state;
  assert.equal(state.at, 'building:t-4kq7');
  assert.match(screen(board, state, 80, 24), /^> \* t-4kq7  Tighter jump/m);
  state = press(board, state, ...Array(20).fill('down')).state;
  assert.equal(state.at, 'backlog:');
  state = press(board, state, 'k').state;
  assert.equal(state.at, 'done:t-0b2c');

  // A row that goes (he approved it, an agent finished it) leaves the cursor where it was in the list.
  const fewer = fixture();
  fewer.columns.done.pop();
  assert.equal(settle(state, fewer).at, 'backlog:');
  // A scroll of what is beside the queue does not outlive the row it was a scroll of.
  assert.equal(press(board, { ...state, scroll: 4 }, 'up').state.scroll, null);
});

test('enter opens the backlog to a list, sprints and their threads together, and closes it again', () => {
  const board = fixture();
  let state = press(board, stateOf(80, 24, { at: 'backlog:' }), 'enter').state;
  assert.equal(state.backlog, true);
  assert.deepEqual(
    rowsOf(board, state).filter((r) => r.section === 'backlog').map((r) => `${r.mark} ${r.id} ${r.title} ${r.tail}`.trim()),
    ['BACKLOG 5', '- t-7c1d Pause menu m', '- t-3e9a Leaderboard l', '- t-d44e Gamepad support hold', '# r-f331 Feel 2 waiting', '- t-1f3e Sunset palette s', '- t-aa90 Save slots l'],
  );
  state = press(board, state, 'down', 'down', 'down', 'down').state;
  const said = screen(board, state, 80, 24);
  // Longer than the screen, the list shows the part around the cursor.
  assert.doesNotMatch(said, /NEEDS YOU/);
  assert.match(said, /^> # r-f331  Feel          2 waiting │/m);
  assert.match(said, /│ r-f331  Feel             sprint · running$/m);
  assert.match(said, /│ 2 of 7 done · 2 waiting$/m);
  assert.match(said, /^ p play it: its 2 threads move to Build · tab read it$/m);
  state = press(board, state, ...Array(4).fill('up'), 'enter').state;
  assert.equal(state.backlog, false);
  assert.equal(rowsOf(board, state).filter((r) => r.section === 'backlog').length, 1);
});

test('each key is the POST the page makes for the same thing', () => {
  const board = fixture();
  const on = (at: string, k: string, over: Partial<State> = {}): unknown => press(board, stateOf(80, 24, { at, ...over }), k).actions[0];
  const open = { backlog: true };

  // b: a backlog thread to Build; a stopped one carries on.
  assert.deepEqual(on('backlog:t-7c1d', 'b', open), { do: 'post', action: 'move', body: { id: 't-7c1d', to: 'build' }, done: 'In build: Pause menu' });
  assert.deepEqual(on('needs:t-e2b7', 'b'), { do: 'post', action: 'move', body: { id: 't-e2b7', to: 'building' }, done: 'Building: Credits screen' });
  assert.deepEqual(on('build:t-e2b7', 'b'), { do: 'post', action: 'move', body: { id: 't-e2b7', to: 'building' }, done: 'Building: Credits screen' });
  // p: the sprint the cursor is on, or the sprint of the thread it is on.
  assert.deepEqual(on('backlog:r-f331', 'p', open), { do: 'post', action: 'play', body: { id: 'r-f331' }, done: 'Feel is running' });
  assert.deepEqual(on('backlog:t-aa90', 'p', open), { do: 'post', action: 'play', body: { id: 'r-f331' }, done: 'Feel is running' });
  // s: stop the agent on that thread, and no other.
  assert.deepEqual(on('building:t-b81c', 's'), { do: 'post', action: 'stop', body: { id: 't-b81c' }, done: 'Stopped. It waits in Build until you carry on.' });
  // a: a finished thread is complete.
  assert.deepEqual(on('done:t-5aa1', 'a'), { do: 'post', action: 'complete', body: { id: 't-5aa1' }, done: 'Marked as complete' });
  // 1 to 9: that option of the question.
  assert.deepEqual(on('needs:d-9d2a', '2'), { do: 'post', action: 'answer', body: { id: 'd-9d2a', choice: '2' }, done: 'Answered: Rounded' });
  // g: the Agents switch.
  assert.deepEqual(on('needs:d-9d2a', 'g'), { do: 'post', action: 'runner', body: { on: false }, done: '' });
  // q and Ctrl-C leave, and ask nothing of the page.
  assert.deepEqual(on('building:t-4kq7', 'q'), { do: 'quit' });
  assert.deepEqual(on('building:t-4kq7', 'ctrl-c'), { do: 'quit' });

  // A key with nothing under the cursor to act on asks nothing, and says what it is for.
  for (const [at, k, why] of [
    ['done:t-5aa1', 'b', /^b sends a backlog thread to Build/],
    ['building:t-4kq7', 'b', /^b sends a backlog thread to Build/],
    ['build:t-c0de', 'p', /^p plays a sprint/],
    ['backlog:t-7c1d', 'p', /^p plays a sprint/],
    ['done:t-5aa1', 's', /^s stops the agent/],
    ['build:t-c0de', 'a', /^a approves a finished thread/],
    ['building:t-4kq7', '1', /^A number answers a question/],
    ['needs:d-9d2a', '7', /^That question has 3 options\.$/],
  ] as const) {
    const out = press(board, stateOf(80, 24, { at, backlog: true }), k);
    assert.deepEqual(out.actions, [], `${k} on ${at}`);
    assert.match(out.state.said, why, `${k} on ${at}`);
  }
  // What a key said is gone at the next key.
  assert.equal(press(board, stateOf(80, 24, { at: 'done:t-5aa1', said: 'Marked as complete' }), 'down').state.said, '');

  // A plan waiting for his go-ahead is approved from Needs you; a thread waiting on a question is answered from its own row.
  const more = fixture();
  more.needs.plans.push({ id: 't-91ab', title: 'Plan the level editor', summary: 'Three parts.', parts: ['Grid', 'Palette', 'Save'] });
  more.columns.done.push(card('t-91ab', 'Plan the level editor', 'done', { type: 'plan' }));
  more.columns.build.push(card('t-3e9b', 'HUD shows the coin count', 'build', { question: { id: 'd-9d2a', title: 'Which font for the HUD?', options: ['Pixel', 'Rounded', 'Mono'], recommend: 1 }, waiting: { kind: 'you', text: 'Which font for the HUD?', on: [], said: '', refused: [] } }));
  assert.deepEqual(press(more, stateOf(80, 24, { at: 'needs:t-91ab' }), 'a').actions, [{ do: 'post', action: 'approve', body: { id: 't-91ab' }, done: 'The plan has your go-ahead' }]);
  assert.deepEqual(press(more, stateOf(80, 24, { at: 'build:t-3e9b' }), '1').actions, [{ do: 'post', action: 'answer', body: { id: 'd-9d2a', choice: '1' }, done: 'Answered: Pixel' }]);
  const plan = screen(more, stateOf(80, 24, { at: 'needs:t-91ab' }), 80, 24);
  assert.match(plan, /^> ! t-91ab  Plan the level ed… plan │/m);
  assert.match(plan, /│ Waits for your go-ahead: a gives it$/m);
  assert.match(plan, /^ a give the go-ahead · tab read it$/m);
  const asked = screen(more, stateOf(80, 24, { at: 'build:t-3e9b' }), 80, 24);
  assert.match(asked, /^> 3 t-3e9b  HUD shows the co… waits │/m);
  assert.match(asked, /│ t-3e9b  HUD shows the coin count  waiting$/m);
  assert.match(asked, /│ Needs your answer\n.*│   Which font for the HUD\?\n.*│   1  Pixel  \(I would pick\)\n.*│   2  Rounded$/m);
  assert.match(asked, /^ 1-3 answer it · tab read it$/m);
});

test('/ takes one line and files it; a paste is text, and esc leaves it', () => {
  const board = fixture();
  let out = press(board, stateOf(80, 24), '/', 'W', 'a', 'l', 'k', ' ', 'j', 'u', 'm', 'q', 'backspace', 'p');
  assert.equal(out.state.adding, 'Wal' + 'k jump', 'letters that are commands elsewhere are only letters here');
  assert.deepEqual(out.actions, []);
  const said = screen(board, out.state, 80, 24).split('\n');
  assert.equal(said[21], ' add a thread > Walk jump_');
  assert.equal(said[22], ' enter file it in the backlog · esc leave it');
  out = press(board, out.state, 'paste: off\nthe wall\n', 'enter');
  assert.deepEqual(out.actions, [{ do: 'post', action: 'add', body: { text: 'Walk jump off the wall', to: 'proposed' }, done: 'Added to the backlog' }]);
  assert.equal(out.state.adding, null);

  assert.equal(press(board, stateOf(80, 24), '/', 'x', 'esc').state.adding, null);
  assert.deepEqual(press(board, stateOf(80, 24), '/', ' ', 'enter').actions, [], 'an empty line files nothing');
  // A line longer than its room shows its end, where he is typing.
  const long = press(board, stateOf(80, 24), '/', `paste:${'word '.repeat(30)}end`).state;
  assert.match(screen(board, long, 80, 24).split('\n')[21]!, /^ add a thread > .* word end_$/);
});

test('enter reads what is beside the queue, and it scrolls by the line and by the page', () => {
  const board = fixture();
  let state = press(board, stateOf(80, 24, { at: 'done:t-5aa1' }), 'enter').state;
  assert.equal(state.focus, 'side');
  let said = screen(board, state, 80, 24);
  assert.match(said, /│ t-5aa1  Coyote time        done, to check$/m);
  assert.match(said, /│ Result\n.*│   A jump within 90ms of leaving a ledge\n.*│   counts as if still on it\.$/m);
  assert.match(said, /│ To check\n.*│   1  Run npm start and walk off the first\n.*│      ledge\.$/m);
  assert.match(said, /│ … 5 more lines: down, or pgdn$/m);
  assert.match(said, /^ up\/down scroll · pgup\/pgdn a page · home\/end its ends · tab back to the queue$/m);

  state = press(board, state, 'down', 'down').state;
  assert.equal(state.scroll, 2);
  assert.equal(state.at, 'done:t-5aa1', 'the cursor stays where it was');
  state = press(board, state, 'end').state;
  said = screen(board, state, 80, 24);
  assert.match(said, /│ Last lines\n.*│   01-01 10:41 page: handed to `claude\n.*│     -p --model sonnet`\n.*│   01-01 10:58 claude: done: A jump\n.*│     within 90ms of leaving a ledge counts\n.*│     as if still on it\.$/m);
  assert.doesNotMatch(said, /more lines/);
  state = press(board, state, 'pagedown').state;
  assert.equal(state.scroll, 5, 'no further than its end');
  state = press(board, state, 'pageup').state;
  assert.equal(state.scroll, null, 'back at its start, it is not scrolled at all');
  state = press(board, state, 'esc', 'down').state;
  assert.deepEqual([state.focus, state.at], ['queue', 'done:t-0b2c']);
  // From the queue, the page keys still scroll what is beside it.
  assert.equal(press(board, stateOf(80, 24, { at: 'done:t-5aa1' }), 'pagedown').state.scroll, 5);
});

test('it opens on the brief when something shipped since he last looked and nothing is being built', () => {
  const board = fixture();
  board.brief = briefFixture();
  // With agents at work, the queue is the news.
  assert.equal(opening(stateOf(80, 24), board).view, 'queue');
  board.columns.building = [];
  board.runner.running = [];
  let state = settle(opening(stateOf(80, 24), board), board);
  assert.equal(state.view, 'brief');
  assert.equal(
    `\n${screen(board, state, 80, 24)}`,
    `
 ▐▚▌── spool · skyhop 0.16.0   agents on · 0 building · 2 need you · page :4747
────────────────────────────────────────────────────────────────────────────────
 3 threads shipped since you last looked, over 2h · 2 need you

 NEEDS YOU  2
   ? Which font for the HUD?  (d-9d2a, blocks 1 thread)
     1  Pixel  (I would pick)
     2  Rounded
     3  Mono
   ! Credits screen  (t-e2b7)
     stopped from the page, 40m ago
     last said: Laying out the names in two columns.

 WORTH A LOOK  1
   1. Coyote time  (t-5aa1)
      A jump within 90ms of leaving a ledge counts as if still on it.
      why: the check failed once first · 9 files changed
      to check:
        1) Run npm start and walk off the first ledge.
 … 9 more lines: down, or pgdn
────────────────────────────────────────────────────────────────────────────────

 enter the queue · up/down scroll · pgup/pgdn a page
 ? all keys · q leave, agents carry on`,
  );
  // Keys that act on the queue do nothing while it is out of sight.
  assert.deepEqual(press(board, state, 'b', 's', 'a', '1', 'g', '/').actions, []);
  state = press(board, state, 'pagedown').state;
  const rest = screen(board, state, 80, 24);
  assert.match(rest, /^ ALSO SHIPPED  2\n   \+ Fix wall clip: The player no longer slides through the left wall\.\n     \(t-0b2c\)\n   Feel\n     \+ Faster respawn  \(t-61fa\)$/m);
  assert.match(rest, /^ CALLS AGENTS MADE  1\n   Coyote time: how long\? → 90ms, as most platformers do  \(d-71c0\)$/m);
  state = press(board, state, 'enter').state;
  assert.deepEqual([state.view, state.scroll], ['queue', null]);
  assert.match(screen(board, state, 80, 24), /^ NEEDS YOU  2 /m);

  // With nothing shipped there is no brief to open on.
  assert.equal(opening(stateOf(80, 24), { ...board, brief: null }).view, 'queue');
  assert.equal(opening(stateOf(80, 24), { ...board, brief: { ...briefFixture(), shipped: 0 } }).view, 'queue');
});

test('? shows every key, and any key goes back', () => {
  const board = fixture();
  const state = press(board, stateOf(80, 24, { at: 'building:t-4kq7' }), '?').state;
  assert.equal(state.view, 'keys');
  const said = screen(board, state, 80, 24);
  for (const name of ['up, down, j, k', 'enter', 'tab', 'pgup, pgdn', 'home, end', 'b', 'p', 's', 'a', '1 to 9', 'g', '/', '?', 'q']) {
    assert.match(said, new RegExp(`^   ${name.replace(/[?/]/g, '\\$&')} +\\S`, 'm'), name);
  }
  assert.match(said, /q +leave\. The page stays up and its agents carry on$/m);
  assert.doesNotMatch(said, /more line/, 'the whole list fits the smallest terminal');
  const back = press(board, state, 's');
  assert.deepEqual([back.state.view, back.actions], ['queue', []], 'the key that closes the list does nothing else');
});

test('the line above the keys says the one thing about the page he should know', () => {
  const note = (board: Board, over: Partial<State> = {}): string => screen(board, stateOf(80, 24, over), 80, 24).split('\n')[21]!;
  const board = fixture();
  assert.equal(note(board), '');
  assert.equal(note({ ...board, runner: { ...board.runner, on: false } }), ' Agents are off, so nothing in Build starts: g switches them on.');
  assert.equal(note({ ...board, runner: { ...board.runner, builder: 'chat' } }), ' A chat builds here, and none is watching: say /spool-loop in one.');
  assert.equal(note({ ...board, notice: 'Rebuilding Spool…' }), ' Rebuilding Spool…');
  assert.match(note(board, { page: { url: 'http://127.0.0.1:4747/', started: false, lost: true } }), /^ The page is not answering\./);
  // What an action said comes first.
  assert.equal(note({ ...board, runner: { ...board.runner, on: false } }, { said: 'In build: Pause menu' }), ' In build: Pause menu');
});

test('wide and odd letters, and whatever an agent prints, never break the screen', () => {
  const board = fixture();
  board.project = 'スカイホップ';
  board.columns.building[0]!.title = 'より引き締まったジャンプ 👩‍💻 tighter';
  board.columns.building[0]!.why = '頂点での浮遊感が強すぎる。Le saut est trop flottant: café 🧶🧶🧶 été.';
  board.columns.build[0]!.title = '🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶🧶';
  board.columns.done[0]!.title = 'ｆｕｌｌｗｉｄｔｈ　ｔｉｔｌｅ　ｈｅｒｅ';
  board.needs.questions[0]!.title = '한글 제목이 아주 길어서 잘려야 합니다 정말로';
  board.runner.running[0]!.lines = ['\x1b[31mred\x1b[0m and a\ttab', 'bell\x07 and \x1b[2J clear \x1b[H home', '日本語の行がとても長くて折り返さなければならない場合のテスト', '👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻👩‍💻'];
  for (const [cols, rows] of [[80, 24], [81, 25], [97, 31], [120, 40], [200, 60]] as const) {
    for (const at of ['needs:d-9d2a', 'building:t-4kq7', 'build:t-c0de', 'done:t-5aa1', 'backlog:']) {
      // `screen` holds every line to the terminal's width.
      const said = screen(board, stateOf(cols, rows, { at, backlog: true, focus: 'side' }), cols, rows);
      assert.doesNotMatch(said, /[\x00-\x09\x0b-\x1f\x7f]/, 'nothing that moves the cursor is drawn');
      assert.equal(said.split('\n').filter((line) => line.includes('│')).length, rows - 6, 'the line between the two sides runs unbroken');
    }
  }
  const said = screen(board, stateOf(80, 24, { at: 'building:t-4kq7' }), 80, 24);
  assert.match(said, /│ red and a tab$/m);
  assert.match(said, /│ bell and +clear +home$/m);
});
