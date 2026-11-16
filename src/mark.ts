/**
 * The yarn mark: what a person sees when they type `spool` into a terminal.
 *
 * A ball of yarn in block characters, wound three ways, and its loose end running off to the
 * right as one line that writes the word. It is drawn for people only: with nobody at the
 * terminal every function here gives back nothing, so an agent or a script reading the output
 * never meets it.
 *
 * The art is two grids of the same shape. `ART` is the characters, every one from Block Elements
 * or Box Drawing so each is one column wide in any terminal font. `PAINT` says what each cell is,
 * and so how it is coloured: the ball in the Spool page's orange, the thread dimmed, the letters
 * left in the terminal's own foreground so the word stands out from the thread that joins it.
 * With colour off the same characters are printed plain.
 */

import type { Ctx } from './context.ts';

const ART = [
  '  ▄▟▀▄██▙▖                         ',
  '▗██▘▟██▀▄▟█▖                    ╷  ',
  '██▘▟█▛▗█████    ╭───┬─╮ ╭─╮ ╭─╮ │  ',
  '█▌▐█▛▗█▄▀███    ╰─╮ │ ├─┤ ├─┤ ├─┤  ',
  '▝▌▐█ ████▖▜───────╯ ├─╯ ╰─╯ ╰─╯ ╰─╴',
  '  ▀▜ ███▛▀          ╵              ',
] as const;

/** a: the ball. b: the one band of yarn that lies on top, a shade lighter. t: the thread, and the joins it makes between letters. w: a letter's own stroke. */
const PAINT = [
  '  aaabbbbb                         ',
  'aaaabbbbaaaa                    w  ',
  'aaabbbaaaaaa    wwttwww www www w  ',
  'aabbbaaaaaaa    www w wtw wtw wtw  ',
  'aabb aaaaaattttttww www www www wtt',
  '  bb aaaaa          w              ',
] as const;

/** One line, for a terminal too narrow for the ball, and for the end of a command's output: a scrap of the ball, the thread, the word. */
const SMALL = { knot: '▐▚▌', thread: '──', word: 'spool' } as const;

/** The mark's rows, as plain characters: every row the same width. */
export const MARK_ROWS: readonly string[] = ART;
export const MARK_WIDTH = ART[0].length;
export const MARK_HEIGHT = ART.length;
/** The one-line form, as plain characters. */
export const MARK_LINE = `${SMALL.knot}${SMALL.thread} ${SMALL.word}`;
/** Below this many columns the ball and a line of text beside it no longer fit, and the one-line form is shown. */
export const NARROW = 60;
/** The column the thread starts in: left of it is the ball. */
const THREAD_FROM = 11;
/** What stands between the mark and the text beside it. */
const GAP = '   ';

/** A colour in all 24 bits, and the nearest of the 256 colours every colour terminal has that is still an orange. */
export interface Shade {
  rgb: readonly [number, number, number];
  near: number;
}

/**
 * The Spool page's orange, dark to light: its accent on a light page is the first, on a dark page
 * the third. The ball takes the one that suits the terminal's background, and where the terminal
 * does not say what that is, the one between them, which reads on both. The band is always the
 * next one lighter. The 256-colour stand-ins are picked by eye: the nearest by distance to the
 * third is a salmon pink.
 */
const ORANGE: readonly Shade[] = [
  { rgb: [0xc2, 0x41, 0x0c], near: 166 },
  { rgb: [0xea, 0x58, 0x0c], near: 202 },
  { rgb: [0xfb, 0x92, 0x3c], near: 208 },
  { rgb: [0xfd, 0xba, 0x74], near: 215 },
];

/** What the terminal says its background is, where it says: some set COLORFGBG to "foreground;background" as colour numbers. */
function background(env: Ctx['env']): 'light' | 'dark' | undefined {
  const last = env.COLORFGBG?.split(';').pop();
  if (!last || !/^\d+$/.test(last)) return undefined;
  const n = Number(last);
  if (n > 15) return undefined;
  return n === 7 || n >= 9 ? 'light' : 'dark';
}

/** The ball's two shades for this terminal: the body, and the band on top. */
export function accent(env: Ctx['env']): { body: Shade; band: Shade } {
  const bg = background(env);
  const at = bg === 'light' ? 0 : bg === 'dark' ? 2 : 1;
  return { body: ORANGE[at]!, band: ORANGE[at + 1]! };
}

/** The code that sets the text colour: all 24 bits where the terminal says it has them, one of the 256 otherwise. */
export function colorCode(env: Ctx['env'], shade: Shade): string {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '') ? `\x1b[38;2;${shade.rgb.join(';')}m` : `\x1b[38;5;${shade.near}m`;
}

/** A person is reading this: the command was typed at a terminal. */
function shown(ctx: Ctx): boolean {
  return ctx.tty === true;
}

/** Colour is wanted and the terminal can show it. Text set beside the mark is styled, or not, by this too. */
export function inColor(ctx: Ctx): boolean {
  return ctx.color && !ctx.env.NO_COLOR && ctx.env.TERM !== 'dumb';
}

/** How many columns a string takes once its colour codes are taken out. */
function wide(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** How each kind of cell is wrapped, for this terminal. With colour off, nothing is. */
function wraps(ctx: Ctx): Record<string, [string, string]> {
  if (!inColor(ctx)) return {};
  const { body, band } = accent(ctx.env);
  return {
    a: [colorCode(ctx.env, body), '\x1b[39m'],
    b: [colorCode(ctx.env, band), '\x1b[39m'],
    t: ['\x1b[2m', '\x1b[22m'],
  };
}

/** One row of the art, coloured. The ball is always whole; of the thread and the word, only the columns below `upTo` are drawn, for `unwind`. */
function paintRow(row: number, wrap: Record<string, [string, string]>, upTo = MARK_WIDTH): string {
  const chars = [...ART[row]!];
  const kinds = [...PAINT[row]!];
  let out = '';
  let open = '';
  let gap = '';
  chars.forEach((ch, i) => {
    if (ch === ' ' || (i >= upTo && 'tw'.includes(kinds[i]!))) {
      gap += ' ';
      return;
    }
    // A gap inside a run of one kind stays inside its wrapping; between two kinds, and at the row's end, it is left bare.
    if (kinds[i] !== open) {
      out += `${wrap[open]?.[1] ?? ''}${gap}${wrap[kinds[i]!]?.[0] ?? ''}`;
      open = kinds[i]!;
    } else out += gap;
    gap = '';
    out += ch;
  });
  return `${out}${wrap[open]?.[1] ?? ''}${gap}`;
}

/**
 * The mark as rows, each exactly MARK_WIDTH columns wide, for a caller that lays it out itself:
 * the terminal interface sets it as its header. Empty when nobody is at the terminal.
 */
export function markRows(ctx: Ctx): string[] {
  if (!shown(ctx)) return [];
  const wrap = wraps(ctx);
  return ART.map((_, row) => paintRow(row, wrap));
}

/**
 * The rows with up to three lines of text set to their right, centred on the word. No row ends in
 * a space. A line too long for the terminal is left out: wrapped, it would land under the ball.
 */
function withLines(ctx: Ctx, rows: string[], lines: string[]): string[] {
  const room = (ctx.columns ?? Infinity) - MARK_WIDTH - GAP.length;
  const beside = lines.slice(0, 3).filter((text) => wide(text) <= room);
  // Three lines sit beside the three rows the small letters fill; fewer are centred on them.
  const first = Math.ceil((rows.length - beside.length) / 2);
  return rows.map((row, i) => {
    const text = beside[i - first];
    return text ? `${row}${GAP}${text}` : row.replace(/ +$/, '');
  });
}

/**
 * The yarn, with up to three lines of text beside it: a version, a project, a hint. In a terminal
 * under 60 columns it is the one-line form, followed by as much of the text as fits on the line.
 * Empty when nobody is at the terminal.
 */
export function mark(ctx: Ctx, { lines = [] }: { lines?: string[] } = {}): string {
  if (!shown(ctx)) return '';
  if (ctx.columns === undefined || ctx.columns >= NARROW) return withLines(ctx, markRows(ctx), lines).join('\n');
  let line = markLine(ctx);
  for (const text of lines.slice(0, 3)) {
    if (wide(`${line}  ${text}`) > ctx.columns) break;
    line += `  ${text}`;
  }
  return line;
}

/** The one-line form. Empty when nobody is at the terminal. */
export function markLine(ctx: Ctx): string {
  if (!shown(ctx)) return '';
  if (!inColor(ctx)) return MARK_LINE;
  const wrap = wraps(ctx);
  return `${wrap.a![0]}${SMALL.knot}${wrap.a![1]}${wrap.t![0]}${SMALL.thread}${wrap.t![1]} \x1b[1m${SMALL.word}\x1b[22m`;
}

/** Whether `unwind` would draw anything here: a person at a colour terminal that can move its cursor, wide enough, and motion not turned off. */
export function canUnwind(ctx: Ctx): boolean {
  if (!shown(ctx) || !inColor(ctx) || ctx.env.SPOOL_NO_MOTION) return false;
  // A terminal that does not name itself cannot be trusted to move the cursor; in a narrow one the rows would wrap.
  if (!ctx.env.TERM) return false;
  return ctx.columns === undefined || ctx.columns >= NARROW;
}

/**
 * Draw the mark with the thread running out of the ball and writing the word, over about 400ms,
 * and leave the finished mark in place, with `lines` beside it. Each frame is drawn over the last:
 * the cursor goes back up the mark's own rows and nowhere else. Does nothing, and says so by
 * resolving false, where `canUnwind` is false.
 */
export async function unwind(ctx: Ctx, { lines = [], frames = 8, ms = 50 }: { lines?: string[]; frames?: number; ms?: number } = {}): Promise<boolean> {
  if (!canUnwind(ctx)) return false;
  const wrap = wraps(ctx);
  const up = `\x1b[${MARK_HEIGHT}A`;
  const span = MARK_WIDTH - THREAD_FROM;
  for (let frame = 0; frame <= frames; frame++) {
    const upTo = THREAD_FROM + Math.round((span * frame) / frames);
    const rows = ART.map((_, row) => paintRow(row, wrap, upTo));
    // Every frame only adds to the one before, so nothing needs wiping. The text arrives with the last stroke.
    const drawn = frame === frames ? withLines(ctx, rows, lines) : rows;
    ctx.out(`${frame ? up : ''}${drawn.join('\n')}`);
    if (frame < frames) await new Promise((done) => setTimeout(done, ms));
  }
  return true;
}
