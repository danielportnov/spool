/**
 * Taking over the backlog: in Chat mode, the chat that builds may fill Build itself.
 *
 * Nothing is built until the human moves it to Build. Taking over is the human saying the chat may
 * do that for them, within the usage target they set: with Build empty and the plan's usage under
 * the target, the chat moves the next thread to Build itself, with `spool build --takeover`, and
 * builds it. It keeps on until the target is reached: the chat never judges a thread not worth the
 * usage. The one other stop is a backlog with nothing left but what a pass over it marked
 * potentially irrelevant.
 *
 * It is one switch for each project, kept beside who builds it, in the user's own settings. The
 * human switches it on, on the board or by saying so in the chat (`spool takeover on`); where the
 * gate is locked only they can. Switching it off is anyone's: it only ever stops something.
 *
 * Which threads it may take is fixed here, not left to the chat: a thread in the backlog, not on
 * hold, not archived, waiting on nothing (no question, no plan's go-ahead), not one the human undid
 * or moved back from Build, and not one a pass marked potentially irrelevant (a drop or an archive
 * it proposed, or gone cold). The human's own threads first, then the agents' ideas, each in the
 * order of the backlog as the board shows it. A thread an agent filed without marking it AI
 * suggested still counts as an agent's, so it cannot jump its own idea ahead. Each move is
 * signed by the agent and says so on the thread, the brief shows each one that lands, and
 * `spool revert` takes one back like any other.
 */

import type { Call, Result } from './commands.ts';
import { type Ctx, builderOf, saveUserConfig, userConfig } from './context.ts';
import { type Item, SUGGESTED_HOLD, type Spool, SpoolError, isRun, oneLine, splitBody } from './model.ts';
import { potentiallyIrrelevant } from './manage.ts';
import { queueHistory } from './queue-journal.ts';
import { rosterOf, withinSizes } from './roster.ts';
import { age } from './render.ts';
import { blockers, docket, effort, openRun, ready, tasks } from './schedule.ts';
import type { Workspace } from './store.ts';
import { FRESH_MS, STOPS, agentOf, figuresText, headroomText, usageOf, withinHeadroom } from './usage.ts';

/** A reading older than this is not taken as the usage now: the chat reads it again first. */
export { FRESH_MS };

/** What the log line of a thread moved this way starts with: the brief finds them by it. */
export const MOVED = 'moved to build, taking over the backlog';

/** What the log of a pass over the backlog the chat ran itself, taking over, says: the brief finds them by it. */
export const TIDIED = 'a tidy of the backlog the chat ran itself, taking over';

/** A tidy the chat runs itself comes no oftener than this: once a night, near enough. */
export const TIDY_GAP_MS = 20 * 3_600_000;

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

/** The backlog as taking over sees it: what it may take, in order, and what it leaves as potentially irrelevant, with why. */
interface Backlog {
  may: Item[];
  irrelevant: { t: Item; why: string }[];
}

/** The threads in the backlog: proposed, and an agent's idea waiting on hold for a yes where there is no gate. */
function inBacklog(ws: Workspace, spool: Spool): Item[] {
  const d = docket(ws, spool);
  return [...d.proposed, ...d.suggested].sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || effort(a) - effort(b) || a.created.localeCompare(b.created));
}

function backlogOf(ws: Workspace, spool: Spool): Backlog {
  const marked = potentiallyIrrelevant(ws, spool);
  const open = inBacklog(ws, spool).filter((t) => !leftFor(ws, t));
  const may = open.filter((t) => !marked.has(t.id));
  const human = humans(ws, spool, may);
  return {
    // The human's own first, then the agents' ideas: a sort that keeps the backlog's order within each.
    may: [...may.filter((t) => human.has(t.id)), ...may.filter((t) => !human.has(t.id))],
    irrelevant: open.filter((t) => marked.has(t.id)).map((t) => ({ t, why: marked.get(t.id)! })),
  };
}

/** The threads the chat may take, the human's first, then the agents' ideas, each top of the backlog first. */
export function reasonable(ws: Workspace, spool: Spool): Item[] {
  return backlogOf(ws, spool).may;
}

/**
 * Which of these threads are the human's own: filed from what they said (a note), touched by them
 * in its log, or made by them on the board. One an agent filed is not, marked AI suggested or not.
 */
function humans(ws: Workspace, spool: Spool, all: Item[]): Set<string> {
  const out = new Set<string>();
  const unsure: string[] = [];
  for (const t of all) {
    if (t.suggested) continue;
    if (t.from.some((id) => ws.find(id)?.kind === 'note') || splitBody(t.body).log.some((l) => /^- \S+ \S+ human: /.test(l))) out.add(t.id);
    else unsure.push(t.id);
  }
  // Who made the rest, where the queue's own record still has it.
  if (unsure.length) for (const e of queueHistory(spool, unsure)) if (e.before === null && e.actor === 'human') out.add(e.target);
  return out;
}

/** Why taking over leaves a thread that is in the backlog, whatever a pass marked it; null where nothing does. */
function leftFor(ws: Workspace, t: Item): string | null {
  if (t.archived) return `${t.id} is archived`;
  // An agent's idea waits on hold for a yes where there is no gate: that hold is not the human's not yet.
  if (t.hold && !(t.suggested && t.hold === SUGGESTED_HOLD)) return `${t.id} is on hold: ${t.hold}`;
  if (isRun(t)) return `${t.id} is a pass over the backlog`;
  const waits = blockers(ws, t);
  if (waits.length) return `${t.id} waits on ${waits.map((w) => w.id).join(', ')}`;
  return notNow(t);
}

/** Whether the human undid this thread, or moved it back from Build, and has not moved it to Build since: it waits for them, not for the chat. */
function notNow(t: Item): string | null {
  const log = splitBody(t.body).log;
  const at = (re: RegExp): number => log.findLastIndex((l) => re.test(l.replace(/^- \S+ \S+ [^:]+: /, '')));
  const moved = at(/^moved to build/);
  if (at(/^reverted \d+ commit/) > moved) return `${t.id} was undone: it waits for the human to move it to Build`;
  if (at(/moved back to proposed/) > moved) return `${t.id} was moved back from Build: it waits for the human to move it there again`;
  return null;
}

/** Why a thread is not one the chat may take. */
function notReasonable(ws: Workspace, spool: Spool, t: Item): string {
  if (!inBacklog(ws, spool).includes(t)) return `${t.id} is not in the backlog`;
  const left = leftFor(ws, t);
  if (left) return left;
  const marked = potentiallyIrrelevant(ws, spool).get(t.id);
  if (marked) return `${t.id} is marked potentially irrelevant: ${marked}. It waits for the human's word`;
  return `${t.id} is not one the chat may take`;
}

/** The line that says every thread left is marked potentially irrelevant, naming them. */
function allIrrelevant(left: Backlog['irrelevant']): string {
  const named = left.slice(0, 5).map((x) => `${x.t.id} (${x.why})`).join(', ');
  return `every thread left in the backlog is marked potentially irrelevant: ${named}${left.length > 5 ? `, and ${left.length - 5} more` : ''}`;
}

/** The agent's usage now against its own target, "weekly 40% of 80%", or why it does not let it move a thread. */
function underTarget(ctx: Ctx, agent: string): { ok: true; against: string } | { ok: false; why: string; hint: string } {
  const { target, own, read, reached, cannotRead } = usageOf(ctx, agent);
  const set = STOPS.filter((l) => target[l] !== undefined);
  if (!set.length) return { ok: false, why: 'no usage target is set, and taking over works up to one', hint: `The human sets one, on the board or: spool target --weekly 80, or spool target --agent ${agent} --weekly 80` };
  if (cannotRead && read && ctx.now().getTime() - Date.parse(read.at) <= FRESH_MS) {
    return { ok: false, why: `${agent} cannot read its usage, so it cannot be held to its target`, hint: 'Taking over works up to a target: build only what they move to Build.' };
  }
  const report = 'Read it with your harness\'s tool and report it first: spool usage --weekly <n> --five-hour <n>';
  if (!read || ctx.now().getTime() - Date.parse(read.at) > FRESH_MS) return { ok: false, why: 'the usage has not been read in the last 30 minutes', hint: report };
  const unread = set.filter((l) => read.used[l] === undefined);
  if (unread.length) return { ok: false, why: `the ${unread.map((l) => NAMES[l]).join(' and ')} usage was not read, so its target cannot be checked`, hint: report };
  const against = set.map((l) => `${NAMES[l]} ${read.used[l]}% of ${target[l]}%`).join(', ');
  if (reached.length) return { ok: false, why: `${Object.keys(own).length ? `${agent}'s` : 'the'} usage target is reached, ${against}`, hint: 'Move nothing more. Let what is building land, and tell them once.' };
  return { ok: true, against };
}

/** Why this agent may not move a thread to build in this project now, or null where it may. */
function whyNot(ctx: Ctx, ws: Workspace, spool: Spool, agent: string): { why: string; hint: string } | null {
  if (!takeOverOf(ctx, spool.root)) {
    return { why: `taking over the backlog is off in ${spool.name}`, hint: 'Only the human moves work to build. They switch taking over on, on the board or: spool takeover on' };
  }
  if (builderOf(ctx, spool.root) !== 'chat') return { why: `${spool.name} is built headless: taking over is for a chat in Chat mode`, hint: 'spool builder chat, on their word' };
  const usage = underTarget(ctx, agent);
  if (!usage.ok) return usage;
  const waiting = ready(ws, spool).filter((t) => !isRun(t));
  if (waiting.length) return { why: `Build has work waiting: ${waiting[0]!.id} ${oneLine(waiting[0]!.title, 60)}`, hint: 'Build what is there first. Take from the backlog only when Build is empty.' };
  return null;
}

/**
 * Whether the chat, taking over, runs a pass over the backlog itself now: the same pass as a press of
 * Clean Up, by the manager's rules. Only with Build empty, no pass open, the last pass at least
 * TIDY_GAP_MS ago, and something changed since it. With `agent`, its usage under the target too.
 * Not due: why, and where it is a matter of time, when it is.
 */
export function tidyDue(ctx: Ctx, ws: Workspace, spool: Spool, agent?: string): { due: true } | { due: false; why: string; at?: string } {
  if (!takeOverOf(ctx, spool.root)) return { due: false, why: `taking over the backlog is off in ${spool.name}` };
  if (builderOf(ctx, spool.root) !== 'chat') return { due: false, why: `${spool.name} is built headless: taking over is for a chat in Chat mode` };
  const open = openRun(ws, spool);
  if (open) return { due: false, why: `a pass is open already: ${open.id}` };
  if (ready(ws, spool).some((t) => !isRun(t))) return { due: false, why: 'Build has work waiting: the tidy comes when Build is empty' };
  const all = tasks(ws, spool);
  const last = all.filter(isRun).sort((a, b) => b.updated.localeCompare(a.updated))[0];
  if (last) {
    const after = Date.parse(last.updated) + TIDY_GAP_MS;
    if (ctx.now().getTime() < after) {
      const at = new Date(after).toISOString();
      return { due: false, why: `the last pass, ${last.id}, was ${age(last.updated, ctx.now())} ago: one a night at most`, at };
    }
    if (!all.some((t) => !isRun(t) && t.updated > last.updated)) return { due: false, why: `nothing changed since the last pass, ${last.id}` };
  }
  if (agent) {
    const usage = underTarget(ctx, agent);
    if (!usage.ok) return { due: false, why: usage.why };
  }
  return { due: true };
}

/** The line that tells the chat a tidy is due, and how to run it. */
export function tidyLine(name: string): string {
  return `tidy: ${name} — taking over, a tidy of the backlog is due. Run the pass by spool prime manager: spool manage --start --takeover`;
}

/** Where taking over stands in a project, for the board and the command. */
export interface TakeOver {
  on: boolean;
  /** The thread it would move next, where it may move one. */
  next: { id: string; title: string } | null;
  /** Why it moves nothing now, where it is on and does not. */
  waiting: string | null;
  /** When the chat next tidies the backlog itself: "now", a time, or why not; null where it is off. */
  tidy: { due: boolean; why: string | null; at: string | null } | null;
}

export function takeOverState(ctx: Ctx, ws: Workspace, spool: Spool): TakeOver {
  const on = takeOverOf(ctx, spool.root);
  if (!on) return { on, next: null, waiting: null, tidy: null };
  const backlog = backlogOf(ws, spool);
  const top = backlog.may[0];
  const next = top ? { id: top.id, title: top.title } : null;
  // Each agent on the roster against its own target: it waits only where none of them may move one.
  const whys = rosterOf(ctx, spool.root).map((e) => ({ name: e.name, why: whyNot(ctx, ws, spool, e.name)?.why ?? null }));
  const free = whys.some((w) => w.why === null);
  const said = [...new Set(whys.map((w) => w.why))];
  const why = free ? null : said.length === 1 ? said[0]! : whys.map((w) => `${w.name}: ${w.why}`).join('; ');
  const due = tidyDue(ctx, ws, spool);
  const tidy = due.due ? { due: true, why: null, at: null } : { due: false, why: due.why, at: due.at ?? null };
  return { on, next, waiting: why ?? (top ? null : backlog.irrelevant.length ? allIrrelevant(backlog.irrelevant) : 'nothing in the backlog it may take'), tidy };
}

/** When the next tidy comes, in a few words. */
function tidyWhen(tidy: TakeOver['tidy'], now: Date): string {
  if (!tidy) return 'never, taking over is off';
  if (tidy.due) return 'due now: spool manage --start --takeover';
  if (tidy.at) return `after ${tidy.at.slice(0, 16).replace('T', ' ')} UTC, in ${age(now.toISOString(), new Date(tidy.at))}, once something changes`;
  return `not yet: ${tidy.why}`;
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
        `The chat takes over ${spool.name}'s backlog: with Build empty, it moves the next thread to Build itself and builds it, yours first, then the AI suggested ones, until the usage target is reached.`,
        '  Never one on hold, one you undid or moved back, one waiting on a question or a plan\'s go-ahead, or one a tidy proposed to drop or archive or found gone cold. Each says so on its thread, and spool revert takes one back.',
        state.waiting ? `  Not now: ${state.waiting}.` : state.next ? `  Next: ${state.next.id} ${oneLine(state.next.title, 70)}` : '',
        '  With Build empty it tidies the backlog too, once a night at most: it sizes and orders threads, and proposes what to drop or archive.',
        `  Next tidy: ${tidyWhen(state.tidy, ctx.now())}`,
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
  const agent = agentOf(call.actor);
  const why = whyNot(ctx, ws, spool, agent);
  if (why) throw new SpoolError(why.why, why.hint);
  const backlog = backlogOf(ws, spool);
  const all = backlog.may;
  // Only within the sizes of the agent that takes over: the rest is left for one that takes them.
  const sized = withinSizes(ctx, spool.root, call.actor, all);
  // And near the end of the budget, only what fits what is left: nothing it cannot finish.
  const room = withinHeadroom(ctx, sized, agent);
  const may = room.fits;
  if (named && all.includes(named) && !sized.includes(named)) throw new SpoolError(`${named.id} is ${(named.size ?? 'm').toUpperCase()}, outside the sizes ${call.actor} takes`, 'Take the top one it may: spool build --takeover');
  if (named && sized.includes(named) && !may.includes(named) && room.headroom) throw new SpoolError(`${named.id} is ${(named.size ?? 'm').toUpperCase()}, and the chat is ${headroomText(room.headroom)}`, 'Take one that fits what is left: spool build --takeover');
  if (named && !may.includes(named)) throw new SpoolError(notReasonable(ws, spool, named), 'Take the top one it may: spool build --takeover');
  // An agent's idea waits behind the human's own: naming it does not jump it ahead.
  const human = named ? humans(ws, spool, [named, may[0]!]) : new Set<string>();
  if (named && named !== may[0] && !human.has(named.id) && human.has(may[0]!.id)) {
    throw new SpoolError(`${named.id} is an agent's idea, and the human's own ${may[0]!.id} comes first`, 'Take the top one it may: spool build --takeover');
  }
  const task = named ?? may[0];
  // Nothing to take: a tidy of the backlog may be due instead, and the refusal says so.
  const tidy = !task && tidyDue(ctx, ws, spool, agent).due ? ' A tidy of the backlog is due first: run the pass by spool prime manager, spool manage --start --takeover.' : '';
  if (!task && room.headroom && sized.length) throw new SpoolError(`nothing in the backlog fits what is left: ${headroomText(room.headroom)}`, 'Move nothing more. Finish and land what you are building, or hand it off: spool handoff <id> -m "<where it stopped>". Tell them once.');
  if (!task && all.length) throw new SpoolError(`nothing in the backlog is in the sizes ${call.actor} takes`, `${all.length} thread${all.length === 1 ? '' : 's'} wait for an agent that takes them. Tell them once, and watch.${tidy}`);
  // Everything left is marked potentially irrelevant: the one stop short of the usage target.
  if (!task && backlog.irrelevant.length) {
    throw new SpoolError(allIrrelevant(backlog.irrelevant), `Stop: each waits for their word on the tidy. Tell them once, in a line, and watch.${tidy}`);
  }
  if (!task) {
    throw new SpoolError('nothing in the backlog the chat may take', `Only threads not on hold, not undone or moved back, and waiting on nothing. Tell them once that Build is empty, and watch.${tidy}`);
  }
  const usage = underTarget(ctx, agent);
  const passed = !named && room.passed ? room.passed : '';
  return { tasks: [task], line: `${MOVED}: ${usage.ok ? usage.against : figuresText(usageOf(ctx, agent).target)}`, passed };
}
