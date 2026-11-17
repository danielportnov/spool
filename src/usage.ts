/**
 * A usage target: how much of their Claude plan the user wants used while a chat builds.
 *
 * In Chat mode a Claude Code chat running /spool-loop builds what is in Build. The user sets a
 * target, in the page's header or with `spool target`: a percent of the plan's weekly limit, of its
 * 5-hour limit, or of both. The chat works up to it. Before it takes each thread it reads the plan's
 * usage with its own harness's tool and reports it with `spool usage`, which says whether to keep
 * building or stop.
 *
 * Spool never reads the usage itself: that would mean taking the account's credentials and calling
 * a service, and a work queue has no business doing either. It keeps what the chat tells it. The
 * plan is the account's, so the target is too: it is kept in the user's own settings and holds in
 * every project. The last figures read are kept beside them, in `usage.json`, for the page to show.
 *
 * Several agents can work one spool (roster.ts), each on its own plan: a Claude chat and a Codex
 * chat. Each reports its own reading, signed with its name (`spool usage --weekly 62 --as "Codex
 * GPT-6"`), and is held to its own target (`spool target --agent Codex --weekly 50`). A limit an
 * agent has no target of its own for takes the one set for all. An agent that cannot read its
 * plan says so (`spool usage --cannot-read`), and the board says it too. `usageOf(ctx, agent)` is
 * the one way to ask where an agent stands. Fable's own limit is Claude's alone.
 *
 * Codex is the one plan Spool reads for itself: Codex writes its ChatGPT plan's limits into its own
 * session logs, on this machine, and Spool takes the figures from there (codex.ts) whenever they are
 * newer than what Codex last reported. `spool usage --from-codex` reports them as Codex's reading.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NOT_AGENTS, signer } from './agent.ts';
import { codexLimits, codexSessionsDir } from './codex.ts';
import { type Ctx, configDir, saveUserConfig, userConfig } from './context.ts';
import { type Item, SIZES, type Size, SpoolError } from './model.ts';
import { age } from './render.ts';
import { type TimeView, timeOf } from './until.ts';

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
/** A reading older than this is not taken as the usage now: a claim or a take-over is not refused on it. */
export const FRESH_MS = 30 * 60_000;
/** Whose a reading or a target is where nobody named an agent: the chat that built before there were several. */
export const DEFAULT_AGENT = 'Claude';
/** The agent whose plan Spool can read for itself, from its own session logs (codex.ts). */
export const CODEX_AGENT = 'Codex';
/** Who a reading taken from Codex's session log is signed by. */
const CODEX_LOG = 'Codex, from its session log';

/** A percent for each limit that has one. */
export type Figures = Partial<Record<Limit, number>>;

/** What the chat last read: the percent of each limit used, when, and who read it. */
export interface Reading {
  used: Figures;
  at: string;
  by: string;
  /** The agent said it has no way to read its plan's usage: `used` is empty. */
  cannotRead?: boolean;
}

export interface Usage {
  /** Whose usage this is: the agent's name, as on the roster. */
  agent: string;
  /** The target it is held to for each limit that has one: its own, else the one for all. Empty: no target, and it builds as it always did. */
  target: Figures;
  /** The target set for this agent alone, each limit it has one for. */
  own: Figures;
  /** It said it cannot read its usage, so it is not held to a target. */
  cannotRead: boolean;
  /** The last reading reported, or null where none has been. */
  read: Reading | null;
  /** The limits whose last reading is at or past their target. */
  reached: Limit[];
  /** Fable's percent where it is at or over its target (or nearly spent, with none set), so no thread goes to Fable; else null. */
  fableCap: number | null;
}

const isTarget = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
const isUsed = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

function cleanTarget(set: Record<string, unknown> | undefined): Figures {
  const out: Figures = {};
  for (const limit of LIMITS) if (isTarget(set?.[limit])) out[limit] = set![limit] as number;
  return out;
}

/** The agent an actor is: "Codex GPT-6" is Codex. A name that is no agent's (human, agent) is the default, Claude. */
export function agentOf(actor: string): string {
  const agent = signer(actor).agent;
  return NOT_AGENTS.has(agent.toLowerCase()) ? DEFAULT_AGENT : agent;
}

const sameAgent = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The key a record by agent keeps this agent under, matched without case. */
function keyIn(record: Record<string, unknown> | undefined, agent: string): string | undefined {
  return Object.keys(record ?? {}).find((k) => sameAgent(k, agent));
}

/** The target set for this agent alone. */
export function ownTargetOf(ctx: Ctx, agent: string): Figures {
  const all = userConfig(ctx).agentTargets;
  const key = keyIn(all, agent);
  return key ? cleanTarget(all![key]) : {};
}

/** Every agent with a target of its own, and that target. */
export function ownTargets(ctx: Ctx): Record<string, Figures> {
  const out: Record<string, Figures> = {};
  for (const name of Object.keys(userConfig(ctx).agentTargets ?? {})) {
    const own = ownTargetOf(ctx, name);
    if (Object.keys(own).length) out[name] = own;
  }
  return out;
}

/**
 * The target on file, with anything that is not a whole percent from 1 to 100 left out. With no
 * agent, the one for all; with one, what that agent is held to: its own, and the one for all where it has none.
 */
export function targetOf(ctx: Ctx, agent?: string): Figures {
  const all = cleanTarget(userConfig(ctx).usageTarget);
  return agent ? { ...all, ...ownTargetOf(ctx, agent) } : all;
}

function readingFile(ctx: Ctx): string {
  const dir = configDir(ctx);
  return dir ? path.join(dir, 'usage.json') : '';
}

type RawReading = { used?: Record<string, unknown>; at?: unknown; by?: unknown; cannotRead?: unknown };

/** One reading as kept, or null where it is not one `spool usage` wrote. */
function cleanReading(raw: RawReading | null | undefined): Reading | null {
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return null;
  const by = typeof raw.by === 'string' ? raw.by : 'agent';
  if (raw.cannotRead === true) return { used: {}, at: raw.at, by, cannotRead: true };
  const used: Figures = {};
  for (const limit of LIMITS) {
    const v = raw.used?.[limit];
    if (isUsed(v)) used[limit] = v;
  }
  if (!Object.keys(used).length) return null;
  return { used, at: raw.at, by };
}

/**
 * What the file holds: the last reading of all (as it always was, for anything that reads it so),
 * and each agent's own. A file from before there were several is that one reading, by whoever signed it.
 */
function readingsFile(ctx: Ctx): { last: RawReading | null; agents: Record<string, RawReading> } {
  const file = readingFile(ctx);
  if (!file) return { last: null, agents: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as (RawReading & { agents?: Record<string, RawReading> }) | null;
    if (!parsed || typeof parsed !== 'object') return { last: null, agents: {} };
    const { agents, ...last } = parsed;
    if (agents && typeof agents === 'object') return { last, agents };
    const one = cleanReading(last);
    return { last, agents: one ? { [agentOf(one.by)]: last } : {} };
  } catch {
    return { last: null, agents: {} };
  }
}

/** The last reading this agent reported (Claude where none is named), or null where there is none. */
export function readingOf(ctx: Ctx, agent: string = DEFAULT_AGENT): Reading | null {
  const { agents } = readingsFile(ctx);
  const key = keyIn(agents, agent);
  const reported = key ? cleanReading(agents[key]) : null;
  if (!sameAgent(agent, CODEX_AGENT)) return reported;
  // Codex's plan, as its own session log has it, where that is newer than what it last reported.
  const log = codexLimits(ctx);
  if (!log || (reported && Date.parse(reported.at) >= Date.parse(log.at))) return reported;
  return { used: log.used, at: log.at, by: CODEX_LOG };
}

/** Every agent that has reported, by name, and Codex where its session log has its plan's usage. */
export function readingAgents(ctx: Ctx): string[] {
  const { agents } = readingsFile(ctx);
  const out = Object.keys(agents).filter((k) => cleanReading(agents[k]));
  if (!out.some((a) => sameAgent(a, CODEX_AGENT)) && codexLimits(ctx)) out.push(CODEX_AGENT);
  return out;
}

/** Fable's percent when it is at or over its target (95% where it has none) in a reading read within a day. */
function fableCapOf(target: Figures, read: Reading | null, now: Date): number | null {
  const used = read?.used.fable;
  if (used === undefined || !read || now.getTime() - Date.parse(read.at) > FABLE_FRESH_MS) return null;
  return used >= (target.fable ?? FABLE_NEAR) ? used : null;
}

/** Fable's percent where no thread should go to Fable now, else undefined. Fable is Claude's: its reading decides. */
export function fableCap(ctx: Ctx): number | undefined {
  const { fableCap: at } = usageOf(ctx, DEFAULT_AGENT);
  return at ?? undefined;
}

/**
 * Where one agent stands: the target it is held to, its last reading, and which limits that
 * reading has reached. With no agent named, Claude: the one chat that built before there were several.
 */
export function usageOf(ctx: Ctx, agent: string = DEFAULT_AGENT): Usage {
  const target = targetOf(ctx, agent);
  const read = readingOf(ctx, agent);
  const reached = STOPS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined && read.used[l]! >= target[l]!);
  return { agent, target, own: ownTargetOf(ctx, agent), cannotRead: !!read?.cannotRead, read, reached, fableCap: fableCapOf(target, read, ctx.now()) };
}

/** Where nobody has set or read anything: the board's usage before the page has read any. */
export function noUsage(): Usage & { all: Figures } {
  return { agent: DEFAULT_AGENT, target: {}, own: {}, cannotRead: false, read: null, reached: [], fableCap: null, all: {} };
}

/**
 * Refuse a claim by an agent whose own reading, read in the last half hour, has reached its own
 * target. An older reading, or none, refuses nothing: the agent reads it again before it claims.
 */
export function refuseOverTarget(ctx: Ctx, actor: string): void {
  const usage = usageOf(ctx, agentOf(actor));
  const { read, reached, target } = usage;
  if (!reached.length || !read || ctx.now().getTime() - Date.parse(read.at) > FRESH_MS) return;
  const against = reached.map((l) => `${NAMES[l]} ${read.used[l]}% of ${target[l]}%`).join(', ');
  throw new SpoolError(
    `${usage.agent}'s usage target is reached, ${against}`,
    `Claim no new thread: let what is being built land. Read the usage again when one lands, and carry on once it is under. Raising it is the user's: spool target --agent ${usage.agent} --weekly <n>`,
  );
}

/**
 * Headroom: as a budget runs low, the largest thread worth starting shrinks, so nothing is begun
 * that cannot be finished before it runs out. A budget is anything with a fraction used: the plan's
 * usage against the target (here), or a time budget. Each step says the largest size from that
 * percent of the budget used. The user sets the steps; these are the default.
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
  /** "weekly 92% of 100%", or "time to work until 1:00, 25 min left". */
  why: string;
  /** The time to work has passed: no thread fits, whatever its size. */
  over?: boolean;
}

/**
 * The headroom the last reading leaves, or null where it leaves room for any size. Each of the
 * plan's limits counts against its target, or against the whole limit where it has none: the plan
 * runs out at 100% whatever the target. The time to work (until.ts) is a budget too, the share of
 * its window gone; once it has passed, nothing fits. The budget nearest its end decides.
 */
export function headroomOf(ctx: Ctx, agent: string = DEFAULT_AGENT): Headroom | null {
  const { target, read } = usageOf(ctx, agent);
  const time = timeOf(ctx);
  if (time?.passed) return { used: 100, upTo: 'xs', why: time.why, over: true };
  let worst: { used: number; why: string } | null = time ? { used: time.usedPercent, why: time.why } : null;
  const fresh = read && ctx.now().getTime() - Date.parse(read.at) <= HEADROOM_FRESH_MS;
  if (fresh) for (const l of STOPS) {
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
  if (h.over) return `past the end of the budget, ${h.why}: nothing new now`;
  return `near the end of the budget, ${h.why}: only up to ${h.upTo.toUpperCase()} now`;
}

/** Whether a thread fits the headroom. A thread with no size counts as medium. */
export function fitsHeadroom(h: Headroom | null, size: Size | undefined): boolean {
  if (h?.over) return false;
  return !h || SIZES.indexOf(size ?? 'm') <= SIZES.indexOf(h.upTo);
}

/**
 * The threads a chat may start with the headroom left, and the line that says why the first one
 * it would have taken is passed by, where one is.
 */
export function withinHeadroom<T extends Pick<Item, 'id' | 'size'>>(ctx: Ctx, list: T[], agent?: string): { fits: T[]; passed: string | null; headroom: Headroom | null } {
  const headroom = headroomOf(ctx, agent);
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
export function refuseOverHeadroom(ctx: Ctx, task: Item, agent?: string): void {
  const h = headroomOf(ctx, agent);
  if (fitsHeadroom(h, task.size)) return;
  throw new SpoolError(
    `${task.id} is ${(task.size ?? 'm').toUpperCase()}, and the chat is ${headroomText(h!)}`,
    h!.over
      ? 'Finish and land what you are building, or hand it off: spool handoff <id> -m "<where it stopped>". The end is the user\'s: spool until'
      : 'Take one that fits what is left: spool next. Wrap up what you are building. How near is near is the user\'s: spool target --headroom',
  );
}

/** What the chat hears near the end of its budget: what it may still take, and to wrap up. */
const WRAP_UP = (h: Headroom): string =>
  `Near the end: ${h.why}, so take only up to ${h.upTo.toUpperCase()} now; claims pass larger threads by.` +
  // Down to small work, what is in flight is wrapped up too.
  (SIZES.indexOf(h.upTo) <= SIZES.indexOf('s') ? ' Finish and land what you are building, or hand it off: spool handoff <id> -m "<where it stopped>".' : '');

/** The time to work for the board, with the largest size it lets the chat start now (null: any). */
export function timeLeftOf(ctx: Ctx): (TimeView & { upTo: Size | null }) | null {
  const time = timeOf(ctx);
  if (!time) return null;
  return { ...time, upTo: time.passed ? null : sizeForBudget(time.usedPercent, headroomSteps(ctx)) };
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
  if (read.cannotRead) return `${read.by} said ${when === 'now' ? 'just now' : `${when} ago`} that it cannot read its usage, so it is not held to a target.`;
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

/** Each agent's own target, a line each: "  Codex: weekly 50%, its own." */
function ownLines(ctx: Ctx): string[] {
  return Object.entries(ownTargets(ctx)).map(([agent, own]) => `  ${agent}: ${figuresText(own)}, its own. Any other limit is the one for all.`);
}

/** What one agent's target means, and where its last reading stands against it. */
function agentText(usage: Usage, now: Date): string {
  const { agent, target, own, read, reached } = usage;
  const stops = STOPS.some((l) => target[l] !== undefined);
  const fable = agent === DEFAULT_AGENT ? fableText(usage) : '';
  const whose = Object.keys(own).length ? `its own ${figuresText(own)}` : 'none of its own, so the one for all';
  return [
    stops ? `${agent}'s usage target: ${figuresText(target)} (${whose}). ${agent} works up to it, then takes no new thread.` : `${agent} has no usage target: it builds what is in Build, whatever the usage.`,
    `  ${readLine(read, now)}`,
    ...(fable ? [`  ${fable}`] : []),
    ...(reached.length ? [`  Reached: ${reached.map((l) => NAMES[l]).join(' and ')}. ${agent} takes no new thread until it is under again, or its target is raised.`] : []),
  ].join('\n');
}

/** What the target means, and where the last reading stands against it. */
function targetText(usage: Usage, now: Date, own: string[] = []): string {
  const { target, read, reached } = usage;
  const stops = STOPS.some((l) => target[l] !== undefined);
  const fable = fableText(usage);
  if (!stops) {
    return [
      'No usage target: a chat in Chat mode builds what is in Build, whatever the usage.',
      '  Set one in the page’s Settings, or: spool target --weekly 80',
      ...(target.fable !== undefined ? [`  Fable target: ${target.fable}%. No thread goes to Fable once it is there.`] : []),
      ...own,
      ...(read ? [`  ${readLine(read, now)}`] : []),
      ...(fable ? [`  ${fable}`] : []),
    ].join('\n');
  }
  return [
    `Usage target: ${figuresText(target)}. A chat in Chat mode works up to it, then takes no new thread.`,
    ...own,
    `  ${readLine(read, now)}`,
    ...(fable ? [`  ${fable}`] : []),
    ...(reached.length ? [`  Reached: ${reached.map((l) => NAMES[l]).join(' and ')}. The chat takes no new thread until it is under again, or the target is raised.`] : []),
  ].join('\n');
}

/**
 * `spool target`: set the target, take one off with `none`, or with nothing typed only say what is
 * set. `guard` is the lock: it throws where the gate leaves this to the user, asked only for a change.
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

export function targetCommand(
  ctx: Ctx,
  typed: Partial<Record<Limit, string>> & { headroom?: string },
  guard: () => void,
  agent?: string,
): { text: string; data: Usage & { headroom: Array<[number, Size]>; all: Figures; agents: Record<string, Figures> } } {
  const changes = new Map<Limit, number | null>();
  for (const limit of LIMITS) {
    const t = typed[limit];
    if (t !== undefined) changes.set(limit, t.trim().toLowerCase() === 'none' ? null : percentOf(t, limit, 'target'));
  }
  if (agent !== undefined && !agent.trim()) throw new SpoolError('which agent?', 'spool target --agent Codex --weekly 50');
  // For one agent, its own: none there means it takes the one for all again.
  const before = agent ? ownTargetOf(ctx, agent) : targetOf(ctx);
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
      if (!agent) {
        if (Object.keys(next).length) config.usageTarget = next;
        else delete config.usageTarget;
        return;
      }
      const all = { ...(config.agentTargets ?? {}) };
      const key = keyIn(all, agent) ?? agent;
      if (Object.keys(next).length) all[key] = next;
      else delete all[key];
      if (Object.keys(all).length) config.agentTargets = all;
      else delete config.agentTargets;
    });
  }
  const extra = { all: targetOf(ctx), agents: ownTargets(ctx) };
  if (agent) {
    const usage = usageOf(ctx, agent);
    return { text: agentText(usage, ctx.now()), data: { ...usage, ...extra, headroom: headroomSteps(ctx) } };
  }
  // The target for all, against the reading of the chat that always built here.
  const usage = usageOf(ctx);
  const now = headroomSteps(ctx);
  // The headroom is said where it was just set or is not the default; the default goes without saying.
  const say = typed.headroom !== undefined || userConfig(ctx).headroom !== undefined;
  const line = say ? `\n  Near the end of the budget a chat takes ${stepsText(now)}. Back to the default: spool target --headroom default` : '';
  return { text: `${targetText({ ...usage, target: extra.all }, ctx.now(), ownLines(ctx))}${line}`, data: { ...usage, ...extra, headroom: now } };
}

/**
 * `spool usage`: the chat that builds reports the plan's usage it just read, and hears whether the
 * target lets it take another thread. With nothing typed it only says the last reading.
 */
export function usageCommand(
  ctx: Ctx,
  typed: Partial<Record<Limit, string>>,
  by: string,
  cannotRead = false,
  fromCodex = false,
): { text: string; data: Usage & { keepBuilding: boolean } } {
  const used: Figures = {};
  for (const limit of LIMITS) {
    const t = typed[limit];
    if (t !== undefined) used[limit] = percentOf(t, limit, 'used');
  }
  if (cannotRead && Object.keys(used).length) throw new SpoolError('--cannot-read says there are no figures: give one or the other', 'spool usage --cannot-read, or spool usage --weekly 62');
  if (fromCodex && (cannotRead || Object.keys(used).length)) throw new SpoolError('--from-codex reads the figures itself: give no others', 'spool usage --from-codex --as Codex');
  // Read from Codex's session log, the reading is Codex's whoever runs it, and as old as the log line.
  let at = ctx.now().toISOString();
  if (fromCodex) {
    const log = codexLimits(ctx);
    if (!log) {
      throw new SpoolError(
        `Codex's usage cannot be read here: no Codex session under ${codexSessionsDir(ctx) || '~/.codex/sessions'} has its plan's limits`,
        'Codex signed in with an API key has none. Read them in Codex (/status) and give them: spool usage --weekly <n> --five-hour <n> --as Codex, or spool usage --cannot-read --as Codex',
      );
    }
    Object.assign(used, log.used);
    at = log.at;
    if (agentOf(by).toLowerCase() !== CODEX_AGENT.toLowerCase()) by = CODEX_LOG;
  }
  const agent = fromCodex ? CODEX_AGENT : agentOf(by);
  const reported = Object.keys(used).length > 0 || cannotRead;
  if (reported) {
    const file = readingFile(ctx);
    if (!file) throw new SpoolError('no home directory to keep the usage in');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reading: Reading = cannotRead ? { used: {}, at, by, cannotRead: true } : { used, at, by };
    // Each agent's under its own name; the last of all stays at the top, as it always was.
    const { agents } = readingsFile(ctx);
    const key = keyIn(agents, agent) ?? agent;
    fs.writeFileSync(file, `${JSON.stringify({ ...reading, agents: { ...agents, [key]: reading } }, null, 2)}\n`);
  }
  const usage = usageOf(ctx, agent);
  const headroom = headroomOf(ctx, agent);
  const data = { ...usage, keepBuilding: usage.reached.length === 0 && !headroom?.over, headroom };
  if (!reported) return { text: Object.keys(usage.own).length || agent !== DEFAULT_AGENT ? agentText(usage, ctx.now()) : targetText(usage, ctx.now()), data };
  if (cannotRead) {
    return { text: `Noted: ${agent} cannot read its usage. The board says so, and it is held to no target: build as if none were set.`, data };
  }
  const { target, read, reached } = usage;
  // A log line older than the half hour a claim trusts: said, so nobody takes it for the usage now.
  const stale = fromCodex && ctx.now().getTime() - Date.parse(at) > FRESH_MS ? `\n  Codex's session log was last written ${age(at, ctx.now())} ago, so this is not taken as its usage now: report it again once Codex has taken a turn.` : '';
  const when = age(at, ctx.now());
  const lead = fromCodex ? `Read from Codex's session log, written ${when === 'now' ? 'just now' : `${when} ago`}: ${figuresText(used)}.${stale}\n` : '';
  // Past the time to work it is a stop, whatever the usage: a soft one, so what is building lands.
  if (headroom?.over && !reached.length) {
    return {
      text: lead + [
        `Stop: the ${headroom.why}.`,
        '  Claim no new thread. Finish and land what is being built, or hand it off; a minute or two past is fine. Tell them once.',
      ].join('\n'),
      data,
    };
  }
  const fable = fableText(usage);
  // Near the end, what is worth starting shrinks, and what is in flight is wrapped up.
  const near = headroom && !reached.length ? `\n  ${WRAP_UP(headroom)}` : '';
  const withFable = (text: string) => (fable ? `${text}${near}\n  ${fable}` : `${text}${near}`);
  if (!STOPS.some((l) => target[l] !== undefined)) return { text: lead + withFable('No usage target is set: build what is in Build, whatever the usage.'), data };
  // A limit with a target that this reading did not give is not checked, and the chat is told so.
  const unread = STOPS.filter((l) => target[l] !== undefined && read?.used[l] === undefined);
  const missing = unread.length ? `\n  The ${unread.map((l) => NAMES[l]).join(' and ')} figure was not given, so its target was not checked.` : '';
  const against = STOPS.filter((l) => target[l] !== undefined && read?.used[l] !== undefined).map((l) => `${NAMES[l]} ${read!.used[l]}% of ${target[l]}%`);
  if (!reached.length) return { text: lead + withFable(`Keep building: ${against.join(', ') || 'nothing to check'}.${missing}`), data };
  return {
    text: lead + [
      `Stop: ${Object.keys(usage.own).length || agent !== DEFAULT_AGENT ? `${agent}'s` : 'the'} usage target is reached, ${against.join(', ')}.`,
      '  Claim no new thread, and let what is being built land. Tell them once.',
      '  Read the usage again when a thread lands or Build changes, and carry on once it is under the target or they raise it.',
    ].join('\n') + missing,
    data,
  };
}
