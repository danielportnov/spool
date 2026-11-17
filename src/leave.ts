/**
 * A leave: how far agents may go while the user is away, and until when.
 *
 * "Work through whatever still seems relevant, I'll check in the morning" is a leave. Said in a
 * chat it is a sentence an agent remembers, or stretches. Given with `spool leave` it is a
 * record: `.spool/leave.json` holds their words, who gave it, when, until when, and what it
 * allows. With none, agents only tidy: nothing is moved to build but by the user.
 *
 * What a leave can allow, each asked for by name:
 *
 *   --build <n>       an agent may move up to n threads to build: `spool build <id> --leave`
 *   --drop-shipped    an agent may drop what has shipped, with the commit as the reason:
 *                     `spool drop <id> --leave -m "Shipped in <sha>: …"`
 *   --proposals <n>   a run may file up to n new ideas, where it would file five
 *
 * It ends at `--until`, which is 8 the next morning unless said and never more than 24 hours
 * away; sooner with `spool leave --end`; and when a run that ran under it is undone. An expired
 * one is removed by the first command that finds it. Nothing renews a leave or stretches one:
 * a leave that outlives the night is a gate left open.
 *
 * Giving one is the user's, like `spool build`: where the gate is locked an agent is refused.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Call, Result } from './commands.ts';
import { repoRoot, resolveCommit } from './git.ts';
import { type Item, type Spool, SpoolError, addLog, isClosed, timestamp } from './model.ts';
import { age } from './render.ts';
import { openRun } from './schedule.ts';
import type { Workspace } from './store.ts';
import { runDir } from './stream.ts';

const FILE = 'leave.json';
const DAY = 86_400_000;
/** With no time said, a leave runs to this hour the next morning. */
const MORNING = 8;

export interface Leave {
  /** What the user said, as they said it. */
  words: string;
  by: string;
  given: string;
  until: string;
  allows: { build?: number; dropShipped?: boolean; proposals?: number };
  /** What has been done under it. */
  used: { build: number; dropped: number };
  /** The runs that ran under it. Undoing one of them ends the leave. */
  runs: string[];
}

function fileOf(spool: Spool): string {
  return path.join(spool.dir, FILE);
}

/** The leave on file, or nothing where there is none or the file is not one a command wrote: never longer than a day. */
function read(file: string): Leave | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Leave> | null;
    if (!parsed || typeof parsed.words !== 'string' || typeof parsed.until !== 'string' || typeof parsed.given !== 'string') return undefined;
    const span = Date.parse(parsed.until) - Date.parse(parsed.given);
    if (!(span > 0 && span <= DAY)) return undefined;
    return {
      words: parsed.words,
      by: typeof parsed.by === 'string' ? parsed.by : 'human',
      given: parsed.given,
      until: parsed.until,
      allows: parsed.allows ?? {},
      used: { build: parsed.used?.build ?? 0, dropped: parsed.used?.dropped ?? 0 },
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return undefined;
  }
}

function write(spool: Spool, leave: Leave): void {
  const file = fileOf(spool);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(leave, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** A time of day as a clock shows it, where the user is. */
function clock(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** What a leave allows, in a line. */
export function allowed(leave: Leave): string {
  const a = leave.allows;
  return (
    [
      a.build ? `build up to ${a.build}` : '',
      a.dropShipped ? 'drop what has shipped' : '',
      a.proposals ? `file up to ${a.proposals} new ideas` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'tidy only'
  );
}

/** A live leave in a line: their words, until when, and what it allows. */
export function leaveLine(leave: Leave, now: Date): string {
  const left = age(now.toISOString(), new Date(leave.until));
  return `"${leave.words}", until ${clock(leave.until)} (${left === 'now' ? 'a moment more' : `${left} more`}): ${allowed(leave)}`;
}

/**
 * The leave that is live in a project. One that has run out is removed here, by whichever command
 * finds it first, with a line on the open run's thread so the night's record says when it ended.
 */
export function settle(ws: Workspace, spool: Spool): { live?: Leave; expired?: Leave } {
  const leave = read(fileOf(spool));
  if (!leave) return {};
  if (ws.now().getTime() < Date.parse(leave.until)) return { live: leave };
  fs.rmSync(fileOf(spool), { force: true });
  const run = openRun(ws, spool);
  if (run) {
    addLog(run, 'spool', `the leave ran out at ${clock(leave.until)}: "${leave.words}"`, ws.now());
    ws.save(run);
  }
  return { expired: leave };
}

/** Tie a run to the leave it runs under: undoing the run ends the leave, and the run's report names it. */
export function runUnder(ws: Workspace, run: Item, leave: Leave, actor: string): void {
  if (!leave.runs.includes(run.id)) {
    leave.runs.push(run.id);
    write(run.spool, leave);
  }
  fs.writeFileSync(path.join(runDir(run.spool.dir, run.id), FILE), `${JSON.stringify(leave, null, 2)}\n`);
  addLog(run, actor, `under the leave ${leaveLine(leave, ws.now())}`, ws.now());
  ws.save(run);
}

/** The leave a run ran under, as it stood when the run met it. It outlives the leave itself. */
export function leaveOfRun(run: Item): Leave | undefined {
  return read(path.join(run.spool.dir, 'runs', run.id, FILE));
}

/** End the live leave a run ran under, as undoing that run does. A leave of another night is left alone. */
export function endLeaveOf(ws: Workspace, run: Item): Leave | undefined {
  const { live } = settle(ws, run.spool);
  if (!live?.runs.includes(run.id)) return undefined;
  fs.rmSync(fileOf(run.spool), { force: true });
  return live;
}

/**
 * When a leave ends, from how the user said it: "midnight", "8am", "23:30", "3h", or a date and
 * time. A time of day is the next time the clock shows it. With nothing said, 8 the next morning.
 */
export function untilOf(said: string | undefined, now: Date): Date {
  const text = (said ?? `${MORNING}:00`).trim().toLowerCase();
  const span = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(text);
  if (span) return new Date(now.getTime() + Number(span[1]) * (span[2]!.startsWith('m') ? 60_000 : 3_600_000));
  const named: Record<string, string> = { midnight: '0:00', noon: '12:00', morning: `${MORNING}:00`, 'the morning': `${MORNING}:00` };
  const time = /^(\d{1,2})(?::(\d\d))?\s*(am|pm)?$/.exec(named[text] ?? text);
  if (time) {
    let hour = Number(time[1]);
    const minute = Number(time[2] ?? 0);
    if (time[3]) {
      if (hour < 1 || hour > 12) throw notATime(said!);
      hour = (hour % 12) + (time[3] === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) throw notATime(said!);
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  const at = Date.parse(said!.trim());
  if (Number.isFinite(at)) return new Date(at);
  throw notATime(said!);
}

function notATime(said: string): SpoolError {
  return new SpoolError(`"${said}" is not a time for a leave to end`, 'Say when: --until midnight, --until 8am, --until 23:30, or --until 3h for three hours from now');
}

function count(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SpoolError(`${flag} must be a whole number above zero`);
  return n;
}

const NONE = 'No leave is live: agents tidy only, and nothing is built unless you move it.';

/** `spool leave`: give one, end it, or say what is live. `byHuman` refuses an agent where the gate is locked. */
export function leaveCommand(call: Call, spool: Spool, byHuman: () => void): Result {
  const { ws, args, opts, actor } = call;
  const now = ws.now();
  const { live, expired } = settle(ws, spool);
  const ranOut = expired ? `The leave ran out at ${clock(expired.until)}: "${expired.words}"\n` : '';
  const giving = args.length || opts.until !== undefined || opts.build !== undefined || opts.proposals !== undefined || opts['drop-shipped'];

  if (opts.end) {
    if (giving) throw new SpoolError('--end ends a leave; it gives none', 'spool leave --end');
    if (!live) return { text: `${ranOut}No leave is live.`, data: { ended: null } };
    fs.rmSync(fileOf(spool), { force: true });
    const run = openRun(ws, spool);
    if (run) {
      addLog(run, actor, `the leave was ended: "${live.words}"`, now);
      ws.save(run);
    }
    return { text: `The leave is ended: "${live.words}"\n  Agents tidy only again, and nothing is built unless you move it.`, data: { ended: live } };
  }

  if (!giving) {
    if (!live) return { text: `${ranOut}${NONE}`, data: { leave: null } };
    const used = [
      live.allows.build ? `${live.used.build} of ${live.allows.build} builds used` : '',
      live.allows.dropShipped ? `${live.used.dropped} dropped as shipped` : '',
    ].filter(Boolean);
    return {
      text: [`A leave is live: ${leaveLine(live, now)}`, `  given by ${live.by} at ${clock(live.given)}${used.length ? ` · ${used.join(' · ')}` : ''}`, '  end it sooner   spool leave --end'].join('\n'),
      data: { leave: live },
    };
  }

  // Giving a leave opens the gate a little: where the gate is locked, that takes the user.
  byHuman();
  const words = args.join(' ').replace(/\s+/g, ' ').trim();
  if (!words) throw new SpoolError('what the user said is missing', 'A leave is kept in their words: spool leave "work through the backlog, I will look in the morning" --until 8am');
  if (live) {
    throw new SpoolError(`a leave is live already, until ${clock(live.until)}: "${live.words}"`, 'Nothing renews a leave or stretches one. End it first: spool leave --end');
  }
  const until = untilOf(typeof opts.until === 'string' ? opts.until : undefined, now);
  if (until.getTime() <= now.getTime()) throw new SpoolError(`${String(opts.until)} has passed`, 'Say a time still to come: --until midnight, --until 8am, --until 3h');
  if (until.getTime() - now.getTime() > DAY) {
    throw new SpoolError('a leave lasts 24 hours at most', 'A leave that outlives the night is a gate left open. Give another tomorrow.');
  }
  const build = count(opts.build, '--build');
  const proposals = count(opts.proposals, '--proposals');
  const leave: Leave = {
    words,
    by: actor,
    given: timestamp(now),
    until: timestamp(until),
    allows: { ...(build ? { build } : {}), ...(opts['drop-shipped'] ? { dropShipped: true } : {}), ...(proposals ? { proposals } : {}) },
    used: { build: 0, dropped: 0 },
    runs: [],
  };
  write(spool, leave);
  // Given while a run is open, it is that run's leave: the run's thread says so, and undoing the run ends it.
  const run = openRun(ws, spool);
  if (run) runUnder(ws, run, leave, actor);
  return {
    text: [
      `A leave is live: ${leaveLine(leave, now)}`,
      Object.keys(leave.allows).length ? '' : '  Nothing is built under it, and nothing you filed is dropped: say --build <n> or --drop-shipped for more.',
      '  It ends by itself then, and nothing renews it. Sooner: spool leave --end',
    ]
      .filter(Boolean)
      .join('\n'),
    data: { leave },
  };
}

/** Why a command asked to act under a leave is refused: there is none, it ran out, or it does not allow this. */
function refuse(found: { live?: Leave; expired?: Leave }, what: 'build' | 'drop'): Leave {
  const give = `spool leave "<their words>" --until <time> ${what === 'build' ? '--build <n>' : '--drop-shipped'}`;
  if (found.expired) {
    throw new SpoolError(`the leave ran out at ${clock(found.expired.until)}: "${found.expired.words}"`, `Nothing renews a leave. Only the user gives another: ${give}`);
  }
  const leave = found.live;
  if (!leave) {
    throw new SpoolError(
      'no leave is live',
      `Without one, ${what === 'build' ? 'only the user moves work to build' : 'propose the drop in your report'}. They give a leave with: ${give}`,
    );
  }
  if (what === 'build' ? !leave.allows.build : !leave.allows.dropShipped) {
    throw new SpoolError(
      `the leave does not allow ${what === 'build' ? 'building' : 'dropping'}: "${leave.words}"`,
      `It allows this much: ${allowed(leave)}. Propose the ${what} in your report instead.`,
    );
  }
  return leave;
}

/** A move under a leave is the agent's own doing, so unless a person is at the keys it is not signed as the user's. */
export function signer(call: Call): string {
  return call.actor === 'human' && !call.ctx.tty && !call.ctx.human ? 'agent' : call.actor;
}

/**
 * `spool build --leave`: check that a live leave allows these threads to be moved to build, each
 * in its own project. Nothing is counted yet: `moved` counts one use as a thread is moved, and
 * gives the line for its log.
 */
export function buildUnderLeave(call: Call, tasks: Item[]): { actor: string; moved: (task: Item) => string } {
  const { ws } = call;
  if (call.opts.abort) throw new SpoolError('--leave moves work to build; it stops nothing', 'spool build <t-id> --leave');
  for (const spool of new Set(tasks.map((t) => t.spool))) {
    const leave = refuse(settle(ws, spool), 'build');
    const mine = tasks.filter((t) => t.spool === spool);
    // A leave starts what is waiting for a yes. What the user parked or put away stays where they put it.
    for (const t of mine) {
      if (t.hold) throw new SpoolError(`${t.id} is on hold: ${t.hold}`, `A leave does not lift a hold. Only the user releases it: spool release ${t.id}`);
      if (t.archived) throw new SpoolError(`${t.id} is archived`, `A leave does not bring it back. Only the user does: spool archive --undo ${t.id}`);
    }
    const wanted = mine.filter((t) => t.status === 'proposed').length;
    const left = leave.allows.build! - leave.used.build;
    if (wanted > left) {
      throw new SpoolError(
        left > 0 ? `the leave allows ${left} more to be built, not ${wanted}: "${leave.words}"` : `the leave's ${leave.allows.build === 1 ? 'one build is' : `${leave.allows.build} builds are`} used up: "${leave.words}"`,
        'Leave the rest proposed and say so in your report. Nothing renews a leave: only the user gives another.',
      );
    }
  }
  return {
    actor: signer(call),
    moved(task) {
      const leave = read(fileOf(task.spool))!;
      leave.used.build++;
      write(task.spool, leave);
      return `moved to build under the leave: ${leave.words}`;
    },
  };
}

/**
 * `spool drop --leave`: check that a live leave allows dropping what has shipped, and that the
 * reason names a commit that is there. `dropped` counts each thread as it goes.
 */
export function dropUnderLeave(call: Call, items: Item[]): { why: string; dropped: (item: Item) => void } {
  const { ws } = call;
  const usage = `spool drop ${items[0]?.id ?? '<t-id>'} --leave -m "Shipped in <sha>: <what makes its Done-when true>"`;
  const why = typeof call.opts.message === 'string' ? call.opts.message.replace(/\s+/g, ' ').trim() : '';
  let words = '';
  for (const spool of new Set(items.map((i) => i.spool))) {
    const leave = refuse(settle(ws, spool), 'drop');
    words = leave.words;
    for (const item of items.filter((i) => i.spool === spool)) {
      if (item.kind !== 'task') throw new SpoolError(`${item.id} is a ${item.kind}: a leave drops threads that have shipped, and nothing else`);
      if (isClosed(item)) throw new SpoolError(`${item.id} is already ${item.status}`);
      if (item.status === 'active') throw new SpoolError(`${item.id} is being built by ${item.by ?? 'someone'}`, 'What is being built has not shipped');
    }
    // Shipped means a commit: one the reason names, and that is in this project's history.
    const root = repoRoot(spool.root);
    if (!root) throw new SpoolError(`${spool.name} is not a git repository, so nothing there can be shown to have shipped`);
    const named = why.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
    if (!named.length) throw new SpoolError('the reason must name the commit that shipped it', usage);
    if (!named.some((sha) => resolveCommit(root, sha))) throw new SpoolError(`no commit "${named[0]}" in ${root}`, usage);
  }
  return {
    why: `${why} (under the leave: ${words})`,
    dropped(item) {
      const leave = read(fileOf(item.spool))!;
      leave.used.dropped++;
      write(item.spool, leave);
    },
  };
}
