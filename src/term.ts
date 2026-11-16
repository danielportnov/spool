/**
 * The terminal, for Spool's full-screen face (`tui.ts`).
 *
 * Four small jobs, written by hand so Spool still depends on nothing: measuring text the way a
 * terminal shows it (a wide letter takes two columns, a mark that sits on a letter takes none),
 * reading raw keys into names, drawing a screen of lines without flicker, and putting the terminal
 * back as it was on every way out. A terminal left in raw mode on its other screen with no cursor
 * is the worst thing this file can do, so `close` runs on a quit, a signal, a thrown error and the
 * process ending, and running it twice is harmless.
 *
 * Colours are not chosen here: a frame is painted by the `paint` every command uses (`render.ts`),
 * so NO_COLOR and a pipe mean the same thing everywhere.
 */

// ------------------------------------------------------------------ text, as wide as it is shown

/** East Asian letters a terminal draws two columns wide. */
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x3fffd],
];

const ASCII = /^[\x20-\x7e]*$/;
/** Marks, joiners and controls: they take no column of their own. */
const NO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u;
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTURE = /\p{Extended_Pictographic}/u;
/** Letters that change or join the one before: text with any of these is measured a whole letter at a time. */
const JOINED = /[\p{M}‍\u{1f3fb}-\u{1f3ff}\u{1f1e6}-\u{1f1ff}\u{e0020}-\u{e007f}]/u;

let segmenter: Intl.Segmenter | undefined;

/** How many columns one code point takes. */
function columnsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x300) return cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  if (NO_WIDTH.test(ch)) return 0;
  if (cp >= 0x1100 && WIDE.some(([from, to]) => cp >= from && cp <= to)) return 2;
  return cp >= 0x231a && EMOJI.test(ch) ? 2 : 1;
}

/** Text as the pieces a terminal draws, each with its width: a letter with its marks, or an emoji made of several, is one piece. */
function pieces(text: string): [string, number][] {
  if (!JOINED.test(text)) return [...text].map((ch) => [ch, columnsOf(ch)]);
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map(({ segment }) => {
    const emoji = EMOJI.test(segment) || (segment.includes('️') && PICTURE.test(segment));
    return [segment, emoji ? 2 : columnsOf(segment)];
  });
}

/**
 * Text with nothing in it that would move the cursor or change the screen: escape sequences and
 * control characters are taken out, and a tab or a line break becomes a space. Whatever an agent
 * printed or a thread is called, it is drawn as letters and nothing else.
 */
export function plain(text: string): string {
  if (ASCII.test(text)) return text;
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g, '')
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** How many columns a terminal gives the text. Never its length: a wide letter is two, a joined emoji is two, a mark is none. */
export function width(text: string): number {
  const clean = plain(text);
  if (ASCII.test(clean)) return clean.length;
  let w = 0;
  for (const [, cols] of pieces(clean)) w += cols;
  return w;
}

/** The longest start of the text that fits in `max` columns, and at least one piece of it. */
function take(text: string, max: number): string {
  let out = '';
  let w = 0;
  for (const [piece, cols] of pieces(text)) {
    if (out && w + cols > max) break;
    out += piece;
    w += cols;
  }
  return out;
}

/** The text in at most `max` columns: cut, with an ellipsis, where it is longer. */
export function cut(text: string, max: number): string {
  const clean = plain(text);
  if (max <= 0) return '';
  if (ASCII.test(clean) ? clean.length <= max : width(clean) <= max) return clean;
  if (max === 1) return '…';
  let out = '';
  let w = 0;
  for (const [piece, cols] of pieces(clean)) {
    if (w + cols > max - 1) break;
    out += piece;
    w += cols;
  }
  return `${out.trimEnd()}…`;
}

/** The text in exactly `n` columns: cut where it is longer, padded with spaces where it is shorter. */
export function fit(text: string, n: number): string {
  const shown = cut(text, n);
  return shown + ' '.repeat(Math.max(0, n - width(shown)));
}

/** The end of the text, in at most `max` columns: what a line being typed shows once it is longer than its room. */
export function tail(text: string, max: number): string {
  const all = pieces(plain(text));
  let w = 0;
  let from = all.length;
  while (from > 0 && w + all[from - 1]![1] <= max) w += all[--from]![1];
  return all.slice(from).map(([piece]) => piece).join('');
}

/** The text as lines of at most `max` columns, broken between words; a word longer than a line is broken where it must be. */
export function wrap(text: string, max: number): string[] {
  const room = Math.max(1, max);
  const lines: string[] = [];
  let line = '';
  let w = 0;
  for (const word of plain(text).trim().split(' ')) {
    let rest = word;
    let cols = width(rest);
    if (line && w + 1 + cols <= room) {
      line += ` ${rest}`;
      w += 1 + cols;
      continue;
    }
    if (line) lines.push(line);
    while (cols > room) {
      const head = take(rest, room);
      lines.push(head);
      rest = rest.slice(head.length);
      cols = width(rest);
    }
    line = rest;
    w = cols;
  }
  lines.push(line);
  return lines;
}

// ------------------------------------------------------------------ keys

/** What a terminal sends for the keys that are not letters. */
const NAMED: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1bOA': 'up',
  '\x1b[B': 'down',
  '\x1bOB': 'down',
  '\x1b[C': 'right',
  '\x1bOC': 'right',
  '\x1b[D': 'left',
  '\x1bOD': 'left',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[7~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[8~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[Z': 'backtab',
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * What was typed, as keys. A letter is itself; the rest have names (`up`, `enter`, `esc`, `tab`,
 * `pageup`, `ctrl-c`, …). Text pasted in arrives as one key, `paste:` and the text: a pasted line
 * break must never be read as Enter, nor its letters as commands.
 */
export function keys(input: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < input.length; ) {
    if (input.startsWith(PASTE_START, i)) {
      const end = input.indexOf(PASTE_END, i);
      out.push(`paste:${input.slice(i + PASTE_START.length, end < 0 ? undefined : end)}`);
      i = end < 0 ? input.length : end + PASTE_END.length;
      continue;
    }
    const ch = input[i]!;
    if (ch === '\x1b') {
      const sequence = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(input.slice(i, i + 32))?.[0];
      // A sequence nobody here has a name for is a key this interface does not use.
      if (sequence) {
        if (NAMED[sequence]) out.push(NAMED[sequence]);
        i += sequence.length;
      } else {
        out.push('esc');
        i++;
      }
    } else if (ch === '\r' || ch === '\n') {
      out.push('enter');
      i++;
    } else if (ch === '\t') {
      out.push('tab');
      i++;
    } else if (ch === '\x7f' || ch === '\b') {
      out.push('backspace');
      i++;
    } else if (ch === '\x03') {
      out.push('ctrl-c');
      i++;
    } else if (ch < ' ') {
      i++;
    } else {
      const letter = String.fromCodePoint(input.codePointAt(i)!);
      out.push(letter);
      i += letter.length;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the screen

/** The keyboard, as much of it as this needs: `process.stdin`, or a stand-in. */
export interface TermIn {
  setRawMode?: (on: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown;
  off: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown;
}

/** The screen, as much of it as this needs: `process.stdout`, or a stand-in. */
export interface TermOut {
  columns?: number;
  rows?: number;
  write: (text: string) => unknown;
  on: (event: 'resize', listener: () => void) => unknown;
  off: (event: 'resize', listener: () => void) => unknown;
}

/** The process, as much of it as this needs: the ways it can end. */
export interface Proc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off: (event: string, listener: (...args: any[]) => void) => unknown;
  exit: (code?: number) => unknown;
}

/** Onto the other screen, with no cursor, no wrapping at the right edge, and pasted text marked as pasted. */
export const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h';
/** All of that undone, in the opposite order. */
export const LEAVE = '\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const SIGNAL_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export interface Term {
  size: () => { cols: number; rows: number };
  /** Show these lines, top to bottom. Only the lines that changed since the last draw are written. */
  draw: (lines: string[]) => void;
  /** Put the terminal back as it was. Safe to call twice, and from anywhere. */
  close: () => void;
}

/**
 * Take over the terminal: the other screen, raw keys, no cursor. `on.key` hears each key and
 * `on.resize` a change of size. Whatever happens next, the terminal is put back: `close` is run
 * by the caller on a quit, and from here when the process is signalled, when it ends, and when
 * anything throws, in a key's handler or anywhere else. After a throw, `on.crash` is told, with
 * the terminal already the user's again, and the process ends.
 */
export function openTerm(
  io: { input: TermIn; output: TermOut },
  on: { key: (key: string) => void; resize: () => void; crash?: (error: unknown) => void },
  proc: Proc = process,
): Term {
  let closed = false;
  let shown: string[] = [];
  const write = (text: string): void => {
    try {
      io.output.write(text);
    } catch {
      // The terminal has gone (its window was closed): there is nobody to draw for.
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    io.input.off('data', data);
    io.output.off('resize', resized);
    proc.off('exit', close);
    proc.off('uncaughtException', crash);
    proc.off('unhandledRejection', crash);
    for (const signal of SIGNALS) proc.off(signal, signalled[signal]);
    try {
      io.input.setRawMode?.(false);
    } catch {
      // Not a terminal any more.
    }
    io.input.pause();
    write(LEAVE);
  };
  const crash = (error: unknown): void => {
    close();
    on.crash?.(error);
    proc.exit(1);
  };
  const signalled = Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      (): void => {
        close();
        proc.exit(SIGNAL_CODE[signal]);
      },
    ]),
  ) as Record<(typeof SIGNALS)[number], () => void>;
  const data = (chunk: string | Buffer): void => {
    try {
      for (const key of keys(String(chunk))) {
        if (closed) return;
        on.key(key);
      }
    } catch (error) {
      crash(error);
    }
  };
  const resized = (): void => {
    // Everything is drawn again: what the terminal kept of the old size is not to be trusted.
    shown = [];
    write('\x1b[2J');
    try {
      on.resize();
    } catch (error) {
      crash(error);
    }
  };

  proc.on('exit', close);
  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);
  for (const signal of SIGNALS) proc.on(signal, signalled[signal]);
  io.input.setRawMode?.(true);
  io.input.setEncoding('utf8');
  io.input.resume();
  io.input.on('data', data);
  io.output.on('resize', resized);
  write(ENTER);

  return {
    size: () => ({ cols: io.output.columns ?? 80, rows: io.output.rows ?? 24 }),
    draw: (lines) => {
      if (closed) return;
      let out = '';
      lines.forEach((line, i) => {
        if (shown[i] !== line) out += `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`;
      });
      if (lines.length < shown.length) out += `\x1b[${lines.length + 1};1H\x1b[J`;
      shown = lines.slice();
      if (out) write(out);
    },
    close,
  };
}
