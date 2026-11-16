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
import { SpoolError } from './model.ts';
import { age } from './render.ts';

/** The plan's limits a target can be set on. */
export const LIMITS = ['weekly', 'fiveHour'] as const;
export type Limit = (typeof LIMITS)[number];
const NAMES: Record<Limit, string> = { weekly: 'weekly', fiveHour: '5-hour' };
const FLAGS: Record<Limit, string> = { weekly: '--weekly', fiveHour: '--five-hour' };

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

/** The target, the last reading, and which limits that reading has reached. */
export function usageOf(ctx: Ctx): Usage {
  const target = targetOf(ctx);
  const read = readingOf(ctx);
  const reached = LIMITS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined && read.used[l]! >= target[l]!);
  return { target, read, reached };
}

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

/** What the target means, and where the last reading stands against it. */
function targetText(usage: Usage, now: Date): string {
  const { target, read, reached } = usage;
  if (!Object.keys(target).length) {
    return [
      'No usage target: a chat in Chat mode builds what is in Build, whatever the usage.',
      '  Set one on the page, in the header, or: spool target --weekly 80',
      ...(read ? [`  ${readLine(read, now)}`] : []),
    ].join('\n');
  }
  return [
    `Usage target: ${figuresText(target)}. A chat in Chat mode works up to it, then takes no new thread.`,
    `  ${readLine(read, now)}`,
    ...(reached.length ? [`  Reached: ${reached.map((l) => NAMES[l]).join(' and ')}. The chat takes no new thread until it is under again, or the target is raised.`] : []),
  ].join('\n');
}

/**
 * `spool target`: set the target, take one off with `none`, or with nothing typed only say what is
 * set. `guard` is the lock: it throws where the gate leaves this to the human, asked only for a change.
 */
export function targetCommand(ctx: Ctx, typed: Partial<Record<Limit, string>>, guard: () => void): { text: string; data: Usage } {
  const changes = new Map<Limit, number | null>();
  for (const limit of LIMITS) {
    const t = typed[limit];
    if (t !== undefined) changes.set(limit, t.trim().toLowerCase() === 'none' ? null : percentOf(t, limit, 'target'));
  }
  const before = targetOf(ctx);
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
  return { text: targetText(usage, ctx.now()), data: usage };
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
  const data = { ...usage, keepBuilding: usage.reached.length === 0 };
  if (!reported) return { text: targetText(usage, ctx.now()), data };
  const { target, read, reached } = usage;
  if (!Object.keys(target).length) return { text: 'No usage target is set: build what is in Build, whatever the usage.', data };
  // A limit with a target that this reading did not give is not checked, and the chat is told so.
  const unread = LIMITS.filter((l) => target[l] !== undefined && read?.used[l] === undefined);
  const missing = unread.length ? `\n  The ${unread.map((l) => NAMES[l]).join(' and ')} figure was not given, so its target was not checked.` : '';
  const against = LIMITS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined).map((l) => `${NAMES[l]} ${read!.used[l]}% of ${target[l]}%`);
  if (!reached.length) return { text: `Keep building: ${against.join(', ') || 'nothing to check'}.${missing}`, data };
  return {
    text: [
      `Stop: the usage target is reached, ${against.join(', ')}.`,
      '  Claim no new thread, and let what is being built land. Tell them once.',
      '  Read the usage again when a thread lands or Build changes, and carry on once it is under the target or they raise it.',
    ].join('\n') + missing,
    data,
  };
}
