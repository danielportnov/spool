/**
 * The yarn mark: the ball, the thread and the word a person sees at a terminal, and nobody else does.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';
import type { Ctx } from '../src/context.ts';
import { MARK_HEIGHT, MARK_LINE, MARK_ROWS, MARK_WIDTH, accent, canUnwind, mark, markLine, markRows, unwind } from '../src/mark.ts';
import { Sandbox } from './helpers.ts';

const VERSION = (JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
const PLAIN = MARK_ROWS.map((row) => row.trimEnd()).join('\n');
/** Colour codes taken out: what is left is what takes up columns. */
const bare = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
const columns = (text: string): number => [...bare(text)].length;

/** A terminal with a person at it. `env` and anything else can be changed. */
function terminal(env: Record<string, string> = {}, more: Partial<Ctx> = {}): Ctx & { written: string[] } {
  const written: string[] = [];
  return {
    cwd: '.',
    env: { TERM: 'xterm-256color', ...env },
    out: (text) => written.push(text),
    err: (text) => written.push(text),
    now: () => new Date('2026-01-01T00:00:00Z'),
    stdin: () => '',
    lines: () => {},
    color: true,
    inherit: false,
    tty: true,
    written,
    ...more,
  };
}

test('the mark is a grid: every row one width, 44 columns or fewer, in block and box characters only', () => {
  assert.ok(MARK_HEIGHT >= 5 && MARK_HEIGHT <= 7, `${MARK_HEIGHT} rows`);
  assert.equal(MARK_ROWS.length, MARK_HEIGHT);
  assert.ok(MARK_WIDTH <= 44, `${MARK_WIDTH} columns`);
  for (const row of MARK_ROWS) {
    assert.equal([...row].length, MARK_WIDTH, `"${row}"`);
    // Block Elements and Box Drawing are one column wide in every terminal font; nothing else is let in.
    assert.match(row, /^[ \u2500-\u257f\u2580-\u259f]+$/u, `"${row}"`);
  }
  // The ball is blocks, on the left; the thread and the word are lines, to its right.
  for (const row of MARK_ROWS) {
    assert.doesNotMatch(row.slice(12), /[\u2580-\u259f]/u);
    assert.doesNotMatch(row.slice(0, 11), /[\u2500-\u257f]/u);
  }
  // The ball is about twice as wide in columns as it is tall in rows, which is round on screen.
  assert.equal(Math.max(...MARK_ROWS.map((row) => row.slice(0, 12).trimEnd().length)), 2 * MARK_HEIGHT);

  assert.ok([...MARK_LINE].length <= 16, `"${MARK_LINE}"`);
  assert.match(MARK_LINE, /^[\u2500-\u257f\u2580-\u259f]+ spool$/u);
  assert.doesNotMatch(MARK_LINE, /\n/);

  // The README shows the mark as it is drawn.
  const readme = fs.readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.ok(readme.includes(`\`\`\`text\n${PLAIN}\n\`\`\``));
});

test('with colour off it is the same shapes in plain characters: no codes, and no row ends in a space', () => {
  for (const ctx of [terminal({}, { color: false }), terminal({ NO_COLOR: '1' }), terminal({ TERM: 'dumb' })]) {
    assert.equal(mark(ctx), PLAIN);
    assert.equal(markLine(ctx), MARK_LINE);
    assert.deepEqual(markRows(ctx), [...MARK_ROWS]);
    assert.equal(canUnwind(ctx), false);
  }
  for (const row of mark(terminal({ COLORTERM: 'truecolor' })).split('\n')) assert.doesNotMatch(row, / $/);
});

test('with nobody at the terminal there is no mark at all', () => {
  for (const tty of [false, undefined]) {
    const ctx = terminal({ COLORTERM: 'truecolor' }, { tty });
    assert.equal(mark(ctx, { lines: ['v1'] }), '');
    assert.equal(markLine(ctx), '');
    assert.deepEqual(markRows(ctx), []);
    assert.equal(canUnwind(ctx), false);
  }
});

test('in colour the ball is the page’s orange: 24 bits where the terminal has them, one of the 256 otherwise', () => {
  // The two ends of the range are the page's own accents, light and dark.
  const page = fs.readFileSync(fileURLToPath(new URL('../src/client/page.css.ts', import.meta.url)), 'utf8');
  const hex = (rgb: readonly number[]) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  assert.ok(page.includes(`--accent: ${hex(accent({ COLORFGBG: '0;15' }).body.rgb)};`), 'the light page’s accent');
  assert.ok(page.includes(`--accent: ${hex(accent({ COLORFGBG: '15;0' }).body.rgb)};`), 'the dark page’s accent');

  // A terminal that does not say what its background is gets the orange between them, which reads on both.
  const unknown = mark(terminal({ COLORTERM: 'truecolor' }));
  assert.ok(unknown.includes('\x1b[38;2;234;88;12m▄▟▀\x1b[39m'), 'the body');
  assert.ok(unknown.includes('\x1b[38;2;251;146;60m▄██▙▖\x1b[39m'), 'the band on top, a shade lighter');
  assert.equal(bare(unknown), PLAIN, 'the same characters under the colour');
  assert.ok(mark(terminal({ COLORTERM: '24bit', COLORFGBG: '15;0' })).includes('\x1b[38;2;251;146;60m▄▟▀'), 'on a dark background');
  assert.ok(mark(terminal({ COLORTERM: 'truecolor', COLORFGBG: '0;default;15' })).includes('\x1b[38;2;194;65;12m▄▟▀'), 'on a light one');
  assert.ok(mark(terminal({ COLORTERM: 'truecolor', COLORFGBG: 'default;default' })).includes('\x1b[38;2;234;88;12m▄▟▀'), 'said, but not as a colour');

  const few = mark(terminal());
  assert.ok(few.includes('\x1b[38;5;202m▄▟▀\x1b[39m\x1b[38;5;208m▄██▙▖\x1b[39m'));
  assert.doesNotMatch(few, /38;2;/);

  // The thread is dimmed, the letters are left in the terminal's own colour, and the word is whole between them.
  assert.ok(unknown.includes('\x1b[2m──────\x1b[22m─╯'), 'the thread, and then the s');
  assert.ok(unknown.includes('├\x1b[2m─\x1b[22m┤'), 'a join between two letters');
  assert.equal(markLine(terminal({ COLORTERM: 'truecolor' })), '\x1b[38;2;234;88;12m▐▚▌\x1b[39m\x1b[2m──\x1b[22m \x1b[1mspool\x1b[22m');
  assert.equal(bare(markLine(terminal())), MARK_LINE);
});

test('up to three lines of text sit to its right, beside the word; a narrow terminal gets the one line', () => {
  const ctx = terminal({}, { color: false });
  const rows = (lines: string[]) => mark(ctx, { lines }).split('\n');
  const beside = (row: string) => row.slice(MARK_WIDTH);
  assert.deepEqual(rows(['one', 'two', 'three', 'four']).map(beside), ['', '', '   one', '   two', '   three', '']);
  assert.deepEqual(rows(['one', 'two']).map(beside), ['', '', '   one', '   two', '', '']);
  assert.deepEqual(rows(['one']).map(beside), ['', '', '', '   one', '', '']);
  assert.equal(rows(['one', 'two', 'three']).map((row) => row.slice(0, MARK_WIDTH).trimEnd()).join('\n'), PLAIN, 'the mark itself is untouched');
  for (const row of markRows(terminal({ COLORTERM: 'truecolor' }))) assert.equal(columns(row), MARK_WIDTH);
  // A line that would not fit beside it is left out, never wrapped under the ball.
  const snug = mark(terminal({}, { color: false, columns: 64 }), { lines: ['v1.2.3', 'skyhop', 'spool help lists the commands'] }).split('\n');
  assert.deepEqual(snug.map(beside), ['', '', '   v1.2.3', '   skyhop', '', '']);

  const narrow = terminal({ COLORTERM: 'truecolor' }, { columns: 50 });
  assert.equal(bare(mark(narrow)), MARK_LINE);
  assert.equal(bare(mark(narrow, { lines: ['v1.2.3', 'skyhop', 'a hint far too long to fit on what is left of the line'] })), `${MARK_LINE}  v1.2.3  skyhop`);
  assert.equal(mark(terminal({}, { color: false, columns: 59 })), MARK_LINE);
  assert.equal(mark(terminal({}, { color: false, columns: 60 })), PLAIN);
});

test('piped, bare spool and --version print exactly what they did; typed at a terminal, the mark comes first', () => {
  // The project sits in a folder of its own, so a demo and a second project can be made beside it.
  const root = new Sandbox();
  const s = root.cd('demo');
  s.sp('init', '--name', 'demo');
  try {
    const status = s.sp('status');
    const art = /[\u2580-\u259f]/u;

    // A program reading the output: no art, anywhere.
    assert.equal(s.sp('--version'), VERSION);
    assert.equal(s.sp(), status);
    assert.deepEqual(JSON.parse(s.sp('--json', '--version')), { version: VERSION });
    assert.ok(s.sp('help').startsWith('spool — the engine under the Spool skills\n'));
    assert.doesNotMatch(s.sp('help'), art);
    assert.doesNotMatch(root.cd('fresh').sp('init', '--name', 'fresh'), art);
    assert.doesNotMatch(root.sp('demo', 'tips'), art);

    // A person: the mark, the version and the project beside it, then what they asked for.
    const typed = (...args: string[]) => s.exec(args, { tty: true }).out;
    const head = (...lines: string[]) => mark(terminal({}, { color: false }), { lines });
    assert.equal(typed('--version'), head(`v${VERSION}`));
    assert.equal(typed(), `${head(`v${VERSION}`, 'demo', 'spool help lists the commands')}\n\n${status}`);
    assert.equal(typed('help'), `${head(`v${VERSION}`)}\n\n${s.sp('help')}`);
    assert.equal(typed('-h'), typed('help'));

    // Asked for as data, a person gets data: the mark is not for --json.
    assert.equal(typed('--version', '--json'), VERSION);
    assert.deepEqual(JSON.parse(typed('--json', '--version')), { version: VERSION });
    assert.doesNotMatch(typed('--json'), art);

    // Nowhere else: a named command is as it was.
    assert.equal(typed('status'), status);
    assert.equal(typed('help', 'status'), s.sp('help', 'status'));

    // Setting up, and the demo, close under the one-line form.
    const fresh = root.cd('typed');
    assert.match(fresh.exec(['init', '--name', 'typed'], { tty: true }).out, new RegExp(`\n\n${MARK_LINE}\nNext, in your agent\\.`));
    assert.doesNotMatch(fresh.exec(['init'], { tty: true }).out, art, 'nothing new is set up the second time, and nothing closes it');
    assert.match(root.exec(['demo', 'tips2'], { tty: true }).out, new RegExp(`\n\n${MARK_LINE}\nOpen the board:`));
  } finally {
    root.cleanup();
  }
});

test('outside any project, bare spool is the help: under the mark for a person, as it was for a program', () => {
  const s = new Sandbox();
  try {
    const help = s.sp('help');
    assert.equal(s.sp(), help);
    assert.equal(s.exec([], { tty: true }).out, `${mark(terminal({}, { color: false }), { lines: [`v${VERSION}`] })}\n\n${help}`);
  } finally {
    s.cleanup();
  }
});

test('typed at a colour terminal, --version carries the orange', () => {
  const ctx = terminal({ COLORTERM: 'truecolor' });
  assert.equal(run(['--version'], ctx), 0);
  assert.equal(ctx.written.length, 1);
  assert.ok(ctx.written[0]!.includes('\x1b[38;2;234;88;12m'));
  assert.ok(ctx.written[0]!.includes(`\x1b[1mv${VERSION}\x1b[22m`));
  assert.equal(bare(ctx.written[0]!), mark(terminal({}, { color: false }), { lines: [`v${VERSION}`] }));

  // A terminal that cannot show colour gets no codes at all, beside the mark either.
  const dumb = terminal({ TERM: 'dumb' });
  run(['--version'], dumb);
  assert.doesNotMatch(dumb.written[0]!, /\x1b/);
});

test('unwind draws the thread writing the word, frame over frame, and leaves the finished mark', async () => {
  const ctx = terminal({ COLORTERM: 'truecolor' });
  assert.equal(await unwind(ctx, { lines: ['v1.2.3'], ms: 0 }), true);
  const frames = ctx.written;
  assert.equal(frames.length, 9);
  assert.doesNotMatch(frames[0]!, /\x1b\[\d+A/, 'the first frame is drawn where the cursor is');
  for (const frame of frames.slice(1)) assert.ok(frame.startsWith(`\x1b[${MARK_HEIGHT}A`), 'each later one goes back up the mark’s own rows');
  // The cursor only ever goes up, by the mark's height, and nothing is erased.
  assert.deepEqual([...new Set(frames.join('').match(/\x1b\[[0-9;]*[A-HJKST]/g))], [`\x1b[${MARK_HEIGHT}A`]);

  const shown = frames.map((frame) => bare(frame.replace(/^\x1b\[\d+A/, '')).split('\n'));
  // The ball is whole from the first frame; the line grows and never shrinks.
  for (const rows of shown) assert.deepEqual(rows.map((row) => row.slice(0, 11).trimEnd()), MARK_ROWS.map((row) => row.slice(0, 11).trimEnd()));
  assert.doesNotMatch(shown[0]!.join(''), /[\u2500-\u257f]/u, 'no thread yet');
  const drawn = shown.map((rows) => rows.join('').replace(/ /g, '').length);
  assert.deepEqual(drawn, [...drawn].sort((a, b) => a - b));
  assert.equal(shown.at(-1)!.join('\n'), bare(mark(ctx, { lines: ['v1.2.3'] })), 'the last frame is the mark, with its text');
  for (const rows of shown.slice(0, -1)) assert.doesNotMatch(rows.join('\n'), /v1\.2\.3/);
});

test('unwind does nothing without a person, colour, a cursor to move, the room, or when motion is turned off', async () => {
  const quiet = [
    terminal({ COLORTERM: 'truecolor' }, { tty: false }),
    terminal({ COLORTERM: 'truecolor' }, { color: false }),
    terminal({ COLORTERM: 'truecolor', NO_COLOR: '1' }),
    terminal({ COLORTERM: 'truecolor', SPOOL_NO_MOTION: '1' }),
    terminal({ COLORTERM: 'truecolor', TERM: 'dumb' }),
    terminal({ COLORTERM: 'truecolor', TERM: '' }),
    terminal({ COLORTERM: 'truecolor' }, { columns: 40 }),
  ];
  for (const ctx of quiet) {
    assert.equal(canUnwind(ctx), false);
    assert.equal(await unwind(ctx, { ms: 0 }), false);
    assert.deepEqual(ctx.written, []);
  }

  // Asked for where it cannot be drawn, --version --unwind is --version.
  const still = terminal({ COLORTERM: 'truecolor', SPOOL_NO_MOTION: '1' });
  run(['--version', '--unwind'], still);
  assert.deepEqual(still.written.map(bare), [mark(terminal({}, { color: false }), { lines: [`v${VERSION}`] })]);
  const piped = terminal({ COLORTERM: 'truecolor' }, { tty: false, color: false });
  run(['--version', '--unwind'], piped);
  assert.deepEqual(piped.written, [VERSION]);

  // Asked for where it can, the frames are all it prints.
  const moving = terminal({ COLORTERM: 'truecolor' });
  assert.equal(run(['--version', '--unwind'], moving), 0);
  for (let i = 0; i < 200 && moving.written.length < 9; i++) await new Promise((done) => setTimeout(done, 25));
  assert.equal(moving.written.length, 9);
  assert.equal(bare(moving.written.at(-1)!.replace(/^\x1b\[\d+A/, '')), mark(terminal({}, { color: false }), { lines: [`v${VERSION}`] }));
});
