import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changes } from '../src/watch.ts';
import { Sandbox, startPage } from './helpers.ts';

/** A project in Chat mode with a weekly target, its gate on, and three threads in the backlog. */
function chatProject(gate = '--gate'): { s: Sandbox; top: string; suggested: string; held: string; next: string } {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', gate);
  const typed = (...args: string[]) => {
    const r = s.exec(args, { tty: true });
    if (r.code !== 0) throw new Error(r.err);
    return r.out;
  };
  typed('builder', 'chat');
  typed('target', '--weekly', '80');
  const suggested = s.id('task', 'An idea of the agent', '--suggested', 'it would help', '-p', '0');
  const held = s.id('task', 'Parked until the launch', '-p', '0', '--hold', 'after the launch');
  const top = s.id('task', 'Tighten the jump', '-p', '1', '-s', 'xs');
  const next = s.id('task', 'Add a mute button', '-s', 's');
  return { s, top, suggested, held, next };
}

test('with taking over off, an agent moves nothing to build; on, it moves the top thread a person filed, signed, up to the target', () => {
  const { s, top, suggested, held, next } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    assert.match(s.sp('takeover'), /^The chat does not take over skyhop's backlog: nothing moves to Build without you\./);
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /taking over the backlog is off in skyhop/);

    assert.match(s.sp('takeover', 'on'), /^The chat takes over skyhop's backlog[\s\S]*Next: t-\w+ Tighten the jump/);
    assert.equal(s.json('takeover').next.id, top);
    // An agent's idea and a parked thread are not its to take, whatever their priority.
    assert.match(s.fails('build', suggested, '--takeover', '--as', 'Claude'), /AI suggested/);
    assert.match(s.fails('build', held, '--takeover', '--as', 'Claude'), /on hold/);

    // The reading must be fresh: an hour on, it reads the usage again first.
    s.advance(1);
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /usage has not been read in the last 30 minutes/);
    s.sp('usage', '--weekly', '40');
    assert.match(s.sp('build', '--takeover', '--as', 'Claude'), /In build:\n.*Tighten the jump/);
    assert.match(s.item(top), /Claude: moved to build, taking over the backlog: weekly 40% of 80%/);

    // One at a time: with that waiting in Build, nothing more moves.
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /Build has work waiting/);
    assert.equal(s.json('show', next).item.status, 'proposed');

    // Built and done, the next may move, until the target is reached.
    s.sp('start', top, '--as', 'Claude');
    s.sp('done', top, '-m', 'Tighter', '--as', 'Claude');
    s.sp('usage', '--weekly', '81');
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /the usage target is reached, weekly 81% of 80%/);
    assert.equal(s.json('show', next).item.status, 'proposed');

    // The brief says the chat moved it itself.
    assert.match(s.sp('brief'), /the chat moved it to Build itself, taking over the backlog/);

    // Off again, nothing moves.
    s.sp('takeover', 'off');
    s.sp('usage', '--weekly', '10');
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /taking over the backlog is off/);
    assert.equal(s.json('show', next).item.status, 'proposed');
  } finally {
    s.cleanup();
  }
});

test('taking over needs Chat mode and a usage target', () => {
  const { s } = chatProject();
  try {
    s.sp('takeover', 'on');
    s.sp('usage', '--weekly', '10');
    s.exec(['target', '--weekly', 'none'], { tty: true });
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /no usage target is set/);
    s.exec(['target', '--weekly', '80'], { tty: true });
    s.exec(['builder', 'headless'], { tty: true });
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /built headless/);
  } finally {
    s.cleanup();
  }
});

test('where the gate is locked, only the human switches taking over on; anyone switches it off', () => {
  const { s, top } = chatProject('--lock');
  try {
    assert.match(s.fails('takeover', 'on'), /human's alone.*locked/s);
    assert.match(s.exec(['takeover', 'on'], { tty: true }).out, /The chat takes over/);
    // Once they did, the chat moves a thread under it, as under a leave they gave.
    s.sp('usage', '--weekly', '10');
    s.sp('build', '--takeover', '--as', 'Claude');
    assert.equal(s.json('show', top).item.status, 'open');
    assert.match(s.sp('takeover', 'off'), /does not take over/);
  } finally {
    s.cleanup();
  }
});

test('the watch tells the chat when taking over is switched on', () => {
  const seen = (on: string[]) => ({ ready: new Map(), said: new Map(), inbox: new Set<string>(), asks: new Map(), takeOver: new Set(on) });
  assert.deepEqual(changes(seen([]), seen(['skyhop']), () => '', () => ''), ['takeover: skyhop — they switched taking over the backlog on: Build empty? spool build --takeover']);
  assert.deepEqual(changes(seen(['skyhop']), seen([]), () => '', () => ''), []);
});

test('the board says whether the chat takes over, and its switch is the command', async () => {
  const { s, top } = chatProject();
  const { url, stop } = await startPage(s);
  try {
    const board = async (): Promise<any> => (await (await fetch(`${url}api/board`)).json()) as any;
    assert.deepEqual((await board()).takeOver, { on: false, next: null, waiting: null });
    s.sp('takeover', 'on');
    const on = (await board()).takeOver;
    assert.equal(on.on, true);
    assert.equal(on.next.id, top);
    assert.match(on.waiting, /usage has not been read/);
  } finally {
    await stop();
    s.cleanup();
  }
});

test('a thread the human undid waits for them: taking over does not move it', () => {
  const { s, top } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    s.sp('takeover', 'on');
    s.sp('build', top);
    s.sp('start', top, '--as', 'Claude');
    s.sp('done', top, '-m', 'Tighter', '--as', 'Claude');
    s.sp('revert', top, '-m', 'too tight');
    assert.equal(s.json('show', top).item.status, 'proposed');
    assert.match(s.fails('build', top, '--takeover', '--as', 'Claude'), /was undone: it waits for the human/);
    assert.notEqual(s.json('takeover').next?.id, top);
    // Once they move it to Build, it is theirs to have built.
    s.sp('build', top);
    assert.equal(s.json('show', top).item.status, 'open');
  } finally {
    s.cleanup();
  }
});
