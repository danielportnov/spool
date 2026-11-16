/**
 * One agent on one thread: the program, and what it says.
 *
 * This is the only file that knows how an agent is started and heard. It starts the user's
 * agent command in the thread's folder, in a process group of its own, with the prompt on stdin;
 * before that, where a model chooses for the thread, it asks that model. What the agent prints is
 * read a line at a time (`stream.ts` knows Claude's events) into the few lines a card shows, and
 * kept whole as the thread's transcript; its session id and each tool call it was refused are
 * handed back as notes for the thread's log. And it ends an agent, with everything it started.
 *
 * A `claude -p` agent is run in a session Spool chose (`inSession` in `stream.ts`), so that a
 * thread left unfinished is picked up again where it was. What Spool remembers of that session
 * from one run to the next (`recall`, `remember`) is kept beside the thread's transcripts.
 *
 * Such a session is started with its input left open (`listening`), and then it can be spoken to
 * while it works: `say` writes it a message from the human, `interrupt` tells it to stop what it
 * is doing, and `leave` closes its input, on which it finishes its turn and goes. A tool call it
 * needs a yes for is put to it as a question (`asking`), which waits until `answer` is given. Any
 * other agent is given its prompt and watched, as it always was.
 *
 * It knows nothing of the queue: which thread is next, what a run's ending means for its thread,
 * and what is written on it are the engine's (`engine.ts`).
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROUTE_TIMEOUT_MS, routerPrompt } from './agent.ts';
import type { Ctx } from './context.ts';
import type { Item } from './model.ts';
import { oneLine } from './model.ts';
import { type Ask, allowLine, denyLine, hearLine, interruptLine, listens, runDir, sessionOf, transcriptFile, userLine } from './stream.ts';

/** How many of the lines an agent has printed are kept to show: the newest. */
const LIVE_LINES = 60;

/** The file a page writes its agent's prompt to. It lives exactly as long as the agent. */
export const promptFile = (id: string, pid: number): string => path.join(os.tmpdir(), `spool-${id}-${pid}.md`);

/** A file's size, or nothing if it is gone: a run's ending must not depend on it. */
const sizeOf = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** Whether a page on this machine, other than this one, has an agent on the thread right now. */
export function pageRunning(id: string): boolean {
  let names: string[] = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return false;
  }
  return names.some((name) => {
    const found = /^spool-(t-[a-z0-9]+)-(\d+)\.md$/.exec(name);
    if (!found || found[1] !== id) return false;
    const pid = Number(found[2]);
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
}

/** End a program started in a process group of its own, and everything it started. */
export function endGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

/** How long an agent told to end has to do so, before what is left of it is killed. */
const END_GRACE_MS = 2000;

/** How long a session asked to stop has to end its turn and go by itself, before it is ended. */
const STOP_GRACE_MS = 3000;

/**
 * End the agent and whatever it started: it runs in a group of its own, so the whole group is
 * told. A stuck agent may not listen, so what is left of the group a moment later is killed.
 */
export function endAgent(child: ChildProcess): void {
  endGroup(child);
  setTimeout(() => endGroup(child, 'SIGKILL'), END_GRACE_MS).unref();
}

/**
 * The step before a run: the thread is passed to Fable, which reads its brief and answers with
 * the model to work it and how hard to think. `done` hears how that ended and what was printed;
 * what the answer means for the thread is its caller's to say. One that takes too long is ended.
 */
export function askRouter(
  asker: string,
  task: Item,
  briefText: string,
  at: { folder: string; env: Ctx['env'] },
  done: (code: number | null, how: string, out: string) => void,
): ChildProcess {
  const child = spawn(asker, {
    shell: true,
    cwd: at.folder,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...at.env, SPOOL_ROUTING: task.id },
  });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    if (out.length < 1024 * 1024) out += chunk.toString('utf8');
  });
  child.stderr!.on('data', () => {});
  child.stdin!.on('error', () => {});
  child.stdin!.end(routerPrompt(task, briefText));
  const timer = setTimeout(() => endAgent(child), ROUTE_TIMEOUT_MS);
  let over = false;
  const end = (code: number | null, how: string): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    done(code, how, out);
  };
  child.on('error', (error) => end(null, `could not start (${error.message})`));
  child.on('exit', (code, signal) => end(code, `exited ${code ?? signal}`));
  return child;
}

/**
 * What Spool remembers of a thread's session from one run to the next: which session it is, and
 * which of the human's notes on the thread it has been given, so that each is given to it once.
 * And the process that last ran it, so that one whose page died under it can be ended before the
 * session is picked up again. It is kept beside the thread's transcripts, on this machine only,
 * as the session itself is.
 */
export interface Kept {
  session: string;
  told: string[];
  pid?: number;
}

const keptFile = (task: Item): string => path.join(task.spool.dir, 'runs', task.id, 'session.json');

export function recall(task: Item): Kept | undefined {
  try {
    const kept = JSON.parse(fs.readFileSync(keptFile(task), 'utf8')) as Partial<Kept> | null;
    if (!kept || typeof kept.session !== 'string' || !Array.isArray(kept.told)) return undefined;
    const pid = typeof kept.pid === 'number' && Number.isInteger(kept.pid) && kept.pid > 1 ? kept.pid : undefined;
    return { session: kept.session, told: kept.told.filter((id): id is string => typeof id === 'string'), pid };
  } catch {
    return undefined; // Nothing kept, or not what Spool writes: the session is told again.
  }
}

export function remember(task: Item, kept: Kept): void {
  try {
    runDir(task.spool.dir, task.id);
    fs.writeFileSync(keptFile(task), `${JSON.stringify(kept)}\n`);
  } catch {
    // Nowhere to keep it: at worst the session hears a note twice.
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * End what is left of an agent whose page died under it. Its input closed with the page, but a
 * Claude session works on to the end of its turn, and two programs must not be in one session.
 * The number alone is not trusted, since the system hands numbers out again: the process is ended
 * only if its command still names the session. It waits until the agent is gone, a moment at most.
 */
export function endLeftover(kept: Kept): void {
  const pid = kept.pid;
  if (!pid || !kept.session || process.platform === 'win32' || !alive(pid)) return;
  // The whole command, however long: the session is named at its far end.
  const command = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  if (!command.includes(kept.session)) return;
  const wait = (ms: number): void => {
    for (const until = Date.now() + ms; alive(pid) && Date.now() < until; ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      return; // Gone already.
    }
    wait(END_GRACE_MS);
    if (!alive(pid)) return;
  }
}

/** One agent at work on one thread. */
export interface Session {
  child: ChildProcess;
  /** The newest of the lines it has printed, as a person reads them. */
  lines: string[];
  began: number;
  /** The Claude session Spool put it in, where it did. */
  id?: string;
  /** It was to pick that session up again, and Claude has no such session: nothing was carried on. */
  lost: boolean;
  /** It can be spoken to: a Claude session whose input is open. False for any other agent, and once its input is closed. */
  listens: boolean;
  /** When its last turn ended, if nothing has been said to it since: it is waiting for a word. */
  waiting?: number;
  /** The tool calls it needs a yes for and is waiting on, oldest first, each with when it asked. */
  asking: (Ask & { since: number })[];
  /**
   * Answer one of those: yes for this call, yes for the rest of the run, or no with the reason
   * the agent is given. `person` says a human gave the answer, and not Spool for want of one.
   * False where it is not waiting on that question.
   */
  answer(id: string, how: 'once' | 'run' | 'no', reason?: string, person?: boolean): boolean;
  /** Say the human's words to it. They are read at its next step. False where it cannot be spoken to. */
  say(text: string): boolean;
  /** Tell it to stop what it is doing. Its turn ends, and it waits for what is said next. */
  interrupt(): boolean;
  /** Close its input: it finishes the turn it is in, and goes. */
  leave(): void;
  /** Stop it now. One that can be spoken to is asked first, so its session knows it was stopped; then it is ended like any other. */
  stop(): void;
}

/**
 * Start the agent on a thread: its command, in the thread's folder, with the prompt on stdin and
 * in a file it can be pointed at. What it prints is heard a line at a time into `lines`, the
 * newest of them, and kept whole in the thread's transcript. `on.note` is given what belongs on
 * the thread's log (its session, each tool call it was refused, where the transcript is): the
 * same list every time, for whoever writes them down to empty. `on.end` hears how it ended.
 *
 * A `claude -p` command with its input open is given the prompt as its first message, and its
 * input stays open. `on.turn` hears each time it ends a turn and waits: it goes on waiting until
 * it is spoken to or its input is closed, so whoever holds it must do one or the other. `on.ask`
 * hears each tool call it needs a yes for; that waits too, until it is answered.
 */
export function startSession(
  task: Item,
  prompt: string,
  command: string,
  at: { folder: string; env: Ctx['env']; actor: string },
  on: { note: (notes: string[]) => void; end: (how: string) => void; turn?: () => void; ask?: (ask: Ask) => void },
): Session {
  const file = promptFile(task.id, process.pid);
  fs.writeFileSync(file, prompt);
  const child = spawn(command.replaceAll('{prompt_file}', file), {
    shell: true,
    cwd: at.folder,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops what it started too.
    detached: process.platform !== 'win32',
    env: { ...at.env, SPOOL_ACTOR: at.actor, SPOOL_TASK: task.id, SPOOL_PROMPT_FILE: file },
  });
  const began = Date.now();
  const lines: string[] = [];
  const show = (line: string): void => {
    lines.push(line.slice(0, 400));
    if (lines.length > LIVE_LINES) lines.splice(0, lines.length - LIVE_LINES);
  };
  let sent = 0;
  // What Spool says to a session: written to it, kept in the transcript as an event of Spool's own, and shown.
  const tell = (line: string, event: Record<string, unknown>, shown: string): boolean => {
    if (!live.listens) return false;
    child.stdin!.write(`${line}\n`);
    keepRaw(`${JSON.stringify({ type: 'spool', ...event })}\n`);
    show(shown);
    return true;
  };
  const live: Session = {
    child,
    lines,
    began,
    id: sessionOf(command)?.id,
    lost: false,
    listens: listens(command),
    say: (text) => {
      if (!tell(userLine(text), { event: 'said', text }, `you: ${oneLine(text, 300)}`)) return false;
      live.waiting = undefined;
      return true;
    },
    interrupt: () => tell(interruptLine(`spool-${++sent}`), { event: 'interrupt' }, 'told to stop what it is doing'),
    asking: [],
    answer: (id, how, reason = '', person = false) => {
      const at = live.asking.findIndex((ask) => ask.id === id);
      const ask = live.asking[at];
      if (!ask) return false;
      const yes = how !== 'no';
      if (!tell(yes ? allowLine(ask, how === 'run') : denyLine(ask, reason), { event: 'answered', ask: id, call: ask.call, answer: how, ...(person ? { by: 'human' } : {}) }, `${yes ? 'allowed' : 'refused'} → ${ask.call}`)) return false;
      live.asking.splice(at, 1);
      // A no a person gave is on the thread's log in their words: it is not said again when the turn ends.
      if (!yes && person) refused.push(ask.call);
      return true;
    },
    leave: () => {
      if (!live.listens) return;
      live.listens = false;
      child.stdin!.end();
    },
    stop: () => {
      if (!live.listens) return endAgent(child);
      live.interrupt();
      live.leave();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) endAgent(child);
      }, STOP_GRACE_MS).unref();
    },
  };
  // Everything the agent prints is kept with the thread as it came, stderr as events of its own.
  let transcript: string | undefined;
  let keep: number | undefined;
  try {
    transcript = transcriptFile(task.spool.dir, task.id, new Date(began));
    keep = fs.openSync(transcript, 'a');
  } catch {
    transcript = undefined; // Nowhere to keep it; the run goes ahead without.
  }
  const shown = transcript ? path.relative(task.spool.root, transcript) : '';
  const keepRaw = (text: string): void => {
    if (keep === undefined) return;
    try {
      fs.writeSync(keep, text);
    } catch {
      // A full disk loses the transcript, not the run.
    }
  };
  // What goes on the thread's log: its session, and each tool call it was refused.
  const notes: string[] = [];
  let session: string | undefined;
  // A session says which it is at the start of every turn: once is enough to show.
  let opened = '';
  // The calls a person refused, which the turn's last event will list among those it was denied.
  const refused: string[] = [];
  const hear = (line: string): void => {
    // A line at a time, without the terminal's colour codes.
    const heard = hearLine(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
    for (const l of heard.lines) {
      if (l === opened) continue;
      if (heard.session && l.startsWith(`session ${heard.session}`)) opened = l;
      show(l);
    }
    if (heard.lost) live.lost = true;
    let log = false;
    // The id on the line that says there is no such session is not a session.
    if (heard.session && !session && !heard.lost) {
      session = heard.session;
      notes.push(`session ${session}${shown ? ` · transcript ${shown}` : ''} · open it with \`claude --resume ${session}\``);
      log = true;
    }
    for (const d of heard.denials ?? []) {
      const said = refused.indexOf(d);
      if (said >= 0) {
        refused.splice(said, 1);
        continue;
      }
      notes.push(`permission denied: ${d}`);
      log = true;
    }
    if (log) on.note(notes);
    if (heard.asks && live.listens) {
      const ask = { ...heard.asks, since: Date.now() };
      live.asking.push(ask);
      on.ask?.(ask);
    }
    if (heard.over && live.listens) {
      live.waiting = Date.now();
      on.turn?.();
    }
  };
  // The transcript is written a whole line at a time, so that an event of Spool's own never lands inside one of the agent's.
  const reader = (stderr: boolean) => {
    let rest = '';
    const take = (part: string, whole = true): void => {
      if (stderr && part.trim()) keepRaw(`${JSON.stringify({ type: 'stderr', text: part })}\n`);
      if (!stderr) keepRaw(whole ? `${part}\n` : part);
      hear(part);
    };
    return {
      data: (chunk: Buffer): void => {
        const parts = (rest + chunk.toString('utf8')).split('\n');
        rest = parts.pop() ?? '';
        parts.forEach((part) => take(part));
      },
      flush: (): void => {
        if (rest) take(rest, false);
        rest = '';
      },
    };
  };
  const out = reader(false);
  const err = reader(true);
  child.stdout!.on('data', out.data);
  child.stderr!.on('data', err.data);
  child.stdin!.on('error', () => {});
  // A session that can be spoken to takes the prompt as its first message, and its input stays open for the next.
  if (live.listens) child.stdin!.write(`${userLine(prompt)}\n`);
  else child.stdin!.end(prompt);
  let over = false;
  const end = (how: string): void => {
    if (over) return;
    over = true;
    live.listens = false;
    live.waiting = undefined;
    live.asking.length = 0;
    out.flush();
    err.flush();
    if (keep !== undefined) fs.closeSync(keep);
    keep = undefined;
    fs.rmSync(file, { force: true });
    // A run with no session still says where its transcript is; notes the store was too busy for go now.
    if (!session && transcript && sizeOf(transcript) > 0) notes.push(`transcript ${shown}`);
    on.note(notes);
    on.end(how);
  };
  child.on('error', (error) => end(`could not start (${error.message})`));
  child.on('exit', (code, signal) => end(`exited ${code ?? signal}`));
  return live;
}
