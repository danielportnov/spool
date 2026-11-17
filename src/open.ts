/**
 * Opening a thread's session in Claude Code: `spool open <t-id>`.
 *
 * Every thread the page builds with `claude -p` runs in a Claude session Spool chose, and its log
 * says which. `spool open` lends this terminal to that session: the page's agent lets go of it
 * first (Stop, through the page), the thread is the user's while it is open, so no agent takes
 * it, and the terminal becomes `claude --resume <session>` in the thread's folder. Nothing is
 * drawn by Spool and no pseudo-terminal is needed: Claude Code gets the terminal as it is.
 *
 * When Claude Code is quit, the thread is done if `spool done` ran in it. Otherwise one question:
 * hand it back to the agent, which the page carries on in that same session (`leftOff`, "handed
 * back"), or leave it stopped in Build, to open again or carry on from the board.
 *
 * A thread with no session of its own (in Chat mode, threads are built by a chat's subagents,
 * which have none Spool can open; or one nobody has started) is opened in a new Claude session,
 * in the thread's own worktree, with its brief as the first message. The log names that session
 * too, so handing it back carries it on there.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bare, Command, Result } from './commands.ts';
import { type Ctx, builderOf, userConfig } from './context.ts';
import { pageUp } from './detach.ts';
import { HANDED_BACK, STOPPED_OPEN, handedByPage, sessionRan } from './engine.ts';
import { DEFAULT_AGENT } from './loop.ts';
import { type Item, SpoolError, addLog, splitBody, timestamp } from './model.ts';
import { prime } from './prime.ts';
import { brief, paint } from './render.ts';
import { taskState } from './schedule.ts';
import { endLeftover, pageRunning, promptFile, recall } from './session.ts';
import { askPage } from './standing.ts';
import { Workspace } from './store.ts';
import { SESSION_ID } from './stream.ts';
import { openWorktree, workDir } from './worktree.ts';

/** How long the page's agent has to let go of the session once it is told to stop. */
const LET_GO_MS = 90_000;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Do something with the queue open, and close it again whatever happens. */
function withQueue<T>(ctx: Ctx, write: boolean, use: (ws: Workspace) => T): T {
  const ws = Workspace.open(ctx.cwd, ctx.now, write);
  try {
    return use(ws);
  } finally {
    ws.close();
  }
}

/** The Claude Code to open: the agent command's own `claude`, where it names one by its path, else `claude`. */
export function claudeOf(ctx: Ctx): string {
  const agent = ctx.env.SPOOL_AGENT || userConfig(ctx).agent || DEFAULT_AGENT;
  const program = agent.trim().split(/\s+/)[0] ?? '';
  return path.basename(program) === 'claude' ? program : 'claude';
}

/** What a new session is told first: the user is at the keyboard, and the thread is claimed. */
const OPENING = `You are working one task from a Spool queue, with the user at the keyboard: they
opened this session in Claude Code to work it with you, so talk to them here. The
task below is already claimed. Follow the worker's rules: finish it with
\`spool done\` when it is done. If the user quits first, they choose whether an
agent carries on with it.
`;

/** Ask the page building a thread to let go of it, and wait until its agent has. */
function letGo(ctx: Ctx, task: Item): void {
  const page = pageUp(ctx, task.spool.root);
  const how = `Stop it on the board, then spool open ${task.id} again.`;
  if (!page?.token) throw new SpoolError(`an agent of the Spool page is building ${task.id}, and no page that takes requests from here is up to let go of it`, how);
  const said = askPage(page.url, 'api/stop', { token: page.token, body: { id: task.id } });
  if (!said || said.status !== 200) {
    const why = (said?.body as { text?: string } | undefined)?.text;
    throw new SpoolError(`the page would not let go of ${task.id}${why ? `: ${why}` : ''}`, how);
  }
  for (const until = Date.now() + LET_GO_MS; ; sleep(200)) {
    const now = withQueue(ctx, false, (ws) => ws.get(task.id, 'task'));
    if (now.status !== 'active' && !pageRunning(task.id)) return;
    if (Date.now() > until) throw new SpoolError(`the page's agent on ${task.id} has not let go of its session yet`, `Try again in a moment: spool open ${task.id}`);
  }
}

/** The user's answer to the one question, a line typed at the terminal, or the first line piped in. */
function answer(ctx: Ctx): string {
  if (!ctx.tty) return ctx.stdin().split('\n')[0] ?? '';
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, one, 0, 1, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        sleep(50);
        continue;
      }
      break;
    }
    if (n === 0 || one[0] === 0x0a) break;
    bytes.push(one[0]!);
  }
  return Buffer.from(bytes).toString('utf8');
}

function openThread(call: Bare): Result {
  const { ctx, actor } = call;
  const ref = call.args[0];
  if (!ref) throw new SpoolError('which thread?', 'spool open <t-id>');
  const then = typeof call.opts.then === 'string' ? call.opts.then.trim().toLowerCase() : '';
  if (then && then !== 'back' && then !== 'stop') throw new SpoolError(`--then is back or stop, not "${then}"`, 'back hands it to the agent when you quit; stop leaves it stopped');

  // 1. The thread, and who has it now.
  const task = withQueue(ctx, false, (ws) => ws.get(ref, 'task'));
  const state = withQueue(ctx, false, (ws) => taskState(ws, task));
  const id = task.id;
  if (task.status === 'proposed') throw new SpoolError(`${id} is in the backlog`, `Move it to Build first: spool build ${id}`);
  if (state === 'done' || state === 'dropped' || state === 'archived') {
    throw new SpoolError(`${id} is ${state}`, 'Only a thread in Build, or being built, opens in Claude Code');
  }
  if (task.status === 'active' && task.by !== actor) {
    if (!handedByPage(task)) {
      throw new SpoolError(`${id} is being built by ${task.by ?? 'someone'}`, 'It is theirs until they finish or hand it off. In Chat mode, stop it in the chat first.');
    }
    if (pageRunning(id)) letGo(ctx, task);
    else {
      // Left handed out by a page that is gone: what is left of its agent is ended first, so two never share the session.
      const kept = recall(task);
      if (kept) endLeftover(kept);
    }
  }

  // 2. The session to open, and the folder it is in. One the page ran is opened where it ran; otherwise a new one, in the thread's worktree.
  const chat = builderOf(ctx, task.spool.root) === 'chat';
  let session = '';
  let folder = '';
  let prompt = '';
  withQueue(ctx, true, (ws) => {
    const t = ws.get(id, 'task');
    const ran = sessionRan(splitBody(t.body).log);
    if (ran && SESSION_ID.test(ran) && fs.existsSync(workDir(t))) {
      session = ran;
    } else {
      session = randomUUID();
      if (!t.worktree || !fs.existsSync(workDir(t))) {
        try {
          openWorktree(t);
        } catch {
          // No worktree here (not a git repository, or nothing committed): it is worked in the project's own folder.
        }
      }
    }
    folder = workDir(t);
    t.status = 'active';
    t.by = actor;
    t.started = timestamp(ws.now());
    addLog(t, actor, `opened in Claude Code, in session ${session}${session === ran ? '' : ', a new one'}`, ws.now());
    ws.save(t, { actor, command: 'open' });
    if (session !== ran) prompt = `${OPENING}\n${prime(ws, 'worker')}\n\nYOUR TASK\n\n${brief(ws, t, paint(false))}\n`;
  });

  // 3. The terminal is Claude Code's until it is quit. While it is open, no page hands the thread to an agent.
  const hold = promptFile(id, process.pid);
  const ignore = (): void => {};
  let ran: ReturnType<typeof spawnSync>;
  try {
    fs.writeFileSync(hold, `${id} is open in Claude Code, in session ${session}\n`);
    for (const signal of ['SIGINT', 'SIGQUIT'] as const) process.on(signal, ignore);
    const args = prompt ? ['--session-id', session, prompt] : ['--resume', session];
    ran = spawnSync(claudeOf(ctx), args, { cwd: folder, stdio: 'inherit', env: { ...ctx.env, SPOOL_TASK: id } });
  } finally {
    for (const signal of ['SIGINT', 'SIGQUIT'] as const) process.off(signal, ignore);
    fs.rmSync(hold, { force: true });
  }

  // 4. Claude Code is closed: done, or the one question.
  const after = withQueue(ctx, false, (ws) => ws.get(id, 'task'));
  if (after.status === 'done') return { text: `Done: ${after.title}. It was finished in Claude Code.`, data: { id, session, then: 'done' } };
  if (after.status !== 'active' || after.by !== actor) {
    const now = withQueue(ctx, false, (ws) => taskState(ws, after));
    return { text: `${id} is ${now} now, and is left as it is.`, data: { id, session, then: now } };
  }
  const failed = ran.error ? `Claude Code would not start (${ran.error.message})` : '';
  let choice = failed ? 'stop' : then;
  if (!choice) {
    ctx.out(`${id} is not done. Hand it back to the agent to finish (h), or leave it stopped (s)? [h/S]`);
    choice = /^\s*(h|back)/i.test(answer(ctx)) ? 'back' : 'stop';
  }
  withQueue(ctx, true, (ws) => {
    const t = ws.get(id, 'task');
    if (failed) addLog(t, actor, failed, ws.now());
    addLog(t, actor, choice === 'back' ? HANDED_BACK : STOPPED_OPEN, ws.now());
    t.status = 'open';
    t.by = undefined;
    ws.save(t, { actor, command: 'open' });
  });
  if (failed) throw new SpoolError(`${failed}, so ${id} is left stopped in Build`, `Is claude on your PATH? Then: spool open ${id}`);
  const text =
    choice === 'back'
      ? `Handed back: ${task.title}. ${chat ? 'It waits in Build for the chat that builds.' : 'The page’s agent carries it on in this same session as soon as agents are on.'}`
      : `Left stopped in Build, with its work kept: ${task.title}. spool open ${id} goes back into the session; Carry on, on the board, hands it to an agent.`;
  return { text, data: { id, session, then: choice } };
}

export const OPEN: Command = {
  name: 'open',
  group: 'setup',
  human: true,
  usage: 'open <t-id> [--then back|stop]',
  summary:
    "Open a thread's Claude session in this terminal: the page's agent lets go, the thread is yours while Claude Code is open, and when you quit it is done, handed back to the agent (it carries on in the same session) or left stopped. --then answers that question ahead",
  options: { then: { type: 'string' } },
  refusedWhenOff: true,
  bare: openThread,
};
