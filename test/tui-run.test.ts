/**
 * The terminal interface, run for real against a real page: the same loop a terminal gets, with a
 * keyboard and a screen that are only objects. And bare `spool` where there is no terminal, which
 * must print the status as it always did.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Ctx } from '../src/context.ts';
import { alive, pageUp } from '../src/detach.ts';
import { LEAVE } from '../src/term.ts';
import { queueFor, watchQueue } from '../src/tui.ts';
import { CLI, Sandbox, freePort, startPage, until } from './helpers.ts';
import { Keyboard, Process, Screen } from './term-standin.ts';

/** The sandbox's own home and nothing of the shell's that would change what a page does; an agent command that does nothing, in case one is ever started. */
function envOf(s: Sandbox): Record<string, string | undefined> {
  return { ...process.env, HOME: `${s.root}/.home`, XDG_CONFIG_HOME: undefined, SPOOL_ACTOR: undefined, SPOOL_AGENT: 'true', SPOOL_PAGE_RESUME: undefined };
}

/** The world the interface is given, as the CLI gives it at a real terminal. What it prints is kept in `said`. */
function ctxOf(s: Sandbox, said: string[] = []): Ctx {
  return {
    cwd: s.root,
    env: envOf(s),
    out: (text) => said.push(text),
    err: (text) => said.push(text),
    now: () => new Date(),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
    tty: true,
  };
}

/** Every terminal a test opened. A loop left running would keep the test's process up for good, so each is left in `finally`. */
const opened: Keyboard[] = [];
const leaveAll = (): void => {
  for (const input of opened.splice(0)) input.type('\x03');
};

/** A terminal that is only objects, and the last screen drawn on it. */
function terminal(cols = 100, rows = 30) {
  const term = { input: new Keyboard(), output: new Screen(cols, rows), proc: new Process(), last: [] as string[] };
  opened.push(term.input);
  /** The screen as text, without the spaces that fill each line to the edge. */
  const text = (): string => term.last.map((line) => line.trimEnd()).join('\n');
  return {
    ...term,
    seen: (lines: string[]) => (term.last = lines),
    text,
    /** Wait until the screen shows this. */
    shows: (what: string, pattern: RegExp) => until(`the screen shows ${what}`, () => pattern.test(text())),
  };
}

/** The CLI run by a program: nothing on its stdin or stdout is a terminal. */
function piped(s: Sandbox, ...args: string[]): { code: number | null; out: string; err: string } {
  const ran = spawnSync(process.execPath, [CLI, '-C', s.root, ...args], { env: envOf(s), encoding: 'utf8', timeout: 30_000 });
  return { code: ran.status, out: ran.stdout, err: ran.stderr };
}

const records = (s: Sandbox): string[] => {
  const dir = path.join(s.root, '.home', '.config', 'spool', 'pages');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};

test('spool with no terminal prints the status, as it always did: no interface, no escape codes, no page started', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('build', jump);
  try {
    const status = piped(s, 'status');
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /skyhop {2}1 ready · 0 active · 0 blocked · 0 done/);

    const bare = piped(s);
    assert.equal(bare.code, 0, bare.err);
    assert.equal(bare.out, status.out, 'piped, spool alone is spool status');
    assert.doesNotMatch(bare.out, /\x1b/, 'nothing that draws a screen');
    assert.equal(piped(s, '--plain').out, status.out, '--plain is the status wherever it is run');
    assert.equal(piped(s, '--json').out, piped(s, 'status', '--json').out);
    assert.deepEqual(records(s), [], 'and nothing was started to print it');

    // Run in-process by something that says a person is typing, with no terminal behind it: still the status.
    assert.match(s.exec([], { tty: true }).out, /skyhop {2}1 ready/);
    assert.match(s.exec(['--plain'], { tty: true }).out, /skyhop {2}1 ready/);

    // The two flags go with spool alone, and nowhere else.
    const wrong = piped(s, '--plain', 'status');
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.err, /unknown option --plain\n {2}It goes with spool alone/);
    assert.match(piped(s, '--run', 'list').err, /unknown option --run/);
    assert.match(piped(s, 'help').out, /spool alone, in a terminal, opens the queue full-screen/);
  } finally {
    s.cleanup();
  }
});

test('the queue is a face of the running page: its keys press the page\'s buttons, and leaving stops nothing', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const question = s.json('review').questions[0].id as string;
  const page = await startPage(s);
  try {
    const ctx = ctxOf(s);
    const record = pageUp(ctx, s.root);
    assert.ok(record, 'the running page is found through its record');
    assert.deepEqual([record.url, record.token], [page.url, page.token], 'and its token with it');

    const term = terminal();
    const left = watchQueue({ ctx, root: s.root, page: record, started: false, io: term, color: false, proc: term.proc, seen: term.seen, every: 100 });
    await term.shows('the board', /NEEDS YOU {2}1/);
    assert.equal(term.input.raw, true);
    assert.match(term.text().split('\n')[0]!, new RegExp(`^ ▐▚▌── spool · skyhop 1\\.4\\.2 +agents off · 0 building · 1 needs you · page :${page.port}$`));
    assert.match(term.text(), new RegExp(`^> \\? ${question} {2}Outline the coins, or… +1-2 │ holds up ${coins}$`, 'm'));
    assert.match(term.text(), new RegExp(`│ ${question} {2}Outline the coins, or turn them teal\\? +question$`, 'm'));
    assert.match(term.text(), /│ {3}1 {2}Outline {2}\(I would pick\)\n.*│ {3}2 {2}Teal$/m);
    assert.match(term.text(), new RegExp(`^ {2}1 ${coins} {2}Make coins readable… +waits │`, 'm'));
    assert.match(term.text(), /^ BACKLOG {2}1 +│/m);

    // 2 answers the question with its second option, as the page's button would.
    term.input.type('2');
    await term.shows('the answer', /^ Answered: Teal$/m);
    assert.equal(s.json('review').questions.length, 0);
    assert.equal(s.json('show', coins).item.state, 'ready');
    await term.shows('nothing needing him', /NEEDS YOU {2}0/);

    // Down to the backlog, open it, and b sends its thread to Build: on the record as the human's.
    term.input.type('j');
    term.input.type('\r');
    await term.shows('the open backlog', new RegExp(`^ {2}- ${jump} {2}Tighten the jump arc`, 'm'));
    term.input.type('\x1b[B');
    term.input.type('b');
    await term.shows('what the key did', /^ In build: Tighten the jump arc$/m);
    assert.equal(s.json('show', jump).item.state, 'ready');
    assert.match(s.item(jump), /human: moved to build/);
    await term.shows('the thread in Build', new RegExp(`^ {2}2 ${jump} {2}Tighten the jump arc`, 'm'));

    // / takes a line, and Enter files it in the backlog in his words.
    term.input.type('/');
    term.input.type('Add a pause menu');
    await term.shows('the line being typed', /^ add a thread > Add a pause menu_$/m);
    term.input.type('\r');
    await term.shows('the new thread', /^ Added to the backlog$/m);
    await term.shows('it in the backlog', /^ {2}- t-[a-z0-9]+ {2}Add a pause menu/m);
    const board = (await (await fetch(`${page.url}api/board`)).json()) as { columns: { proposed: { id: string; title: string }[] } };
    const added = board.columns.proposed.find((c) => c.title === 'Add a pause menu');
    assert.ok(added);
    assert.match(s.item(added.id), /> Add a pause menu\n> — \[\[n-/);

    // A key the page refuses says so, in the page's words.
    term.input.type('k');
    term.input.type('k');
    term.input.type('s');
    await term.shows('why not', /^ s stops the agent on a thread that is being built\.$/m);

    // q leaves: the terminal is given back, and the page is as it was.
    term.input.type('q');
    assert.deepEqual(await left, { url: page.url, building: 0 });
    assert.ok(term.output.written.endsWith(LEAVE));
    assert.equal(term.input.raw, false);
    assert.equal(term.proc.exited, undefined, 'leaving is not the process ending: the caller says goodbye');
    assert.equal(page.child.exitCode, null, 'the page is still up');
    assert.equal((await fetch(`${page.url}api/board`)).status, 200);
  } finally {
    leaveAll();
    await page.stop();
    s.cleanup();
  }
});

test('with no page up, spool starts one in the background, says so, and leaves it running', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.id('task', 'Tighten the jump arc');
  const said: string[] = [];
  const ctx = ctxOf(s, said);
  let pid = 0;
  try {
    assert.equal(pageUp(ctx, s.root), undefined);
    const port = await freePort();
    const term = terminal();
    const left = queueFor(ctx, term, { proc: term.proc, seen: term.seen, every: 100, port });
    await term.shows('that it started the page', new RegExp(`agents off · 0 building · 0 need you · started page :${port}$`, 'm'));
    assert.deepEqual(said, ['Starting the Spool page in the background…']);
    const up = pageUp(ctx, s.root);
    assert.ok(up);
    pid = up.pid;
    assert.deepEqual([up.url, up.detached, up.run], [`http://127.0.0.1:${port}/`, true, false], 'a background page, with agents off');

    term.input.type('q');
    assert.deepEqual(await left, { url: up.url, building: 0 });
    assert.ok(term.output.written.endsWith(LEAVE));
    assert.equal(alive(pid), true, 'the page it started is left running');
    assert.equal((await fetch(`${up.url}api/board`)).status, 200);

    // spool again finds that page, and starts no other. With --run, its agents are switched on.
    const again = terminal();
    const back = queueFor(ctx, again, { proc: again.proc, seen: again.seen, every: 100, run: true });
    await again.shows('the same page, agents on', new RegExp(`agents on · 0 building · 0 need you · page :${port}$`, 'm'));
    assert.equal(pageUp(ctx, s.root)?.pid, pid);
    assert.equal(said.length, 1, 'nothing more was started');
    again.input.type('q');
    await back;
    assert.equal(alive(pid), true);
  } finally {
    leaveAll();
    // The page was started away from this process: end it as `spool page --stop` would.
    pid ||= pageUp(ctx, s.root)?.pid ?? 0;
    if (pid) {
      process.kill(pid, 'SIGTERM');
      await until('the page has gone', () => !alive(pid));
    }
    s.cleanup();
  }
});
