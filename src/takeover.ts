/**
 * Taking over the backlog: in Chat mode, the chat that builds may fill Build itself.
 *
 * Nothing is built until the human moves it to Build. Taking over is the human saying the chat may
 * do that for them, within the usage target they set: with Build empty and the plan's usage under
 * the target, the chat moves the top thread they filed to Build itself, with
 * `spool build --takeover`, and builds it. It stops once the target is reached.
 *
 * It is one switch for each project, kept beside who builds it, in the user's own settings. The
 * human switches it on, on the board or by saying so in the chat (`spool takeover on`); where the
 * gate is locked only they can. Switching it off is anyone's: it only ever stops something.
 *
 * Which threads it may take is fixed here, not left to the chat: a thread in the backlog that a
 * person filed (never one an agent suggested), not on hold, not archived, and waiting on nothing,
 * no question and no plan's go-ahead. Top of the backlog first, as the board shows it. Each move is
 * signed by the agent and says so on the thread, the brief shows each one that lands, and
 * `spool revert` takes one back like any other.
 */

import type { Call, Result } from './commands.ts';
import { type Ctx, builderOf, saveUserConfig, userConfig } from './context.ts';
import { type Item, type Spool, SpoolError, isRun, oneLine, splitBody } from './model.ts';
import { withinSizes } from './roster.ts';
import { blockers, docket, ready } from './schedule.ts';
import type { Workspace } from './store.ts';
import { STOPS, figuresText, headroomText, usageOf, withinHeadroom } from './usage.ts';

/** A reading older than this is not taken as the usage now: the chat reads it again first. */
export const FRESH_MS = 30 * 60_000;

/** What the log line of a thread moved this way starts with: the brief finds them by it. */
export const MOVED = 'moved to build, taking over the backlog';

const NAMES = { weekly: 'weekly', fiveHour: '5-hour' } as const;

/** Whether the chat takes over this project's backlog. */
export function takeOverOf(ctx: Ctx, root: string): boolean {
  return userConfig(ctx).takeOver?.[root] === true;
}

function save(ctx: Ctx, root: string, on: boolean): void {
  saveUserConfig(ctx, (config) => {
    const all = { ...(config.takeOver ?? {}) };
    // Off is what nothing said means, so nothing is kept for it.
    if (on) all[root] = true;
    else delete all[root];
    if (Object.keys(all).length) config.takeOver = all;
    else delete config.takeOver;
  });
}

/** The threads the chat may take, top of the backlog first. */
export function reasonable(ws: Workspace, spool: Spool): Item[] {
  return docket(ws, spool).proposed.filter((t) => !t.suggested && !t.hold && !t.archived && !isRun(t) && !blockers(ws, t).length && !undone(t));
}

/** Whether the human undid this thread and has not moved it to Build since: it waits for them, not for the chat. */
function undone(t: Item): boolean {
  const log = splitBody(t.body).log;
  const at = (re: RegExp): number => log.findLastIndex((l) => re.test(l.replace(/^- \S+ \S+ [^:]+: /, '')));
  return at(/^reverted \d+ commit/) > at(/^moved to build/);
}

/** Why a thread in the backlog is not one the chat may take. */
function notReasonable(ws: Workspace, t: Item): string {
  if (t.status !== 'proposed') return `${t.id} is not in the backlog`;
  if (t.suggested) return `${t.id} is AI suggested: only the human moves an agent's idea to build`;
  if (t.hold) return `${t.id} is on hold: ${t.hold}`;
  if (t.archived) return `${t.id} is archived`;
  if (undone(t)) return `${t.id} was undone: it waits for the human to move it to Build`;
  const waits = blockers(ws, t);
  if (waits.length) return `${t.id} waits on ${waits.map((w) => w.id).join(', ')}`;
  return `${t.id} is not one the chat may take`;
}

/** The usage now against the target, "weekly 40% of 80%", or why it does not let the chat move a thread. */
function underTarget(ctx: Ctx): { ok: true; against: string } | { ok: false; why: string; hint: string } {
  const { target, read, reached } = usageOf(ctx);
  const set = STOPS.filter((l) => target[l] !== undefined);
  if (!set.length) return { ok: false, why: 'no usage target is set, and taking over works up to one', hint: 'The human sets one, on the board or: spool target --weekly 80' };
  const report = 'Read it with your harness\'s tool and report it first: spool usage --weekly <n> --five-hour <n>';
  if (!read || ctx.now().getTime() - Date.parse(read.at) > FRESH_MS) return { ok: false, why: 'the usage has not been read in the last 30 minutes', hint: report };
  const unread = set.filter((l) => read.used[l] === undefined);
  if (unread.length) return { ok: false, why: `the ${unread.map((l) => NAMES[l]).join(' and ')} usage was not read, so its target cannot be checked`, hint: report };
  const against = set.map((l) => `${NAMES[l]} ${read.used[l]}% of ${target[l]}%`).join(', ');
  if (reached.length) return { ok: false, why: `the usage target is reached, ${against}`, hint: 'Move nothing more. Let what is building land, and tell them once.' };
  return { ok: true, against };
}

/** Why the chat may not move a thread to build in this project now, or null where it may. */
function whyNot(ctx: Ctx, ws: Workspace, spool: Spool): { why: string; hint: string } | null {
  if (!takeOverOf(ctx, spool.root)) {
    return { why: `taking over the backlog is off in ${spool.name}`, hint: 'Only the human moves work to build. They switch taking over on, on the board or: spool takeover on' };
  }
  if (builderOf(ctx, spool.root) !== 'chat') return { why: `${spool.name} is built headless: taking over is for a chat in Chat mode`, hint: 'spool builder chat, on their word' };
  const usage = underTarget(ctx);
  if (!usage.ok) return usage;
  const waiting = ready(ws, spool).filter((t) => !isRun(t));
  if (waiting.length) return { why: `Build has work waiting: ${waiting[0]!.id} ${oneLine(waiting[0]!.title, 60)}`, hint: 'Build what is there first. Take from the backlog only when Build is empty.' };
  return null;
}

/** Where taking over stands in a project, for the board and the command. */
export interface TakeOver {
  on: boolean;
  /** The thread it would move next, where it may move one. */
  next: { id: string; title: string } | null;
  /** Why it moves nothing now, where it is on and does not. */
  waiting: string | null;
}

export function takeOverState(ctx: Ctx, ws: Workspace, spool: Spool): TakeOver {
  const on = takeOverOf(ctx, spool.root);
  if (!on) return { on, next: null, waiting: null };
  const top = reasonable(ws, spool)[0];
  const next = top ? { id: top.id, title: top.title } : null;
  const why = whyNot(ctx, ws, spool);
  return { on, next, waiting: why ? why.why : top ? null : 'nothing in the backlog it may take' };
}

/** `spool takeover`: switch it on or off, or with nothing after it say where it stands. `byHuman` refuses an agent switching it on where the gate is locked. */
export function takeoverCommand(call: Call, spool: Spool, byHuman: () => void): Result {
  const { ctx, ws, args } = call;
  const word = args[0];
  if (args.length > 1 || (word !== undefined && word !== 'on' && word !== 'off')) {
    throw new SpoolError('on, or off?', 'spool takeover on, spool takeover off, or spool takeover to see where it stands');
  }
  const was = takeOverOf(ctx, spool.root);
  if (word !== undefined && (word === 'on') !== was) {
    // Switching it on lets an agent move work to build: where the gate is locked, that takes the human. Off only stops something.
    if (word === 'on') byHuman();
    save(ctx, spool.root, word === 'on');
  }
  const state = takeOverState(ctx, ws, spool);
  const lines = state.on
    ? [
        `The chat takes over ${spool.name}'s backlog: with Build empty and the usage under the target, it moves the top thread you filed to Build itself, and builds it.`,
        '  Never an AI suggested one, one on hold, or one waiting on a question or a plan\'s go-ahead. Each says so on its thread, and spool revert takes one back.',
        state.waiting ? `  Not now: ${state.waiting}.` : state.next ? `  Next: ${state.next.id} ${oneLine(state.next.title, 70)}` : '',
        '  Off: spool takeover off',
      ]
    : [`The chat does not take over ${spool.name}'s backlog: nothing moves to Build without you.`, '  On, in Chat mode and up to the usage target: spool takeover on'];
  return { text: lines.filter(Boolean).join('\n'), data: { project: spool.name, ...state } };
}

/**
 * `spool build --takeover`: the chat moves one thread to build itself. With no id it is the top
 * one it may take. Refused unless taking over is on, a chat builds, the usage is read and under the
 * target, and Build is empty. `line` is what the thread's log says of it.
 */
export function buildUnderTakeOver(call: Call): { tasks: Item[]; line: string; passed: string } {
  const { ctx, ws, args, opts } = call;
  if (opts.abort) throw new SpoolError('--takeover moves work to build; it stops nothing', 'spool build --takeover');
  if (opts.leave) throw new SpoolError('--takeover and --leave are two ways to move work to build: say one');
  if (args.length > 1) throw new SpoolError('taking over moves one thread at a time', 'spool build --takeover, then build it, then the next');
  const named = args.length ? ws.get(args[0]!, 'task') : undefined;
  const spool = named?.spool ?? (typeof opts.project === 'string' ? ws.project(opts.project) : ws.home);
  const why = whyNot(ctx, ws, spool);
  if (why) throw new SpoolError(why.why, why.hint);
  const all = reasonable(ws, spool);
  // Only within the sizes of the agent that takes over: the rest is left for one that takes them.
  const sized = withinSizes(ctx, spool.root, call.actor, all);
  // And near the end of the budget, only what fits what is left: nothing it cannot finish.
  const room = withinHeadroom(ctx, sized);
  const may = room.fits;
  if (named && all.includes(named) && !sized.includes(named)) throw new SpoolError(`${named.id} is ${(named.size ?? 'm').toUpperCase()}, outside the sizes ${call.actor} takes`, 'Take the top one it may: spool build --takeover');
  if (named && sized.includes(named) && !may.includes(named) && room.headroom) throw new SpoolError(`${named.id} is ${(named.size ?? 'm').toUpperCase()}, and the chat is ${headroomText(room.headroom)}`, 'Take one that fits what is left: spool build --takeover');
  if (named && !may.includes(named)) throw new SpoolError(notReasonable(ws, named), 'Take the top one it may: spool build --takeover');
  const task = named ?? may[0];
  if (!task && room.headroom && sized.length) throw new SpoolError(`nothing in the backlog fits what is left: ${headroomText(room.headroom)}`, 'Move nothing more. Finish and land what you are building, or hand it off: spool handoff <id> -m "<where it stopped>". Tell them once.');
  if (!task && all.length) throw new SpoolError(`nothing in the backlog is in the sizes ${call.actor} takes`, `${all.length} thread${all.length === 1 ? '' : 's'} wait for an agent that takes them. Tell them once, and watch.`);
  if (!task) {
    throw new SpoolError('nothing in the backlog the chat may take', 'Only threads a person filed, not on hold and waiting on nothing. Tell them once that Build is empty, and watch.');
  }
  const usage = underTarget(ctx);
  const passed = !named && room.passed ? room.passed : '';
  return { tasks: [task], line: `${MOVED}: ${usage.ok ? usage.against : figuresText(usageOf(ctx).target)}`, passed };
}
