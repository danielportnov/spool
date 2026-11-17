/**
 * Steering from the terminal screen: r writes to a running agent, Esc tells it to stop what it is
 * doing, y a n answer its question about a tool call, and o lends the terminal to Claude Code and
 * takes it back. First the keys and the screens on a board made by hand, then played through for
 * real, by keys alone, against a stand-in agent that speaks lines recorded from Claude Code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ctx } from '../src/context.ts';
import { pageUp } from '../src/detach.ts';
import { ENTER, LEAVE } from '../src/term.ts';
import { type State, frame, key, settle, watchQueue } from '../src/tui.ts';
import { claude, printed, recorded } from './claude.ts';
import { Sandbox, startPage, until } from './helpers.ts';
import { Keyboard, Process, Screen } from './term-standin.ts';
import { fixture, stateOf } from './tui-fixture.ts';

const text = (lines: string[]): string => lines.map((l) => l.trimEnd()).join('\n');
const ASK = { ask: 'q1', tool: 'Bash', what: 'Bash: npm publish --dry-run', full: 'Bash: npm publish --dry-run', why: 'To see what would ship.', rest: 'Bash: npm publish', since: '2026-01-01T11:59:00Z', until: '2026-01-01T12:09:00Z' };
const on = (board = fixture(), over: Partial<State> = {}): State => settle(stateOf(100, 30, { at: 'building:t-4kq7', ...over }), board);

test('r takes a line for the agent on the thread, and Enter sends it as a note on that thread', () => {
  const board = fixture();
  let state = key(on(board), 'r', board).state;
  assert.equal(state.reply, '');
  for (const k of ['k', 'e', 'e', 'p', ' ', 'q']) state = key(state, k, board).state;
  assert.equal(state.reply, 'keep q', 'q is a letter here, not a way out');
  state = key(state, 'backspace', board).state;
  assert.match(text(frame(board, state, 100, 30)), /^ to t-4kq7 > keep _$/m);
  assert.match(text(frame(board, state, 100, 30)), /enter send it to the agent · esc drop it/);
  const sent = key(state, 'enter', board);
  assert.deepEqual([sent.state.reply, sent.action], [null, { do: 'post', action: 'note', body: { id: 't-4kq7', text: 'keep' }, done: "Sent to t-4kq7's agent" }]);
  assert.equal(key(state, 'esc', board).state.reply, null, 'esc drops it');
  assert.equal(key(key(state, 'esc', board).state, 'enter', board).action, undefined);
  // Not on a thread being built: it says so.
  const elsewhere = key(on(board, { at: 'build:t-c0de' }), 'r', board).state;
  assert.equal(elsewhere.reply, null);
  assert.match(elsewhere.said, /^r writes to the agent on a thread being built/);
});

test('Esc interrupts the agent that can be spoken to; beside the queue it only goes back', () => {
  const board = fixture();
  assert.deepEqual(key(on(board), 'esc', board).action, { do: 'post', action: 'interrupt', body: { id: 't-4kq7' }, done: 'Told to stop what it is doing. It waits for your reply.' });
  const inside = key(on(board, { focus: 'side' }), 'esc', board);
  assert.deepEqual([inside.state.focus, inside.action], ['queue', undefined]);
  board.runner.running[0]!.listens = false;
  assert.equal(key(on(board), 'esc', board).action, undefined, 'an agent that is only watched is not spoken to');
  assert.equal(key(on(fixture(), { at: 'build:t-c0de' }), 'esc', fixture()).action, undefined);
});

test('an agent asking for a yes is a row under Needs you and a box beside its session; y, a and n answer it', () => {
  const board = fixture();
  board.runner.running[0]!.asking = ASK;
  const screen = text(frame(board, on(board, { at: 'needs:t-4kq7' }), 100, 30));
  assert.match(screen, /^> ! t-4kq7 {2}wants: Bash: npm pub… +y a n │/m);
  assert.match(screen, /NEEDS YOU {2}3/);
  assert.match(screen, /│ It wants to run\n.*│ {3}Bash: npm publish --dry-run\n.*│ {3}For: To see what would ship\./);
  assert.match(screen, /│ {3}y allow once · a allow for the rest of this run \(Bash:/);
  assert.match(screen, /y allow once · a allow for this run · n no · r reply · esc interrupt · s stop · o open/);
  for (const at of ['needs:t-4kq7', 'building:t-4kq7']) {
    const post = (k: string) => key(on(board, { at }), k, board).action;
    assert.deepEqual(post('y'), { do: 'post', action: 'permit', body: { id: 't-4kq7', ask: 'q1', answer: 'once' }, done: 'Allowed once.' });
    assert.deepEqual(post('a'), { do: 'post', action: 'permit', body: { id: 't-4kq7', ask: 'q1', answer: 'run' }, done: 'Allowed for the rest of this run.' });
    assert.deepEqual(post('n'), { do: 'post', action: 'permit', body: { id: 't-4kq7', ask: 'q1', answer: 'no' }, done: 'Refused. The agent is told.' });
  }
  // With nothing asked, a is still approve, and y and n do nothing.
  const quiet = fixture();
  assert.deepEqual(key(on(quiet, { at: 'done:t-5aa1' }), 'a', quiet).action, { do: 'post', action: 'complete', body: { id: 't-5aa1' }, done: 'Marked as complete' });
  assert.equal(key(on(quiet), 'y', quiet).action, undefined);
  assert.equal(key(on(quiet), 'n', quiet).action, undefined);
});

test('o asks to open the thread’s session, for a thread that has been started; the keys are in ? and under the row', () => {
  const board = fixture();
  assert.deepEqual(key(on(board), 'o', board).action, { do: 'open', id: 't-4kq7' });
  assert.deepEqual(key(on(board, { at: 'build:t-c0de' }), 'o', board).action, { do: 'open', id: 't-c0de' });
  assert.match(key(on(board, { at: 'needs:d-9d2a' }), 'o', board).state.said, /^o opens a thread/);
  assert.match(text(frame(board, on(board), 100, 30)), /r reply · esc interrupt · s stop · o open in Claude Code/);
  const help = text(frame(board, key(on(board), '?', board).state, 100, 40));
  for (const what of ['write to a running agent', 'esc tells it to stop and listen', 'yes once, for the run, or no', 'open the thread in Claude Code']) assert.ok(help.includes(what), what);
});

// ------------------------------------------------------------------ for real

const DONE = 'spool done "$SPOOL_TASK" -m "finished" > /dev/null';
const init = printed('two-turns', (e) => e.subtype === 'init')[0]!;
const said = printed('two-turns', (e) => e.type === 'assistant');
const results = printed('two-turns', (e) => e.type === 'result');
const stopped = recorded('interrupt-running-tool');
const fromAgent = stopped.filter((r) => r.dir === '<');
const interrupted = fromAgent.slice(fromAgent.findIndex((r) => r.event?.type === 'control_response')).map((r) => r.line);

function ctxOf(s: Sandbox): Ctx {
  return { cwd: s.root, env: { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined }, out: () => {}, err: () => {}, now: () => new Date(), stdin: () => '', lines: () => {}, color: false, inherit: false, tty: true };
}

/** The screen, played by a Keyboard: what the loop drew last, and what it opened and closed. */
function screen(s: Sandbox, opts: { openIn?: (id: string) => void } = {}) {
  const input = new Keyboard();
  const output = new Screen(110, 30);
  const proc = new Process();
  let last: string[] = [];
  const record = pageUp(ctxOf(s), s.root);
  assert.ok(record, 'a page is up');
  const left = watchQueue({ ctx: ctxOf(s), root: s.root, page: record, started: false, io: { input, output }, color: false, proc, seen: (l) => (last = l), every: 100, ...opts });
  const now = (): string => text(last);
  return { input, output, left, now, shows: (what: string, pattern: RegExp) => until(`the screen shows ${what}`, () => pattern.test(now())) };
}

test('played through by keys alone: reply to a running agent, interrupt it, and let it finish', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const fake = claude(s, ['hear', 'say first', 'while hear; do', `  case "$heard" in *'"subtype":"interrupt"'*) say interrupted;; *"finish now"*) ${DONE}; say over;; esac`, 'done'].join('\n'), {
    first: [init, said[0]!],
    over: [said[1]!, results[1]!],
    interrupted,
  });
  const page = await startPage(s, '--run', '--agent', fake.agent);
  const view = screen(s);
  try {
    await view.shows('the agent at work', new RegExp(`^> +\\* ${jump} `, 'm'));
    await until('the agent has said something', async () => /apple/.test(view.now()));

    view.input.type('r');
    await view.shows('the reply line', new RegExp(`^ to ${jump} > _$`, 'm'));
    view.input.type('keep gravity at 34');
    view.input.type('\r');
    await until('the agent is told', () => fake.heard(1)[1]?.message?.content === 'keep gravity at 34');
    await view.shows('what it did', new RegExp(`^ Sent to ${jump}'s agent$`, 'm'));
    await view.shows('its lines show it', /you: keep gravity at 34/);

    view.input.type('\x1b');
    await view.shows('the words', /^ Told to stop what it is doing\. It waits for your reply\.$/m);
    await until('the agent is told to stop', () => fake.heard(1)[2]?.request?.subtype === 'interrupt');
    assert.equal(s.json('show', jump).item.state, 'active', 'still building: interrupted is not stopped');

    view.input.type('r');
    view.input.type('finish now');
    view.input.type('\r');
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');

    view.input.type('q');
    await view.left;
    assert.ok(view.output.written.endsWith(LEAVE));
  } finally {
    view.input.type('\x03');
    await page.stop();
    s.cleanup();
  }
});

test('played through by keys alone: an agent asks to run something, and a lets it for the rest of its run', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  const run = recorded('allow-for-the-run').filter((r) => r.dir === '<');
  const at = run.findIndex((r) => r.event?.type === 'control_request');
  const fake = claude(s, ['hear', 'say asks', 'hear', DONE, 'say rest', 'while hear; do :; done'].join('\n'), {
    asks: run.slice(0, at + 1).map((r) => r.line),
    rest: run.slice(at + 1).filter((r) => r.event?.type !== 'system').map((r) => r.line),
  });
  const page = await startPage(s, '--run', '--agent', fake.agent);
  const view = screen(s);
  try {
    await view.shows('the question under Needs you', new RegExp(`^[> ] {1,2}! ${jump} {2}wants: Bash: touch k1\\.txt +y a n │`, 'm'));
    await view.shows('the box beside it', /│ It wants to run/);
    view.input.type('a');
    await view.shows('what it did', /^ Allowed for the rest of this run\.$/m);
    await until('the thread is finished', () => s.json('show', jump).item.status === 'done');
    assert.match(s.item(jump), /allowed by the human for the rest of this run: Bash: touch k1\.txt/);
    view.input.type('q');
    await view.left;
  } finally {
    view.input.type('\x03');
    await page.stop();
    s.cleanup();
  }
});

test('o lends the terminal to Claude Code and comes back to the same screen, on the same row', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  s.sp('build', jump, coins);
  const page = await startPage(s);
  const opened: { id: string; writtenThen: string }[] = [];
  const view = screen(s, { openIn: (id) => opened.push({ id, writtenThen: view.output.written }) });
  try {
    await view.shows('Build', new RegExp(`^ {2}2 ${coins} `, 'm'));
    view.input.type('j');
    await view.shows('the cursor on the second', new RegExp(`^> 2 ${coins} `, 'm'));
    view.input.type('o');
    await view.shows('that it is back', new RegExp(`^ Back from ${coins}\\.$`, 'm'));
    assert.deepEqual(opened.map((o) => o.id), [coins]);
    // The terminal was given back before Claude Code, and taken again after.
    assert.ok(opened[0]!.writtenThen.endsWith(LEAVE), 'the screen was left first');
    assert.ok(view.output.written.endsWith(ENTER) === false && view.output.written.slice(opened[0]!.writtenThen.length).startsWith(ENTER), 'and drawn again after');
    assert.equal(view.input.raw, true);
    assert.match(view.now(), new RegExp(`^> 2 ${coins} `, 'm'), 'on the same row');
    view.input.type('q');
    await view.left;
  } finally {
    view.input.type('\x03');
    await page.stop();
    s.cleanup();
  }
});
