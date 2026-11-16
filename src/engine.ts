/**
 * The engine: what builds the threads in Build.
 *
 * The `Runner` takes the next thread that can be built, gives it a folder to be built in (a git
 * worktree of its own, where the project can have one), starts an agent on it through
 * `session.ts`, and settles the thread when the agent has gone: done, waiting on the human, or
 * back in Build. It stops an agent, undoes what one changed, and puts back what a page that died
 * left handed out. As many threads at once as the user's config says.
 *
 * A thread a run left unfinished (stopped, given up, or cut off with its page) is not started from
 * nothing the next time: where its agent is `claude -p`, the run was in a session Spool chose, and
 * the next run picks that session up, told only what has changed since (`leftOff`, `carryOn`).
 * Such a session can also be spoken to while it works: a note the human writes on a thread being
 * built is said to its agent within a second (`attend`), and Stop asks it to stop before ending it.
 * And a tool call it needs a yes for comes here as a question (`asked`): held for the human where
 * one is looking, to answer with `permit`, and refused at once where nobody is. A thread a page
 * that died left handed out is carried on the same way when the next page starts (`recover`).
 *
 * There is no HTTP here, and nothing about requests: the page's server (`server.ts`) holds a
 * Runner and reads its fields, and anything else that builds can hold one the same way.
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act } from './act.ts';
import { type Pick as Picked, type Routing, commandFor, pickFor, stepNote, takesPick } from './agent.ts';
import { type Builder, type Ctx, builderOf, notify, parallelOf, saveBuilder, userConfig } from './context.ts';
import { dirtyPaths, discardPaths, repoRoot } from './git.ts';
import { DEFAULT_AGENT, PREAMBLE } from './loop.ts';
import { type Item, type SpoolError, addLog, oneLine, splitBody, timestamp } from './model.ts';
import { prime } from './prime.ts';
import { brief, paint } from './render.ts';
import { runOf } from './run.ts';
import { ready, tasks } from './schedule.ts';
import { type Session, endAgent, endLeftover, pageRunning, promptFile, recall, remember, startSession } from './session.ts';
import { atOnceIn, sharedFolderWhy } from './slots.ts';
import { Workspace, isOff } from './store.ts';
import { type Ask, SESSION_ID, asking, inSession, keeps, listening, listens, sessionOf, streaming } from './stream.ts';
import { closeWorktree, openWorktree, workDir } from './worktree.ts';

/** Whether the last claim on a thread was a page handing it to an agent, not someone starting it. */
function handedByPage(task: Item): boolean {
  const claims = splitBody(task.body).log.filter((line) => /^- \S+ \S+ (page: handed to |[^:]+: (started|picked up after))/.test(line));
  return / page: handed to /.test(claims.at(-1) ?? '');
}

/** A log line that says how a thread came to wait in Build, or that someone took it from there. */
const STANDS = /^(moved to build|released from hold|reverted |started$|picked up after |handed to |agent .* without finishing|.*; back in build$)/;
/** The human stopping a thread that was being built: Stop on the page, or the thread moved back to Build. */
const STOP = /^stopped (from the page|while .* was building it); back in build$/;

/**
 * Whether the human stopped this thread while it was being built, and has not set it going
 * since. The page's runner leaves such a thread in Build until they carry on with it. It is read
 * from the thread's own log, so it holds on every page and across a restart: of the lines that
 * say how the thread came to wait in Build, the last is a stop. A note or an edit since changes
 * nothing; moving it, or an agent taking it, does.
 */
export function stoppedInBuild(task: Item): boolean {
  if (task.status !== 'open') return false;
  const said = splitBody(task.body).log.map((line) => /^- \S+ \S+ .+?: (.*)$/.exec(line)?.[1] ?? '');
  return STOP.test(said.filter((what) => STANDS.test(what)).at(-1) ?? '');
}

/**
 * What an agent whose session can be spoken to is told first. It is `PREAMBLE` with one thing
 * changed: the human can reach it while it works, though they may still not be reading what it says.
 */
const PREAMBLE_HEARD = `You are working one task from a Spool queue. The human may write to you while you
work: what they say arrives as a message, so read it and adjust. They may not be
reading what you say in chat, so a question still goes through \`spool ask\`, and a
call you make yourself through \`spool assume\`. The task below is already claimed
for you. Finish it with \`spool done\`, or leave it waiting on a question, then stop.
`;

/** How long a session that ended its turn with its thread unfinished is kept for the human's next word, after their last. */
const REPLY_WINDOW_MS = 5 * 60_000;

/** A face that asked for the board this recently has someone looking at it. */
const LOOKING_MS = 30_000;
/** How long an agent's question waits for the human where someone is looking, before it is refused. */
const ASK_WAIT_MS = 10 * 60_000;

/** What an agent is told with a no that nobody gave: how to go on without the call. */
const GO_ON = 'Do not look for another way to do the same thing. If the thread cannot be finished without it, say what you need with `spool ask`, and stop.';

/** How a page's run of a thread ended with the thread put back in Build: by the line that put it back. */
type Left = 'stopped' | 'unfinished' | 'cut off';
const LEFT: [RegExp, Left][] = [
  [STOP, 'stopped'],
  [/^agent .* without finishing; back in build$/, 'unfinished'],
  [/^(the page was stopped|its page had stopped with nobody working it); back in build$/, 'cut off'],
];

/**
 * The session to carry a thread on in, and how the run in it ended. There is one where the last
 * thing to happen to the thread was a page's run of it ending unfinished, and that run was in a
 * Claude session. A thread moved, undone or taken by someone else since starts afresh: what that
 * session remembers of it may no longer be so.
 */
export function leftOff(task: Item): { session: string; how: Left } | undefined {
  const { log } = splitBody(task.body);
  const said = log.map((line) => /^- \S+ \S+ .+?: (.*)$/.exec(line)?.[1] ?? '');
  const last = said.filter((what) => STANDS.test(what)).at(-1) ?? '';
  const how = LEFT.find(([ended]) => ended.test(last))?.[1];
  const session = sessionRan(log);
  return how && session ? { session, how } : undefined;
}

/**
 * The Claude session a thread's last run by a page was in, or nothing: as its agent said it, or,
 * where the run was cut short before the agent said anything, as the hand-off put it.
 */
function sessionRan(log: string[]): string {
  const ran = runOf(log);
  if (!ran) return '';
  const handed = log.map((line) => /^- \S+ \S+ .+?: handed to `(.*)`$/.exec(line)?.[1]).findLast(Boolean) ?? '';
  const session = ran.session || sessionOf(handed)?.id || '';
  return SESSION_ID.test(session) ? session : '';
}

/** The model and effort a thread's last run was started with: picked up again, it runs as it ran. */
function asItRan(task: Item): Picked {
  const ran = runOf(splitBody(task.body).log);
  return { model: ran?.model, effort: ran?.effort as Picked['effort'] };
}

/**
 * What a session picked up again is told. It has the rules and the brief already, so it is given
 * only what has changed since it left off: how it came to stop, and what the human has written
 * on the thread that it has not been given.
 */
function carryOn(task: Item, how: Left, notes: Item[], heard: boolean): string {
  const why = {
    stopped: 'The human stopped you, and has now set you going again.',
    unfinished: 'Your last run ended with the thread neither finished nor waiting on a question.',
    'cut off': 'Spool was stopped while you were working, and is back.',
  }[how];
  const said = notes.map((note) => splitBody(note.body).main.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'));
  return `${[
    `You were working this thread of a Spool queue earlier in this session, and it is yours again: ${task.id} ${task.title}`,
    why,
    said.length ? `Since you were last given the thread, the human has written on it:\n\n${said.join('\n\n')}` : '',
    heard ? 'The human may write to you while you work: what they say arrives as a message, so read it and adjust.' : '',
    `Carry on from where you were. \`spool show ${task.id}\` gives the thread as it stands now. The rules have not changed: finish it with \`spool done\`, or leave it waiting on a question with \`spool ask\`, then stop.`,
  ]
    .filter(Boolean)
    .join('\n\n')}\n`;
}

/** What an agent is started with: the words it is given, and the command that is run. */
interface Start {
  prompt: string;
  command: string;
}

/**
 * The folder a run's agent works in: the thread's own worktree, where `handOut` gave it one, or the
 * project's folder where it could not have one. Two agents never share the project's folder: see
 * `handOut`.
 */
function runFolder(task: Item): string {
  return workDir(task);
}

/** How a thread's log says, once, that it is built in the project's own folder and not in a worktree. */
const OWN_FOLDER = "built in the project's own folder, not a worktree of its own: ";

/** One agent on one thread. Everything about a run is kept here, so that several can go at once. */
interface Run {
  id: string;
  title: string;
  /** The folder its agent works in. */
  folder: string;
  /** Files already changed there, and not committed, when it began: undoing its edits leaves those alone. Null where git could not say. */
  before: Set<string> | null;
  child: ChildProcess;
  lines: string[];
  began: number;
  /** Ended from the page, and not by the agent: stopped, moved to another column, or the page itself going. */
  stopped: boolean;
  /** The thread was moved back to the backlog, so once the agent is gone, what it changed is undone. */
  undo?: boolean;
  /** Another run worked in the same folder while this one did: what is uncommitted there cannot be told apart. */
  shared?: boolean;
  /** Its worktree, by its folder from the project, and the branch it is on: none where it works in the project's own folder. */
  worktree?: { folder: string; branch: string };
  /** The human's notes on the thread that its agent has been given, by id. */
  told: string[];
  /** When the human last said something to its agent. A session that ends its turn unfinished is kept a while after for what they say next. */
  spoke?: number;
  /** Lines for the thread's log that are not on it yet. */
  unsaid?: string[];
  /** Its agent, once one is started: while a model is still being chosen for it there is none. */
  session?: Session;
  /** It picks a session up again: how to start the thread afresh instead, if that session turns out to be gone. */
  afresh?: Start;
}

/** What is settled about a run when its thread is handed out, before any program is started for it. */
type Handed = Pick<Run, 'id' | 'title' | 'folder' | 'before' | 'worktree' | 'told' | 'spoke'>;

/** What a face of Spool shows of one run: how long it has been going, what its agent is saying, and whether the agent can be spoken to. */
export interface Live {
  id: string;
  seconds: number;
  lines: string[];
  /** A note written on its thread reaches its agent while it works. False for an agent that is only watched. */
  listens: boolean;
  /** The tool call its agent needs a yes for and is waiting on, if it is waiting on one: the oldest, where there are several. */
  asking: Asking | null;
}

/** An agent's question, as a face shows it. It is answered with `permit`. */
export interface Asking {
  /** The question's id, to answer it by. */
  ask: string;
  tool: string;
  /** The call in short, as the agent's own lines show it: "Bash: npm publish --dry-run". */
  what: string;
  /** The call with nothing cut out of it, as it was written: what to read before saying yes. */
  full: string;
  /** What the agent said the call is for, where it said. */
  why: string;
  /** What a yes for the rest of this run would allow without asking again. Empty where a yes can only be for the once. */
  rest: string;
  /** When it asked, and when it is refused if nobody has answered. */
  since: string;
  until: string;
}

/** What one try at handing out a thread came to: an agent started, nothing there to hand out, or a thread that could not be started. */
type HandOut = 'started' | 'none' | 'skipped';

/** How a card learns what its model will be: the user's table by size. */
export interface Picking {
  models: Routing;
}

/**
 * The runner: with it on, the page builds what is in Build by itself. It takes
 * the next thread, starts the user's agent command on it with the rules and
 * the brief on stdin, shows what the agent prints as it works, and takes the
 * next when there is room: as many at once as `parallel` in the user's config
 * says, three unless it is set. Each is built in a git worktree of its own and
 * lands on the checkout with its own `spool done`; a project that cannot have
 * worktrees is built in its own folder, one thread at a time. A thread is
 * taken the moment it lands in Build.
 *
 * It is the same contract as `spool loop`: a thread the agent finished is
 * done, one it asked a question on waits for the human, and one it walked
 * away from is put back and not tried again until something about it changes.
 * The agent command comes from the user's machine, never from the project.
 *
 * That is building headless. The human can pick a chat to build instead, on the
 * page: a Claude Code session running the loop. Then the runner starts nothing,
 * whether it is on or not, and an agent it had already started is left to finish.
 */
export class Runner {
  on: boolean;
  readonly agent: string;
  /** The folder of the project this page shows: the human's pick of who builds is kept by it. */
  private root = '';
  /** What is being built now, by thread, in the order each was started. */
  readonly runs = new Map<string, Run>();
  /** The threads dragged into Building, in the order they were dragged: they are taken next, ahead of the rest of Build. */
  private first: string[] = [];
  /**
   * The page looking after its own code, once a tick and before anything is started. It answers
   * true while nothing new should start: Spool is being rebuilt, or the page is about to restart.
   */
  upkeep: (() => boolean) | undefined;
  /** What upkeep answered at the last tick. */
  private held = false;
  /** How many threads it has handed out. Upkeep reads it: one taken and finished between two of its looks was work all the same. */
  handedOut = 0;
  /** How long a session that ended its turn with its thread unfinished is kept for the human's next word, after their last. */
  replyWindow = REPLY_WINDOW_MS;
  /** How long an agent's question waits for the human's answer before it is refused. */
  askWait = ASK_WAIT_MS;
  /** When a face last asked what there is to show. */
  private seen = 0;
  /** How the last few threads it ran turned out, newest first. */
  recent: { id: string; title: string; outcome: string }[] = [];
  private gaveUp = new Map<string, string>();
  private timer: NodeJS.Timeout;
  private ctx: Ctx;
  private project: string | undefined;

  constructor(ctx: Ctx, project: string | undefined, agent: string | undefined, on: boolean) {
    this.ctx = ctx;
    this.project = project;
    this.agent = agent || ctx.env.SPOOL_AGENT || userConfig(ctx).agent || DEFAULT_AGENT;
    this.on = on;
    try {
      const ws = Workspace.open(ctx.cwd, ctx.now);
      try {
        this.root = (project ? ws.project(project) : ws.home).root;
      } finally {
        ws.close();
      }
    } catch {
      // No spool to read: there is nothing to build either.
    }
    this.recover();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Who builds what is in Build: read fresh, so a pick made on any page of this project shows at once. */
  get builder(): Builder {
    return this.root ? builderOf(this.ctx, this.root) : 'headless';
  }

  set builder(builder: Builder) {
    if (this.root) saveBuilder(this.ctx, this.root, builder);
  }

  /**
   * How many of this project's threads are built at once: read fresh, so a change to the user's
   * config shows at once. One where they would share the project's folder.
   */
  get parallel(): number {
    return this.root ? atOnceIn(this.ctx, this.root) : parallelOf(this.ctx);
  }

  /**
   * The page is going away. Every thread an agent of its is on goes back to Build now,
   * while the process is still here to write it: the agents end with the page,
   * so nobody would be working a thread left marked as handed out.
   */
  close(): void {
    clearInterval(this.timer);
    // Nothing more is started from here, whatever is moved to Build on the way out.
    this.held = true;
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      run.stopped = true;
      this.putBack(run.id, 'the page was stopped; back in build');
      endAgent(run.child);
      fs.rmSync(promptFile(run.id, process.pid), { force: true });
    }
  }

  /** Put a thread the page handed out back in Build, if it is still out. */
  private putBack(id: string, why: string): void {
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task?.status !== 'active') return;
        task.status = 'open';
        task.by = undefined;
        addLog(task, 'page', why, ws.now());
        ws.save(task);
      } finally {
        ws.close();
      }
    } catch {
      // The store could not be written; the next page to start finds the thread and puts it back.
    }
  }

  /**
   * A page that ended without settling (killed outright, or a version before this
   * one) leaves its thread marked as handed out with nobody on it. On start, every
   * thread whose last claim was a page's hand-off, where no page has an agent on
   * it, is seen to: a running agent's prompt file, named with its page's pid, lives as long as it does.
   *
   * With agents on, one that was in a Claude session is carried on there, in the folder it was
   * in, as far as there is room; any other is put back in Build, to be handed out like the rest.
   * Either way what is left of the agent the dead page started is ended first.
   */
  private recover(): void {
    let orphans: Item[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        orphans = tasks(ws, this.project).filter((t) => t.status === 'active' && handedByPage(t) && !pageRunning(t.id));
      } finally {
        ws.close();
      }
    } catch {
      return;
    }
    for (const task of orphans) {
      const kept = recall(task);
      if (kept) endLeftover(kept);
      // As for any hand-out: with agents on, as many as are built at once, and never where a chat builds.
      const room = this.on && builderOf(this.ctx, task.spool.root) !== 'chat' && this.runs.size < this.parallel;
      if (!room || !this.carryOnCutOff(task.id)) this.putBack(task.id, 'its page had stopped with nobody working it; back in build');
    }
  }

  /**
   * Carry on a thread that a page which died left handed out: its agent is started again in the
   * session it was in, and the thread never leaves Building. False where there is no session to
   * carry on in, or the agent command cannot pick one up, or its folder is gone.
   */
  private carryOnCutOff(id: string): boolean {
    let task: Item | undefined;
    let handed: Handed;
    let again: Start | undefined;
    const fresh: Start = { prompt: '', command: this.agent };
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        task = ws.find(id);
        if (task?.status !== 'active') return false;
        const session = sessionRan(splitBody(task.body).log);
        const folder = runFolder(task);
        // Two agents never share the project's own folder, and one whose worktree was cleared away has nowhere to carry on.
        if (!session || !fs.existsSync(folder) || [...this.runs.values()].some((run) => run.folder === folder)) return false;
        const { models } = userConfig(this.ctx);
        const notes = task.from.map((n) => ws.find(n)).filter((n): n is Item => n?.kind === 'note');
        const picked = this.pickUp(task, { session, how: 'cut off' }, notes, models);
        if (!picked) return false;
        again = picked;
        handed = {
          id: task.id,
          title: task.title,
          folder,
          before: null,
          worktree: task.worktree ? { folder: task.worktree, branch: task.branch ?? '' } : undefined,
          told: notes.map((n) => n.id),
          spoke: picked.unheard ? Date.now() : undefined,
        };
        fresh.command = this.afresh(this.command(pickFor(task, models, asItRan(task))));
        task.by = this.name();
        task.started = timestamp(ws.now());
        addLog(task, 'page', 'its page had stopped with nobody working it; carried on where it was', ws.now());
        addLog(task, 'page', `handed to \`${again.command}\``, ws.now());
        ws.save(task);
        fresh.prompt = this.opening(ws, fresh.command, brief(ws, task, paint(false)));
      } finally {
        ws.close();
      }
    } catch {
      return false;
    }
    this.handedOut++;
    this.start(task, handed, again, fresh);
    return true;
  }

  /**
   * How to pick a thread's session up again: the command that does, and what its agent is told,
   * which is only what has changed since it was last given the thread. `unheard` is how many of
   * the human's notes that is. Nothing where the agent command cannot pick a session up.
   */
  private pickUp(task: Item, left: { session: string; how: Left }, notes: Item[], models: Routing): (Start & { unheard: number }) | undefined {
    const command = inSession(this.command(pickFor(task, models, asItRan(task))), left.session, true);
    if (!command) return undefined;
    const given = recall(task);
    const told = new Set(given?.session === left.session ? given.told : []);
    const unheard = notes.filter((n) => !told.has(n.id));
    return { command, prompt: carryOn(task, left.how, unheard, listens(command)), unheard: unheard.length };
  }

  /** What an agent starting a thread from nothing is given: what it is here to do, the worker's rules, and the thread's brief. */
  private opening(ws: Workspace, command: string, briefText: string): string {
    return `${listens(command) ? PREAMBLE_HEARD : PREAMBLE}\n${prime(ws, 'worker')}\n\nYOUR TASK\n\n${briefText}\n`;
  }

  /**
   * Stop the agent on one thread, at once. Its thread goes back to Build as stopped, and is left
   * there until the human carries on with it. The runner stays on, and its other agents work on.
   * False if no agent of this page's is on the thread.
   */
  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.stopped = true;
    // An agent that can be spoken to is asked to stop first; while a model is still being chosen there is only that to end.
    if (run.session) run.session.stop();
    else endAgent(run.child);
    return true;
  }

  /**
   * Tell the agent on one thread to stop what it is doing and wait. It is not ended: its session
   * is kept for what the human says next, as after any word of theirs. False where no agent of
   * this page's that can be spoken to is on the thread.
   */
  interrupt(id: string): boolean {
    const run = this.runs.get(id);
    if (!run?.session?.interrupt()) return false;
    run.spoke = Date.now();
    (run.unsaid ??= []).push('told by the human to stop what it was doing; it waits for their word');
    this.attend();
    return true;
  }

  /** What each run is doing now, for a face to draw. */
  live(): Live[] {
    return [...this.runs.values()].map((run) => {
      const ask = run.session?.asking[0];
      return {
        id: run.id,
        seconds: Math.round((Date.now() - run.began) / 1000),
        lines: run.lines,
        listens: !!run.session?.listens,
        asking: ask
          ? {
              ask: ask.id,
              tool: ask.tool,
              what: ask.call,
              full: ask.whole,
              why: ask.why,
              rest: keeps(ask),
              since: new Date(ask.since).toISOString(),
              until: new Date(ask.since + this.askWait).toISOString(),
            }
          : null,
      };
    });
  }

  /** A face has just asked what there is to show: someone is looking. */
  looked(): void {
    this.seen = Date.now();
  }

  /**
   * An agent needs a yes for a tool call. With someone looking it waits for them, and the notifier
   * is told. With nobody looking it is refused at once, as an agent with nobody to ask always
   * was, so that a sprint the human walked away from never stops on a question.
   */
  private asked(run: Run, task: Item, ask: Ask): void {
    if (Date.now() - this.seen >= LOOKING_MS) {
      run.session?.answer(ask.id, 'no', `Refused: nobody is at Spool to allow it. ${GO_ON}`);
      return;
    }
    // After this line is read, so that a slow notifier holds nothing up that was already here.
    setImmediate(() => notify(this.ctx, 'permission', `${run.id} needs your yes: ${ask.call}`, task));
  }

  /**
   * The human's answer to an agent's question: yes for this call (`once`), yes for the rest of
   * the run (`run`), or `no`, with a reason the agent is told. It goes back to the agent, which
   * has been waiting, and onto the thread's log.
   */
  permit(id: string, askId: string, how: 'once' | 'run' | 'no', why = ''): { ok: boolean; text: string } {
    const run = this.runs.get(id);
    const ask = run?.session?.asking.find((a) => a.id === askId);
    if (!run?.session || !ask) return { ok: false, text: 'That question is no longer open.' };
    const rest = how === 'run' ? keeps(ask) : '';
    const reason = oneLine(why, 300);
    const told = reason ? `The human refused this, and said: ${reason}` : `The human refused this. ${GO_ON}`;
    if (!run.session.answer(ask.id, how, told, true)) return { ok: false, text: 'That question is no longer open.' };
    const said =
      how === 'no'
        ? `refused by the human: ${ask.call}${reason ? `. They said: ${reason}` : ''}`
        : rest
          ? `allowed by the human for the rest of this run: ${ask.call} (not asked again: ${rest})`
          : `allowed once by the human: ${ask.call}`;
    (run.unsaid ??= []).push(said);
    // They are there: if its turn ends with the thread unfinished, it is kept a while for what they say next.
    run.spoke = Date.now();
    this.attend();
    if (how === 'no') return { ok: true, text: 'Refused. The agent is told.' };
    if (how === 'run' && !rest) return { ok: true, text: 'Allowed once: there was nothing to keep for the rest of the run.' };
    return { ok: true, text: how === 'run' ? 'Allowed for the rest of this run.' : 'Allowed once.' };
  }

  /** Stop every agent that is working, each as `stop` does, and switch the runner off. */
  stopAll(): void {
    if (!this.runs.size) return;
    this.on = false;
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  /**
   * The thread was moved by the human while it was being built: if an agent of this page's is
   * on it, end that agent. Moved back to the backlog, what the agent changed is undone once it has gone.
   */
  abort(id: string, undo = false): boolean {
    const run = this.runs.get(id);
    if (run && undo) run.undo = true;
    return this.stop(id);
  }

  /**
   * Build this thread next, ahead of the rest of Build: now, if there is room for it.
   * True if its agent is started.
   */
  take(id: string): boolean {
    if (!this.first.includes(id)) this.first.push(id);
    this.wake();
    return this.runs.has(id);
  }

  /** Whether the human has asked for this thread next, and it waits only for room. */
  isNext(id: string): boolean {
    return this.first.includes(id);
  }

  /** Something has just landed in Build: look now, without waiting for the next tick. */
  wake(): void {
    this.fill();
  }

  /**
   * Undo what an agent this page ran changed on a thread moved back to the
   * backlog, once the agent is gone: files it changed and did not commit go
   * back to how they were, then the commits with its trailer are reverted.
   * Files that were already changed when it began are left alone: they may be the human's.
   */
  private undoEdits(run: Run): string {
    if (run.worktree) return this.undoWorktree(run, run.worktree);
    const { id, before } = run;
    const said: string[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      let root: string | null = null;
      let dir = '';
      try {
        const task = ws.find(id);
        if (task) {
          root = repoRoot(run.folder);
          dir = task.spool.dir;
        }
      } finally {
        ws.close();
      }
      // Without a record of how things were, nothing uncommitted is touched: it could be anyone's.
      // The same holds where another agent was at work in the folder: some of it is that agent's.
      if (root && before && run.shared) said.push('uncommitted files left as they are, since another agent was working in the same folder');
      else if (root && before) {
        const now = dirtyPaths(root, dir) ?? [];
        const its = now.filter((p) => !before.has(p));
        discardPaths(root, its);
        if (its.length) said.push(`${its.length} uncommitted file(s) put back`);
      }
    } catch (error) {
      said.push(`its uncommitted edits could not be put back (${(error as Error).message})`);
    }
    const undone = act(this.ctx, ['propose', '--undo', id]);
    const shas = ((undone.data as { reverted?: Record<string, string[]> } | null)?.reverted ?? {})[id] ?? [];
    if (!undone.ok) said.push(`its commits could not be undone: ${undone.text}`);
    else if (shas.length) said.push(`${shas.length} commit(s) reverted`);
    const line = said.length ? `edits undone: ${said.join('; ')}` : 'edits undone: it had changed nothing';
    this.note(id, [line]);
    return line;
  }

  /**
   * The same, for a run in a worktree of its own. Taking the thread back to the backlog removed the
   * worktree and its branch already, with every commit made there: none of it had landed, and the
   * checkout was never touched. Nothing uncommitted is put back, since the folder it was in is gone.
   * What is left: a folder the agent may have written on its way out, and any commit of the thread's
   * that did land on the checkout before, which is reverted as anywhere.
   */
  private undoWorktree(run: Run, worktree: { folder: string; branch: string }): string {
    const said: string[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        const task = ws.find(run.id);
        if (task) {
          // What `propose --abort` took with the worktree, as it wrote it on the thread.
          const removed = splitBody(task.body)
            .log.map((line) => / worktree and branch \S+ removed(?:, with (\d+) commit\(s\) that never landed)?/.exec(line))
            .filter(Boolean)
            .at(-1);
          const lost = Number(removed?.[1] ?? 0);
          said.push(lost ? `its worktree and branch are gone, with the ${lost} commit(s) made there` : 'its worktree and branch are gone; nothing had been committed there');
          // Started again since, it has a worktree that is not this run's to touch.
          const left = task.worktree ? null : closeWorktree({ ...task, worktree: worktree.folder, branch: worktree.branch });
          if (left?.problem) said.push(left.problem);
        }
      } finally {
        ws.close();
      }
    } catch (error) {
      said.push(`its worktree could not be looked at (${(error as Error).message})`);
    }
    const undone = act(this.ctx, ['propose', '--undo', run.id]);
    const shas = ((undone.data as { reverted?: Record<string, string[]> } | null)?.reverted ?? {})[run.id] ?? [];
    if (!undone.ok) said.push(`its commits could not be undone: ${undone.text}`);
    else said.push(shas.length ? `${shas.length} commit(s) that had landed reverted` : 'nothing had reached the checkout');
    const line = `edits undone: ${said.join('; ')}`;
    this.note(run.id, [line]);
    return line;
  }

  private tick(): void {
    this.held = !!this.upkeep?.();
    this.attend();
    this.fill();
  }

  /**
   * Look at every agent that can be spoken to. What the human has written on its thread since it
   * was last given the thread is said to it, once, and the thread's log says so. And one that has
   * ended its turn is not left waiting: its input is closed, on which it goes, as an agent
   * always did. The one exception is a thread still unfinished whose human wrote to the agent
   * in the last few minutes: that session is kept for their next word, until those minutes are up.
   * A page waiting to restart onto new code keeps none.
   */
  private attend(): void {
    const open = [...this.runs.values()].filter((run) => run.session?.listens || run.unsaid?.length);
    if (!open.length) return;
    // A question nobody has answered in time is refused, so that no thread waits on one for ever.
    for (const run of open) {
      for (const ask of [...(run.session?.asking ?? [])]) {
        if (Date.now() - ask.since >= this.askWait) run.session!.answer(ask.id, 'no', `Refused: nobody answered in time. ${GO_ON}`);
      }
    }
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        for (const run of open) {
          const session = run.session;
          if (!session?.listens) continue;
          const task = ws.find(run.id);
          const ours = task?.status === 'active' && !run.stopped;
          if (task && ours) {
            const fresh = task.from.filter((id) => !run.told.includes(id)).map((id) => ws.find(id)).filter((n): n is Item => n?.kind === 'note');
            for (const note of fresh) {
              const words = splitBody(note.body).main;
              if (!session.say(words)) break;
              run.told.push(note.id);
              run.spoke = Date.now();
              (run.unsaid ??= []).push(`passed on to the agent: "${oneLine(words, 200)}"`);
            }
            if (fresh.length && session.id) remember(task, { session: session.id, told: run.told, pid: run.child.pid });
          }
          const kept = ours && !this.held && run.spoke !== undefined && Date.now() - run.spoke < this.replyWindow;
          if (session.waiting !== undefined && !kept) session.leave();
        }
      } finally {
        ws.close();
      }
    } catch {
      return; // The spool was being written this instant; the next tick looks again.
    }
    for (const run of open) if (run.unsaid?.length) this.note(run.id, run.unsaid);
  }

  /** Start an agent on each waiting thread there is room for. */
  private fill(): void {
    if (this.held || !this.on) return;
    // Switched off (spool disable): the agents at work finish, and nothing new is started.
    if (this.root && isOff(this.root)) return;
    // The user's number is for the whole page, across every project it builds; handOut keeps each project to its own share.
    // A thread that could not be started is not tried again until it changes, so each try here either starts one or moves on.
    let room = parallelOf(this.ctx) - this.runs.size;
    for (let tries = 0; room > 0 && tries < 100; tries++) {
      const out = this.handOut();
      if (out === 'none') return;
      if (out === 'started') room--;
    }
  }

  /** Take a run on. It takes the place of the run that chose its thread's model, where there was one. */
  private keep(run: Run): void {
    run.shared = this.runs.get(run.id)?.shared;
    // Two agents in one folder: what either leaves uncommitted there cannot be told from the other's.
    for (const other of this.runs.values()) {
      if (other.id !== run.id && other.folder === run.folder) other.shared = run.shared = true;
    }
    this.runs.set(run.id, run);
  }

  /**
   * Hand the next waiting thread to an agent, in a git worktree of its own: made now, or the one it
   * kept from a stop. Where the project cannot have one, the agent works in the project's folder,
   * and no other thread of it is handed out until that one is over.
   */
  private handOut(): HandOut {
    let task: Item | undefined;
    let handed: Handed;
    const fresh: Start = { prompt: '', command: this.agent };
    let again: Start | undefined;
    const { models } = userConfig(this.ctx);
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        // A thread an agent of this page's is on is never handed out twice, however long it has gone quiet.
        // Nor is one of a project where a chat builds: there nothing is started from the page.
        const chat = new Map<string, boolean>();
        const chatBuilds = (t: Item): boolean => {
          if (!chat.has(t.spool.root)) chat.set(t.spool.root, builderOf(this.ctx, t.spool.root) === 'chat');
          return chat.get(t.spool.root)!;
        };
        const waiting = ready(ws, this.project).filter((t) => !this.runs.has(t.id) && !chatBuilds(t));
        // What was dragged into Building and still waits comes first; the rest of Build follows, top first.
        this.first = this.first.filter((id) => waiting.some((t) => t.id === id));
        // A project whose threads would share its folder, with an agent at work there already: the rest of it waits.
        const why = new Map<string, string>();
        const shares = (t: Item): string => {
          if (!why.has(t.spool.root)) why.set(t.spool.root, sharedFolderWhy(t.spool.root));
          return why.get(t.spool.root)!;
        };
        // Each project gets what atOnceIn gives it, the number its board shows, counting its threads out now.
        const most = new Map<string, number>();
        const atOnce = (root: string): number => most.get(root) ?? most.set(root, atOnceIn(this.ctx, root)).get(root)!;
        const out = (root: string): number => [...this.runs.values()].filter((r) => ws.find(r.id)?.spool.root === root).length;
        const free = waiting.filter((t) => out(t.spool.root) < atOnce(t.spool.root));
        // Left where they are: a thread whose agent walked away, until something about it changes, and one the human stopped.
        task =
          this.first.map((id) => free.find((t) => t.id === id)).find(Boolean) ??
          free.find((t) => this.gaveUp.get(t.id) !== t.updated && !stoppedInBuild(t));
        if (!task) return 'none';
        const taken = task.id;
        this.first = this.first.filter((id) => id !== taken);
        const shared = shares(task);
        if (shared) {
          // Said once on the thread, the first time it is built so: it is the same every time after.
          if (!splitBody(task.body).log.some((line) => line.includes(OWN_FOLDER))) {
            addLog(task, 'page', `${OWN_FOLDER}${shared}, so its threads are built one at a time`, ws.now());
          }
        } else {
          try {
            openWorktree(task);
          } catch (error) {
            // Not this tick, and not every second after: it waits in Build until something about it changes.
            const e = error as SpoolError;
            addLog(task, 'page', `not started: it could not have a worktree of its own (${e.message}${e.hint ? `. ${e.hint}` : ''})`, ws.now());
            ws.save(task);
            this.gaveUp.set(task.id, task.updated);
            return 'skipped';
          }
        }
        const folder = runFolder(task);
        // In a worktree of its own, nothing there is anyone else's: it is the run's to keep or lose whole.
        const root = task.worktree ? null : repoRoot(folder);
        const dirty = root ? dirtyPaths(root, task.spool.dir) : null;
        // What the human has said on the thread: the brief gives all of it, and a session picked up again is given what is new to it.
        const notes = task.from.map((id) => ws.find(id)).filter((n): n is Item => n?.kind === 'note');
        handed = {
          id: task.id,
          title: task.title,
          folder,
          before: dirty ? new Set(dirty) : null,
          worktree: task.worktree ? { folder: task.worktree, branch: task.branch ?? '' } : undefined,
          told: notes.map((n) => n.id),
        };
        // Left unfinished by a run in a session of Claude's, it is carried on there, as it ran: nobody chooses its model a second time.
        const left = leftOff(task);
        const picked = left && this.pickUp(task, left, notes, models);
        if (picked) {
          again = picked;
          // Words of theirs it is picked up with are words to it: it is kept for the next as after any other.
          if (picked.unheard) handed.spoke = Date.now();
        } else if (left) {
          addLog(task, 'page', `session ${left.session} cannot be picked up by \`${this.agent}\`; starting afresh`, ws.now());
        }
        // Afresh, a thread whose last run did not work goes one model up, and its log says so.
        const pick = pickFor(task, models, again ? asItRan(task) : undefined);
        const stepped = takesPick(this.agent) ? stepNote(pick) : undefined;
        task.status = 'active';
        task.by = this.name();
        task.started = timestamp(ws.now());
        fresh.command = this.afresh(this.command(pick));
        if (stepped) addLog(task, 'page', stepped, ws.now());
        addLog(task, 'page', `handed to \`${(again ?? fresh).command}\``, ws.now());
        ws.save(task);
        fresh.prompt = this.opening(ws, fresh.command, brief(ws, task, paint(false)));
      } finally {
        ws.close();
      }
    } catch {
      return 'none'; // The store was busy for an instant; the next tick looks again.
    }
    this.handedOut++;
    if (again) this.start(task, handed, again, fresh);
    else this.start(task, handed, fresh);
    return 'started';
  }

  /** The agent command for a thread, with the model and effort it gets put in it, and the stream on, both ways, where it is `claude -p`. */
  private command(pick: Picked): string {
    return asking(listening(streaming(commandFor(this.agent, pick))));
  }

  /** A command that starts a thread from nothing: where it is `claude -p`, in a new session of Spool's choosing. */
  private afresh(command: string): string {
    return inSession(command, randomUUID()) ?? command;
  }

  /** The user's table of which model and effort each size gets: read fresh so a change shows at once. */
  routing(): Picking {
    return { models: userConfig(this.ctx).models };
  }

  /** What the agent is called on the thread: the program it is, so "claude" shows as Claude. */
  private name(): string {
    return this.ctx.env.SPOOL_ACTOR ?? path.basename(this.agent.trim().split(/\s+/)[0] ?? 'agent');
  }

  /**
   * Start a thread's agent. Where it picks a session up again, `afresh` is how to start the thread
   * from nothing instead: used at once if Claude turns out to have no such session.
   */
  private start(task: Item, handed: Handed, how: Start, afresh?: Start): void {
    let session: Session;
    try {
      session = startSession(task, how.prompt, how.command, { folder: handed.folder, env: this.ctx.env, actor: this.name() }, {
        note: (notes) => this.note(task.id, notes),
        end: (ended) => {
          if (!afresh || !this.startAfresh(task, run, afresh)) this.settle(run, ended);
        },
        turn: () => this.attend(),
        ask: (ask) => this.asked(run, task, ask),
      });
    } catch (error) {
      this.couldNotStart(task.id, (error as Error).message);
      return;
    }
    const run: Run = { ...handed, child: session.child, lines: session.lines, began: session.began, session, afresh, stopped: false };
    // Which session it is, and what of the human's words it has now been given: kept for the run after this one.
    if (session.id) remember(task, { session: session.id, told: handed.told, pid: session.child.pid });
    this.keep(run);
  }

  /** A thread the page handed out but could not start (its prompt could not be written, say): back in Build, and not tried every second. */
  private couldNotStart(id: string, why: string): void {
    this.runs.delete(id);
    this.putBack(id, `could not be started (${why}); back in build`);
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task) this.gaveUp.set(id, task.updated);
      } finally {
        ws.close();
      }
    } catch {
      // Busy for an instant; it is tried again, and fails again into the same line.
    }
  }

  /**
   * A run that was to pick a session up again has ended, and Claude had no such session (it was
   * cleared away, or made on another machine): start the thread from nothing, and say so on it.
   * False where that is not what happened, or the thread is no longer this run's to start.
   */
  private startAfresh(task: Item, run: Run, afresh: Start): boolean {
    if (!run.session?.lost || run.stopped || this.runs.get(run.id) !== run) return false;
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const now = ws.find(task.id);
        if (now?.status !== 'active') return false;
        addLog(now, 'page', `session ${run.session.id} could not be picked up again; starting afresh`, ws.now());
        addLog(now, 'page', `handed to \`${afresh.command}\``, ws.now());
        ws.save(now);
      } finally {
        ws.close();
      }
    } catch {
      return false; // The store could not be written: the run is settled as one that gave up.
    }
    const { id, title, folder, before, worktree, told, spoke } = run;
    this.start(task, { id, title, folder, before, worktree, told, spoke }, afresh);
    return true;
  }

  /** Write a run's notes on its thread and empty the list; if the store is busy they wait for the next try. */
  private note(id: string, notes: string[]): void {
    if (!notes.length) return;
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task) {
          for (const n of notes) addLog(task, 'page', n, ws.now());
          ws.save(task);
        }
        notes.length = 0;
      } finally {
        ws.close();
      }
    } catch {
      // Busy for an instant; they go with the next note, or when the agent exits.
    }
  }

  private settle(run: Run, how: string): void {
    let outcome = 'gone';
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const now = ws.find(run.id);
        if (now?.status === 'done') outcome = 'done';
        else if (now?.status === 'proposed') outcome = 'aborted: back in the backlog';
        else if (now?.status === 'active') {
          // The agent left without finishing or asking, or was stopped. Put the thread back, and do not spin on it:
          // what the human stopped waits for them, as its log now says, and the rest waits for something to change.
          now.status = 'open';
          now.by = undefined;
          addLog(now, 'page', run.stopped ? 'stopped from the page; back in build' : `agent ${how} without finishing; back in build`, ws.now());
          ws.save(now);
          if (!run.stopped) this.gaveUp.set(now.id, now.updated);
          outcome = run.stopped ? 'stopped' : `unfinished: the agent ${how}${run.lines.length ? ` — ${run.lines.at(-1)}` : ''}`;
        } else if (now?.status === 'open' && run.stopped && !now.needs.length) {
          // Dragged back to Build while it was being built: that is a stop too, and its log says so.
          outcome = 'stopped: waiting in build';
        } else if (now) outcome = `waiting${now.needs.length ? ' on you' : ''}`;
      } finally {
        ws.close();
      }
    } catch {
      outcome = 'unknown: the spool could not be read';
    }
    if (run.undo) outcome = `back in the backlog; ${this.undoEdits(run)}`;
    this.recent.unshift({ id: run.id, title: run.title, outcome });
    this.recent.splice(5);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
  }
}
