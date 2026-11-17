/**
 * A usage target: how much of their Claude plan the human wants used while a chat builds.
 *
 * In Chat mode a Claude Code chat running /spool-loop builds what is in Build. The human sets a
 * target, in the page's header or with `spool target`: a percent of the plan's weekly limit, of its
 * 5-hour limit, or of both. The chat works up to it. Before it takes each thread it reads the plan's
 * usage with its own harness's tool and reports it with `spool usage`, which says whether to keep
 * building or stop.
 *
 * Spool never reads the usage itself: that would mean taking the account's credentials and calling
 * a service, and a work queue has no business doing either. It keeps what the chat tells it. The
 * plan is the account's, so the target is too: it is kept in the user's own settings and holds in
 * every project. The last figures read are kept beside them, in `usage.json`, for the page to show.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Ctx, configDir, saveUserConfig, userConfig } from './context.ts';
import { type Item, SIZES, type Size, SpoolError } from './model.ts';
import { age } from './render.ts';

/** The plan's limits a target can be set on. */
export const LIMITS = ['weekly', 'fiveHour', 'fable'] as const;
export type Limit = (typeof LIMITS)[number];
/**
 * The limits that stop the chat: the plan's weekly and 5-hour. Fable's own weekly limit does not
 * stop it: it only keeps threads off Fable (`fableCap`), and the chat builds on Opus instead.
 */
export const STOPS = ['weekly', 'fiveHour'] as const;
const NAMES: Record<Limit, string> = { weekly: 'weekly', fiveHour: '5-hour', fable: 'Fable' };
const FLAGS: Record<Limit, string> = { weekly: '--weekly', fiveHour: '--five-hour', fable: '--fable' };
/** Where Fable counts as nearly spent when no target is set for it. */
const FABLE_NEAR = 95;
/** A reading older than this no longer says where Fable stands. */
const FABLE_FRESH_MS = 24 * 3600 * 1000;

/** A percent for each limit that has one. */
export type Figures = Partial<Record<Limit, number>>;

/** What the chat last read: the percent of each limit used, when, and who read it. */
export interface Reading {
  used: Figures;
  at: string;
  by: string;
}

export interface Usage {
  /** The human's target for each limit that has one. Empty: no target, and the chat builds as it always did. */
  target: Figures;
  /** The last reading reported, or null where none has been. */
  read: Reading | null;
  /** The limits whose last reading is at or past their target. */
  reached: Limit[];
  /** Fable's percent where it is at or over its target (or nearly spent, with none set), so no thread goes to Fable; else null. */
  fableCap: number | null;
}

const isTarget = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
const isUsed = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** The target on file, with anything that is not a whole percent from 1 to 100 left out. */
export function targetOf(ctx: Ctx): Figures {
  const set = userConfig(ctx).usageTarget ?? {};
  const out: Figures = {};
  for (const limit of LIMITS) if (isTarget(set[limit])) out[limit] = set[limit];
  return out;
}

function readingFile(ctx: Ctx): string {
  const dir = configDir(ctx);
  return dir ? path.join(dir, 'usage.json') : '';
}

/** The last reading reported, or null where there is none or the file is not one `spool usage` wrote. */
export function readingOf(ctx: Ctx): Reading | null {
  const file = readingFile(ctx);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { used?: Record<string, unknown>; at?: unknown; by?: unknown } | null;
    if (!parsed || typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
    const used: Figures = {};
    for (const limit of LIMITS) {
      const v = parsed.used?.[limit];
      if (isUsed(v)) used[limit] = v;
    }
    if (!Object.keys(used).length) return null;
    return { used, at: parsed.at, by: typeof parsed.by === 'string' ? parsed.by : 'agent' };
  } catch {
    return null;
  }
}

/** Fable's percent when it is at or over its target (95% where it has none) in a reading read within a day. */
function fableCapOf(target: Figures, read: Reading | null, now: Date): number | null {
  const used = read?.used.fable;
  if (used === undefined || !read || now.getTime() - Date.parse(read.at) > FABLE_FRESH_MS) return null;
  return used >= (target.fable ?? FABLE_NEAR) ? used : null;
}

/** Fable's percent where no thread should go to Fable now, else undefined. */
export function fableCap(ctx: Ctx): number | undefined {
  const { fableCap: at } = usageOf(ctx);
  return at ?? undefined;
}

/** The target, the last reading, and which limits that reading has reached. */
export function usageOf(ctx: Ctx): Usage {
  const target = targetOf(ctx);
  const read = readingOf(ctx);
  const reached = STOPS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined && read.used[l]! >= target[l]!);
  return { target, read, reached, fableCap: fableCapOf(target, read, ctx.now()) };
}

/**
 * Headroom: as a budget runs low, the largest thread worth starting shrinks, so nothing is begun
 * that cannot be finished before it runs out. A budget is anything with a fraction used: the plan's
 * usage against the target (here), or a time budget. Each step says the largest size from that
 * percent of the budget used. The human sets the steps; these are the default.
 */
export const HEADROOM_DEFAULT: Readonly<Record<number, Size>> = { 80: 'm', 90: 's', 97: 'xs' };
/** A reading older than this says nothing about the headroom: the 5-hour limit has reset since. */
const HEADROOM_FRESH_MS = 5 * 3600 * 1000;

/** The steps on file, or the default where none are, each a whole percent from 1 to 100 and a size. */
export function headroomSteps(ctx: Ctx): Array<[number, Size]> {
  const kept = userConfig(ctx).headroom;
  const steps = Object.entries(kept && typeof kept === 'object' ? kept : HEADROOM_DEFAULT)
    .map(([at, size]) => [Number(at), size] as [number, Size])
    .filter(([at, size]) => isTarget(at) && SIZES.includes(size));
  return steps.sort((a, b) => a[0] - b[0]);
}

/** The largest size worth starting with this percent of a budget used, or null where any size fits. */
export function sizeForBudget(usedPercent: number, steps: Array<[number, Size]>): Size | null {
  let upTo: Size | null = null;
  for (const [at, size] of steps) if (usedPercent >= at && (!upTo || SIZES.indexOf(size) < SIZES.indexOf(upTo))) upTo = size;
  return upTo;
}

/** Where a budget is running low: the largest size worth starting, and why, in words. */
export interface Headroom {
  /** The percent of the budget used, the most of any limit read. */
  used: number;
  upTo: Size;
  /** "weekly 92% of 100%". */
  why: string;
}

/**
 * The headroom the last reading leaves, or null where it leaves room for any size. Each of the
 * plan's limits counts against its target, or against the whole limit where it has none: the plan
 * runs out at 100% whatever the target. The limit nearest its end decides.
 */
export function headroomOf(ctx: Ctx): Headroom | null {
  const { target, read } = usageOf(ctx);
  if (!read || ctx.now().getTime() - Date.parse(read.at) > HEADROOM_FRESH_MS) return null;
  let worst: { used: number; why: string } | null = null;
  for (const l of STOPS) {
    const used = read.used[l];
    if (used === undefined) continue;
    const of = target[l] ?? 100;
    const share = Math.min(100, (used / of) * 100);
    if (!worst || share > worst.used) worst = { used: share, why: `${NAMES[l]} ${used}% of ${of}%` };
  }
  if (!worst) return null;
  const upTo = sizeForBudget(worst.used, headroomSteps(ctx));
  return upTo ? { used: Math.round(worst.used), upTo, why: worst.why } : null;
}

/** "near the target, weekly 92% of 100%: only up to S now". */
export function headroomText(h: Headroom): string {
  return `near the end of the budget, ${h.why}: only up to ${h.upTo.toUpperCase()} now`;
}

/** Whether a thread fits the headroom. A thread with no size counts as medium. */
export function fitsHeadroom(h: Headroom | null, size: Size | undefined): boolean {
  return !h || SIZES.indexOf(size ?? 'm') <= SIZES.indexOf(h.upTo);
}

/**
 * The threads a chat may start with the headroom left, and the line that says why the first one
 * it would have taken is passed by, where one is.
 */
export function withinHeadroom<T extends Pick<Item, 'id' | 'size'>>(ctx: Ctx, list: T[]): { fits: T[]; passed: string | null; headroom: Headroom | null } {
  const headroom = headroomOf(ctx);
  const fits = list.filter((t) => fitsHeadroom(headroom, t.size));
  const first = list[0];
  const passed = headroom && first && !fits.includes(first) ? passedLine(first, headroom) : null;
  return { fits, passed, headroom };
}

/** "Passed by t-ab12 (L): near the end of the budget, weekly 92% of 100%: only up to S now." */
export function passedLine(task: Pick<Item, 'id' | 'size'>, h: Headroom): string {
  return `Passed by ${task.id} (${(task.size ?? 'm').toUpperCase()}): ${headroomText(h)}.`;
}

/** Refuse to start a thread too large for the headroom left. One already being built goes on. */
export function refuseOverHeadroom(ctx: Ctx, task: Item): void {
  const h = headroomOf(ctx);
  if (fitsHeadroom(h, task.size)) return;
  throw new SpoolError(
    `${task.id} is ${(task.size ?? 'm').toUpperCase()}, and the chat is ${headroomText(h!)}`,
    'Take one that fits what is left: spool next. Wrap up what you are building. How near is near is the human\'s: spool target --headroom',
  );
}

/** What the chat hears near the end of its budget: what it may still take, and to wrap up. */
const WRAP_UP = (h: Headroom): string =>
  `Near the end: ${h.why}, so take only up to ${h.upTo.toUpperCase()} now; claims pass larger threads by.` +
  // Down to small work, what is in flight is wrapped up too.
  (SIZES.indexOf(h.upTo) <= SIZES.indexOf('s') ? ' Finish and land what you are building, or hand it off: spool handoff <id> -m "<where it stopped>".' : '');

/** "weekly 80%, 5-hour 90%". */
export function figuresText(figures: Figures): string {
  return LIMITS.filter((l) => figures[l] !== undefined)
    .map((l) => `${NAMES[l]} ${figures[l]}%`)
    .join(', ');
}

/** A percent as typed, `80` or `80%`: a target is a whole one from 1 to 100, a reading anything from 0 to 100. */
function percentOf(typed: string, limit: Limit, kind: 'target' | 'used'): number {
  const t = typed.trim();
  const n = /^\d+(?:\.\d+)?%?$/.test(t) ? Number(t.replace(/%$/, '')) : Number.NaN;
  if (kind === 'target' && !isTarget(n)) {
    throw new SpoolError(`"${typed}" is not a ${NAMES[limit]} target`, `Give a whole percent from 1 to 100, or none for no ${NAMES[limit]} target: spool target ${FLAGS[limit]} 80`);
  }
  if (kind === 'used' && !isUsed(n)) {
    throw new SpoolError(`"${typed}" is not a percent used`, `Give the ${NAMES[limit]} percent your usage tool shows, from 0 to 100: spool usage ${FLAGS[limit]} 62`);
  }
  return n;
}

/** "Last read 4m ago by Claude Opus 5.5: weekly 62%, 5-hour 18%." */
function readLine(read: Reading | null, now: Date): string {
  if (!read) return 'No usage has been read yet: the chat that builds reports it before each thread.';
  const when = age(read.at, now);
  return `Last read ${when === 'now' ? 'just now' : `${when} ago`} by ${read.by}: ${figuresText(read.used)}.`;
}

/** Where Fable stands: whether threads still go to it. Nothing where Fable was not read. */
function fableText(usage: Usage): string {
  const used = usage.read?.used.fable;
  if (used === undefined) return '';
  const goal = usage.target.fable;
  const against = goal !== undefined ? ` of its ${goal}% target` : '';
  return usage.fableCap !== null
    ? `Fable is at ${used}%${against}: no thread goes to Fable now, a step up or a thread set to it is built on Opus.`
    : `Fable is at ${used}%${against}: threads may still go to Fable.`;
}

/** What the target means, and where the last reading stands against it. */
function targetText(usage: Usage, now: Date): string {
  const { target, read, reached } = usage;
  const stops = STOPS.some((l) => target[l] !== undefined);
  const fable = fableText(usage);
  if (!stops) {
    return [
      'No usage target: a chat in Chat mode builds what is in Build, whatever the usage.',
      '  Set one on the page, in the header, or: spool target --weekly 80',
      ...(target.fable !== undefined ? [`  Fable target: ${target.fable}%. No thread goes to Fable once it is there.`] : []),
      ...(read ? [`  ${readLine(read, now)}`] : []),
      ...(fable ? [`  ${fable}`] : []),
    ].join('\n');
  }
  return [
    `Usage target: ${figuresText(target)}. A chat in Chat mode works up to it, then takes no new thread.`,
    `  ${readLine(read, now)}`,
    ...(fable ? [`  ${fable}`] : []),
    ...(reached.length ? [`  Reached: ${reached.map((l) => NAMES[l]).join(' and ')}. The chat takes no new thread until it is under again, or the target is raised.`] : []),
  ].join('\n');
}

/**
 * `spool target`: set the target, take one off with `none`, or with nothing typed only say what is
 * set. `guard` is the lock: it throws where the gate leaves this to the human, asked only for a change.
 */
/** Read `--headroom`: "80:m,90:s,97:xs", or default. Null is the default. */
function parseHeadroom(typed: string): Record<string, Size> | null {
  const t = typed.trim().toLowerCase();
  if (t === 'default') return null;
  const hint = 'Say from what percent of the budget used each size is the largest taken: spool target --headroom 80:m,90:s,97:xs, or default';
  const out: Record<string, Size> = {};
  for (const part of t.split(',')) {
    const m = /^(\d+)%?:(xs|s|m|l|xl)$/.exec(part.trim());
    if (!m || !isTarget(Number(m[1]))) throw new SpoolError(`"${part.trim()}" is not a headroom step`, hint);
    out[String(Number(m[1]))] = m[2] as Size;
  }
  return out;
}

/** "up to M from 80% of the budget, S from 90%, XS from 97%". */
function stepsText(steps: Array<[number, Size]>): string {
  if (!steps.length) return 'any size, however near the end';
  return steps.map(([at, size], i) => `${i ? '' : 'up to '}${size.toUpperCase()} from ${at}%${i ? '' : ' of the budget used'}`).join(', ');
}

export function targetCommand(ctx: Ctx, typed: Partial<Record<Limit, string>> & { headroom?: string }, guard: () => void): { text: string; data: Usage & { headroom: Array<[number, Size]> } } {
  const changes = new Map<Limit, number | null>();
  for (const limit of LIMITS) {
    const t = typed[limit];
    if (t !== undefined) changes.set(limit, t.trim().toLowerCase() === 'none' ? null : percentOf(t, limit, 'target'));
  }
  const before = targetOf(ctx);
  const steps = typed.headroom !== undefined ? parseHeadroom(typed.headroom) : undefined;
  const stepsChanged = steps !== undefined && JSON.stringify(steps ?? undefined) !== JSON.stringify(userConfig(ctx).headroom);
  if (stepsChanged) {
    guard();
    saveUserConfig(ctx, (config) => {
      if (steps) config.headroom = steps;
      else delete config.headroom;
    });
  }
  if ([...changes].some(([limit, value]) => (value ?? undefined) !== before[limit])) {
    guard();
    saveUserConfig(ctx, (config) => {
      const next: Figures = { ...before };
      for (const [limit, value] of changes) {
        if (value === null) delete next[limit];
        else next[limit] = value;
      }
      // No target at all is what nothing said means, so nothing is kept for it.
      if (Object.keys(next).length) config.usageTarget = next;
      else delete config.usageTarget;
    });
  }
  const usage = usageOf(ctx);
  const now = headroomSteps(ctx);
  // The headroom is said where it was just set or is not the default; the default goes without saying.
  const say = typed.headroom !== undefined || userConfig(ctx).headroom !== undefined;
  const line = say ? `\n  Near the end of the budget a chat takes ${stepsText(now)}. Back to the default: spool target --headroom default` : '';
  return { text: `${targetText(usage, ctx.now())}${line}`, data: { ...usage, headroom: now } };
}

/**
 * `spool usage`: the chat that builds reports the plan's usage it just read, and hears whether the
 * target lets it take another thread. With nothing typed it only says the last reading.
 */
export function usageCommand(ctx: Ctx, typed: Partial<Record<Limit, string>>, by: string): { text: string; data: Usage & { keepBuilding: boolean } } {
  const used: Figures = {};
  for (const limit of LIMITS) {
    const t = typed[limit];
    if (t !== undefined) used[limit] = percentOf(t, limit, 'used');
  }
  const reported = Object.keys(used).length > 0;
  if (reported) {
    const file = readingFile(ctx);
    if (!file) throw new SpoolError('no home directory to keep the usage in');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reading: Reading = { used, at: ctx.now().toISOString(), by };
    fs.writeFileSync(file, `${JSON.stringify(reading, null, 2)}\n`);
  }
  const usage = usageOf(ctx);
  const headroom = headroomOf(ctx);
  const data = { ...usage, keepBuilding: usage.reached.length === 0, headroom };
  if (!reported) return { text: targetText(usage, ctx.now()), data };
  const { target, read, reached } = usage;
  const fable = fableText(usage);
  // Near the end, what is worth starting shrinks, and what is in flight is wrapped up.
  const near = headroom && !reached.length ? `\n  ${WRAP_UP(headroom)}` : '';
  const withFable = (text: string) => (fable ? `${text}${near}\n  ${fable}` : `${text}${near}`);
  if (!STOPS.some((l) => target[l] !== undefined)) return { text: withFable('No usage target is set: build what is in Build, whatever the usage.'), data };
  // A limit with a target that this reading did not give is not checked, and the chat is told so.
  const unread = STOPS.filter((l) => target[l] !== undefined && read?.used[l] === undefined);
  const missing = unread.length ? `\n  The ${unread.map((l) => NAMES[l]).join(' and ')} figure was not given, so its target was not checked.` : '';
  const against = STOPS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined).map((l) => `${NAMES[l]} ${read!.used[l]}% of ${target[l]}%`);
  if (!reached.length) return { text: withFable(`Keep building: ${against.join(', ') || 'nothing to check'}.${missing}`), data };
  return {
    text: [
      `Stop: the usage target is reached, ${against.join(', ')}.`,
      '  Claim no new thread, and let what is being built land. Tell them once.',
      '  Read the usage again when a thread lands or Build changes, and carry on once it is under the target or they raise it.',
    ].join('\n') + missing,
    data,
  };
}
