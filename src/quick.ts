/**
 * The quick reply: the page answering the human on a thread nobody is building.
 *
 * When the human writes on a thread, the thread shows "Typing…" at once. Where an agent of the
 * page is building it, their words already reach that agent (engine.ts `attend`), and nothing
 * more is done here. Where nobody is, a small model answers on the thread within seconds: Sonnet,
 * or Haiku for a one-line message. It is one short `claude -p` call, given the thread's brief, its
 * recent log and their words, with a time limit and no tool but reading. What it says is written
 * on the thread's log, signed with its model, so it shows as a post like any other.
 *
 * It answers; it never builds. It does not move the thread, and it says so where their words are
 * an idea or a change for it: those are already on the thread, for whoever builds it next.
 *
 * It needs the agent command to be `claude`, since that is the one whose flags Spool knows, and
 * it is off where the user's config says `quickReply: false`, or SPOOL_QUICK_REPLY is `off`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { type Ctx, userConfig } from './context.ts';
import { type Item, addLog, oneLine, splitBody } from './model.ts';
import { Workspace } from './store.ts';

/** How long a quick reply may take before it is given up: it is meant to come in seconds. */
export const QUICK_LIMIT_MS = 60_000;
/** How many may be answering at once, across every thread: each is a call that costs something. */
const AT_ONCE = 3;
/** How much of the thread it is given: its brief, cut to this many characters, and its last log lines. */
const BRIEF_CHARS = 4000;
const LOG_LINES = 15;

/** The model for a message: Haiku for a one-liner, Sonnet for anything longer. */
export function quickModel(words: string): 'haiku' | 'sonnet' {
  const w = words.trim();
  return !w.includes('\n') && w.length <= 60 ? 'haiku' : 'sonnet';
}

/** Who a quick reply is signed as on the thread: the page shows it as Claude, with its model beside. */
export const signedAs = (model: string): string => `Claude ${model[0]!.toUpperCase()}${model.slice(1)}`;

/** The `claude` program an agent command runs, where it is `claude -p`: the quick reply runs the same one. */
export function claudeOf(agent: string): string | undefined {
  const program = agent.trim().split(/\s+/)[0] ?? '';
  return path.basename(program) === 'claude' && /(^|\s)(-p|--print)(\s|$)/.test(agent) ? program : undefined;
}

/** The flags it is run with: print mode, plain text out, a little effort, and reading only. */
export function quickArgs(model: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--effort',
    'low',
    '--output-format',
    'text',
    '--max-turns',
    '4',
    '--allowedTools',
    'Read,Grep,Glob',
    '--disallowedTools',
    'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task',
  ];
}

/** What it is told: who it is, the thread, and the human's words. */
export function quickPrompt(task: Item, words: string, building: boolean): string {
  const { main, log } = splitBody(task.body);
  const brief = main.length > BRIEF_CHARS ? `${main.slice(0, BRIEF_CHARS)}\n…` : main;
  return [
    'You answer the human on one thread of a Spool work queue, on its web page, in a few seconds.',
    building
      ? 'An agent elsewhere (a chat) is building this thread; it reads the thread, so their words reach it there.'
      : 'Nobody is building this thread right now.',
    'Their message has already been added to the thread, where whoever builds it next will read it.',
    '',
    'Reply in plain text, in one to three short sentences, as a colleague would in a chat. Answer a',
    'question if you can, reading the project with Read, Grep or Glob where that helps. If their',
    'message is an idea, a wish or a change for this thread, say it was added to the thread. Never',
    'say you built, changed or moved anything: you cannot, and you do not move the thread to Build.',
    'No headings, no lists, no sign-off.',
    '',
    `THE THREAD: ${task.id} · ${task.title} · ${task.status}`,
    '',
    brief,
    '',
    'RECENT LOG',
    ...log.slice(-LOG_LINES),
    '',
    'THEIR MESSAGE',
    words,
  ].join('\n');
}

/** One quick reply being written. */
interface Pending {
  id: string;
  who: string;
  since: number;
  child: ChildProcess;
}

/** A thread showing "Typing…", and who is typing. */
export interface Typing {
  id: string;
  who: string;
  since: string;
}

/**
 * The quick replies the page is writing. `reply` starts one; `typing` is what the page shows
 * while they are written; `close` ends them all, as the page goes.
 */
export class QuickReplies {
  private pending: Pending[] = [];
  private ctx: Ctx;
  /** How long one may take: the limit, unless a test says less. */
  limit = QUICK_LIMIT_MS;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  /** Whether the user switched them off: `quickReply: false` in their config, or SPOOL_QUICK_REPLY=off. */
  get off(): boolean {
    return /^(off|0|false|no)$/i.test(this.ctx.env.SPOOL_QUICK_REPLY ?? '') || userConfig(this.ctx).quickReply === false;
  }

  /**
   * Answer what the human wrote on a thread, with the `claude` the agent command runs. False where
   * none is started: they are off, the agent is not `claude -p`, the thread is not there, or too
   * many are being written already.
   */
  reply(id: string, words: string, agent: string, building = false): boolean {
    const program = claudeOf(agent);
    if (this.off || !program || this.pending.length >= AT_ONCE) return false;
    let task: Item | undefined;
    let root = '';
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        task = ws.find(id);
        root = task?.spool.root ?? '';
      } finally {
        ws.close();
      }
    } catch {
      return false;
    }
    if (task?.kind !== 'task' || !root) return false;
    const model = quickModel(words);
    const who = signedAs(model);
    // Its own environment, without the run's: it is not an agent on a thread, and signs nothing.
    const env = { ...this.ctx.env, SPOOL_ACTOR: undefined, SPOOL_TASK: undefined, SPOOL_PROMPT_FILE: undefined };
    let child: ChildProcess;
    try {
      child = spawn(program, quickArgs(model), { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return false;
    }
    const pending: Pending = { id, who, since: Date.now(), child };
    this.pending.push(pending);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      child.kill('SIGTERM');
    }, this.limit);
    let ended = false;
    const end = (code: number | null): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.pending = this.pending.filter((p) => p !== pending);
      const said = Buffer.concat(out).toString('utf8').trim();
      if (code === 0 && said && !late) return this.write(id, who, oneLine(said, 1200));
      const why = late ? `it took longer than ${Math.round(this.limit / 1000)} seconds` : oneLine(Buffer.concat(err).toString('utf8').trim() || said || `it exited with ${code}`, 200);
      this.write(id, 'page', `no quick reply: ${why}`);
    };
    child.on('error', () => end(null));
    child.on('close', (code) => end(code));
    child.stdin!.on('error', () => {});
    child.stdin!.end(quickPrompt(task, words, building));
    return true;
  }

  /** The threads showing "Typing…" for a quick reply, oldest first. */
  typing(): Typing[] {
    return this.pending.map((p) => ({ id: p.id, who: p.who, since: new Date(p.since).toISOString() }));
  }

  close(): void {
    for (const p of this.pending) p.child.kill('SIGTERM');
    this.pending = [];
  }

  /** What it said, on the thread's log, signed as who said it. A spool busy this instant is tried again a moment later. */
  private write(id: string, who: string, text: string, tries = 5): void {
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task) {
          addLog(task, who, text, ws.now());
          ws.save(task);
        }
      } finally {
        ws.close();
      }
    } catch {
      if (tries > 1) setTimeout(() => this.write(id, who, text, tries - 1), 200);
    }
  }
}
