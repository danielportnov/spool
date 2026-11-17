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
  // The user's own, filed from what they said.
  const top = s.id('task', 'Tighten the jump', '-p', '1', '-s', 'xs', '--from', s.id('capture', 'the jump feels floaty'));
  const next = s.id('task', 'Add a mute button', '-s', 's', '--from', s.id('capture', 'I want a mute button'));
  return { s, top, suggested, held, next };
}

test('with taking over off, an agent moves nothing to build; on, it moves the top thread the user filed first, signed, up to the target', () => {
  const { s, top, suggested, held, next } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    assert.match(s.sp('takeover'), /^Agent take over is off for skyhop: nothing moves to Build without you\./);
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /taking over the backlog is off in skyhop/);

    assert.match(s.sp('takeover', 'on'), /^⚠️ Agent take over is on for skyhop[\s\S]*Next: t-\w+ Tighten the jump/);
    assert.equal(s.json('takeover').next.id, top);
    // An agent's idea waits behind the user's own, whatever its priority, and a parked thread is not its to take.
    assert.match(s.fails('build', suggested, '--takeover', '--as', 'Claude'), /an agent's idea, and the user's own t-\w+ comes first/);
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

test('where the gate is locked, only the user switches taking over on; anyone switches it off', () => {
  const { s, top } = chatProject('--lock');
  try {
    assert.match(s.fails('takeover', 'on'), /user's alone.*locked/s);
    assert.match(s.exec(['takeover', 'on'], { tty: true }).out, /Agent take over is on/);
    // Once they did, the chat moves a thread under it, as under a leave they gave.
    s.sp('usage', '--weekly', '10');
    s.sp('build', '--takeover', '--as', 'Claude');
    assert.equal(s.json('show', top).item.status, 'open');
    assert.match(s.sp('takeover', 'off'), /take over is off/);
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
    assert.deepEqual((await board()).takeOver, { on: false, next: null, waiting: null, tidy: null });
    s.sp('takeover', 'on');
    const on = (await board()).takeOver;
    assert.equal(on.on, true);
    assert.equal(on.next?.id, top, JSON.stringify(on));
    assert.match(on.waiting, /usage has not been read/);
  } finally {
    await stop();
    s.cleanup();
  }
});

test('a thread the user undid waits for them: taking over does not move it', () => {
  const { s, top } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    s.sp('takeover', 'on');
    s.sp('build', top);
    s.sp('start', top, '--as', 'Claude');
    s.sp('done', top, '-m', 'Tighter', '--as', 'Claude');
    s.sp('revert', top, '-m', 'too tight');
    assert.equal(s.json('show', top).item.status, 'proposed');
    assert.match(s.fails('build', top, '--takeover', '--as', 'Claude'), /was undone: it waits for the user/);
    assert.notEqual(s.json('takeover').next?.id, top);
    // Once they move it to Build, it is theirs to have built.
    s.sp('build', top);
    assert.equal(s.json('show', top).item.status, 'open');
  } finally {
    s.cleanup();
  }
});

test('taking over, the chat tidies the backlog itself once a night: sizes and orders, proposes drops, the brief says so, one undo takes it back', () => {
  const { s, top, suggested, next } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    // Off, no tidy is the chat's to run.
    assert.match(s.fails('manage', '--start', '--takeover', '--as', 'Claude'), /no tidy is due: taking over the backlog is off/);
    s.sp('takeover', 'on');
    assert.match(s.sp('takeover'), /Next tidy: due now: spool manage --start --takeover/);
    assert.equal(s.json('takeover').tidy.due, true);

    // With Build waiting, the tidy waits for it to empty.
    s.sp('build', '--takeover', '--as', 'Claude');
    assert.match(s.fails('manage', '--start', '--takeover', '--as', 'Claude'), /no tidy is due: Build has work waiting/);
    s.sp('start', top, '--as', 'Claude');
    s.sp('done', top, '-m', 'Tighter', '--as', 'Claude');

    // Over the target, no tidy either.
    s.sp('usage', '--weekly', '90');
    assert.match(s.fails('manage', '--start', '--takeover', '--as', 'Claude'), /no tidy is due: the usage target is reached/);
    s.sp('usage', '--weekly', '40');

    const sheet = s.sp('manage', '--start', '--takeover', '--as', 'Claude');
    assert.match(sheet, /Run by the chat itself, taking over the backlog: nobody asked for this pass/);
    const run = /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!;
    const under = { env: { SPOOL_RUN: run } };
    assert.equal(s.exec(['edit', next, '--size', 'm', '-p', '0', '--as', 'Claude'], under).code, 0);
    assert.equal(s.exec(['manage', '--propose', 'drop', suggested, '-m', 'a repeat of the jump', '--as', 'Claude'], under).code, 0);
    assert.equal(s.exec(['manage', '--end', '-m', 'Sized 1, reordered 1, 1 proposed to drop', '--as', 'Claude'], under).code, 0);
    assert.match(s.item(run), /a tidy of the backlog the chat ran itself, taking over/);

    // The brief says what it changed, and how to take it back.
    const brief = s.sp('brief');
    assert.match(brief, /Sized 1, reordered 1, 1 proposed to drop/);
    assert.match(brief, /the chat tidied the backlog itself, taking over/);

    // Once a night at most, and only when something changed since.
    assert.match(s.sp('takeover'), /Next tidy: after \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    assert.match(s.fails('manage', '--start', '--takeover', '--as', 'Claude'), /no tidy is due: the last pass, t-\w+, was .* ago: one a night at most/);
    s.advance(21);
    s.sp('usage', '--weekly', '40');
    assert.match(s.fails('manage', '--start', '--takeover', '--as', 'Claude'), /no tidy is due: nothing changed since the last pass/);

    // One undo takes the pass back.
    s.sp('revert', run);
    const after = s.json('show', next).item;
    assert.deepEqual([after.size, after.priority], ['s', 2]);
    assert.equal(s.json('show', suggested).item.status, 'proposed');
  } finally {
    s.cleanup();
  }
});

test('the watch tells the chat once when a tidy comes due', () => {
  const seen = (tidy: string[]) => ({ ready: new Map(), said: new Map(), inbox: new Set<string>(), asks: new Map(), tidy: new Set(tidy) });
  assert.deepEqual(changes(seen([]), seen(['skyhop']), () => '', () => ''), [
    'tidy: skyhop — taking over, a tidy of the backlog is due. Run the pass by spool prime manager: spool manage --start --takeover',
  ]);
  assert.deepEqual(changes(seen(['skyhop']), seen(['skyhop']), () => '', () => ''), []);
});

test('taking over builds to the target: the user\'s threads first, then the agents\' ideas, marked or not', () => {
  const { s, top, suggested, held, next } = chatProject();
  try {
    s.exec(['target', '--weekly', '100'], { tty: true });
    // An agent filed this one without marking it AI suggested: it still waits behind the user's own.
    const unmarked = s.id('task', 'A follow-up an agent found', '-p', '0', '-s', 'xs');
    s.sp('takeover', 'on');
    const take = (): string => {
      s.sp('usage', '--weekly', '60');
      const id = s.json('takeover').next?.id;
      s.sp('build', '--takeover', '--as', 'Claude');
      s.sp('start', id, '--as', 'Claude');
      s.sp('done', id, '-m', 'Done', '--as', 'Claude');
      return id;
    };
    assert.deepEqual([take(), take()], [top, next]);
    // Only agents' ideas are left, and the target is not reached: it keeps on taking them.
    assert.deepEqual([take(), take()].sort(), [suggested, unmarked].sort());
    // The held one is the user's not yet: left, and nothing more is taken.
    assert.match(s.fails('build', '--takeover', '--as', 'Claude'), /nothing in the backlog the chat may take/);
    assert.equal(s.json('show', held).item.status, 'proposed');
  } finally {
    s.cleanup();
  }
});

test('with every thread left proposed for drop or archive by a tidy, taking over stops and says why', () => {
  const { s, top, suggested, next } = chatProject();
  try {
    s.sp('takeover', 'on');
    s.sp('manage', '--start', '--as', 'Mgr');
    s.sp('manage', '--propose', 'drop', top, '-m', 'Shipped already', '--as', 'Mgr');
    s.sp('manage', '--propose', 'archive', next, '-m', 'Nobody asked again', '--as', 'Mgr');
    s.sp('usage', '--weekly', '40');
    // One unmarked is still there to take, after them.
    assert.equal(s.json('takeover').next?.id, suggested);
    assert.match(s.fails('build', top, '--takeover', '--as', 'Claude'), /marked potentially irrelevant: t-\w+ proposes to drop it/);
    s.sp('manage', '--propose', 'drop', suggested, '-m', 'Not needed', '--as', 'Mgr');
    s.sp('manage', '--end', '-m', 'Tidied', '--as', 'Mgr');
    const why = s.fails('build', '--takeover', '--as', 'Claude');
    assert.match(why, /every thread left in the backlog is marked potentially irrelevant: .*proposes to drop it.*proposes to archive it/);
    assert.match(why, /Stop: each waits for their word on the tidy/);
    assert.match(s.json('takeover').waiting, /every thread left in the backlog is marked potentially irrelevant/);
  } finally {
    s.cleanup();
  }
});

test('a thread the user moved back from Build waits for them: taking over leaves it', () => {
  const { s, top, next } = chatProject();
  try {
    s.sp('usage', '--weekly', '40');
    s.sp('takeover', 'on');
    s.exec(['build', top], { tty: true });
    s.exec(['propose', top], { tty: true });
    assert.equal(s.json('show', top).item.status, 'proposed');
    assert.match(s.fails('build', top, '--takeover', '--as', 'Claude'), /moved back from Build: it waits for the user/);
    assert.equal(s.json('takeover').next?.id, next);
  } finally {
    s.cleanup();
  }
});
