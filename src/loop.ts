/**
 * The loop: hand each ready task to an agent until nothing is ready.
 *
 * Spool does not contain an agent and does not care which one you use. The
 * loop claims a task, starts your agent command in that task's project with
 * the protocol and the brief on stdin, and looks at the queue again when the
 * agent exits. A task the agent finished is done; one it asked a question on
 * is waiting for you; one it walked away from is released for the next pass.
 * The lock is never held while an agent runs, so recorders and other loops
 * keep working alongside.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ROUTER,
  ROUTE_TIMEOUT_MS,
  type Route,
  commandFor,
  parseRoute,
  pickFor,
  routeNote,
  routerCommand,
  routerPrompt,
} from './agent.ts';
import type { Bare, Result } from './commands.ts';
import { notify, userConfig } from './context.ts';
import { type Item, SpoolError, addLog, timestamp } from './model.ts';
import { prime } from './prime.ts';
import { brief, itemLine, paint } from './render.ts';
import { ready, review } from './schedule.ts';
import { Workspace } from './store.ts';

export const DEFAULT_AGENT = 'claude -p';

export const PREAMBLE = `You are working one task from a Spool queue, unattended. Nobody is reading your
replies, so nothing you say in chat reaches the human: a question goes through
\`spool ask\`, a call you make yourself goes through \`spool assume\`. The task
below is already claimed for you. Finish it with \`spool done\`, or leave it
waiting on a question — then stop.
`;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function count(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SpoolError(`${flag} must be a whole number above zero`);
  return n;
}

export function runLoop({ ctx, opts, p }: Bare): Result {
  const agent =
    (typeof opts.agent === 'string' && opts.agent) || ctx.env.SPOOL_AGENT || userConfig(ctx).agent || DEFAULT_AGENT;
  const max = opts.once ? 1 : opts.max !== undefined ? count(opts.max, '--max') : Infinity;
  const watch = opts.watch !== undefined ? count(opts.watch, '--watch') : 0;
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  const { models: routing, router } = userConfig(ctx);
  /** The command for this thread: the user's, with the model and effort it gets put in. */
  const commandOf = (task: Item, routed?: Route): string => commandFor(agent, pickFor(task, routing, routed));
  /** Pass the thread to Fable first, where the agent is Claude and the human has not picked both, and log what it chose. */
  const route = (task: Item, briefText: string, asker: string): string => {
    ctx.out(`  ${p.dim(`${ROUTER} is choosing the model…`)}`);
    const run = spawnSync(asker, {
      shell: true,
      cwd: task.spool.root,
      input: routerPrompt(task, briefText),
      encoding: 'utf8',
      timeout: ROUTE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...ctx.env, SPOOL_ROUTING: task.id },
    });
    const routed = run.status === 0 ? parseRoute(run.stdout ?? '') : undefined;
    const how = run.error ? run.error.message : run.status !== 0 ? `exited ${run.status ?? run.signal}` : 'no answer it could read';
    const note = routeNote(routed, routed ? undefined : how);
    ctx.out(`  ${p.dim(note)}`);
    const command = commandOf(task, routed);
    try {
      const w = Workspace.open(ctx.cwd, ctx.now, true);
      try {
        const now = w.find(task.id);
        if (now) {
          addLog(now, 'loop', note, w.now());
          addLog(now, 'loop', `handed to \`${command}\``, w.now());
          w.save(now);
        }
      } finally {
        w.close();
      }
    } catch {
      // The notes are only notes; the run goes ahead without them.
    }
    return command;
  };

  /** Tasks an agent walked away from, and the state we left them in. Untouched since → don't retry. */
  const gaveUp = new Map<string, string>();
  const tally = { done: 0, waiting: 0, unfinished: 0 };
  let runs = 0;
  let toldIdle = false;

  const pick = (ws: Workspace): Item | undefined => ready(ws, project).find((t) => gaveUp.get(t.id) !== t.updated);

  if (opts['dry-run']) {
    const ws = Workspace.open(ctx.cwd, ctx.now);
    const queue = ready(ws, project);
    const routed = queue.filter((t) => routerCommand(agent, t, routing, router)).map((t) => t.id);
    const lines = queue.length
      ? [
          `Would run \`${agent}\` on ${queue.length} task(s), in this order:`,
          ...queue.flatMap((t) => [
            `  ${itemLine(ws, t, p)}`,
            routed.includes(t.id)
              ? `      ${p.dim(`${ROUTER} chooses the model and effort first; if it cannot: $ ${commandOf(t)}`)}`
              : `      ${p.dim(`$ ${commandOf(t)}`)}`,
          ]),
        ]
      : ['Nothing is ready, so the loop would stop at once.'];
    return {
      text: lines.join('\n'),
      data: { agent, queue: queue.map((t) => t.id), commands: Object.fromEntries(queue.map((t) => [t.id, commandOf(t)])), routed },
    };
  }

  while (runs < max) {
    let task: Item | undefined;
    let prompt = '';
    let command = agent;
    let asker: string | undefined;
    let briefText = '';
    const ws = Workspace.open(ctx.cwd, ctx.now, true);
    try {
      task = pick(ws);
      if (task) {
        command = commandOf(task);
        asker = routerCommand(agent, task, routing, router);
        task.status = 'active';
        task.by = 'loop';
        task.started = timestamp(ws.now());
        if (!asker) addLog(task, 'loop', `handed to \`${command}\``, ws.now());
        ws.save(task);
        briefText = brief(ws, task, paint(false));
        prompt = `${PREAMBLE}\n${prime(ws, 'worker')}\n\nYOUR TASK\n\n${briefText}\n`;
      } else if (!toldIdle && review(ws, project).questions.length) {
        toldIdle = notify(ctx, 'idle', `Spool is idle with ${review(ws, project).questions.length} question(s) waiting on you`);
      }
    } finally {
      ws.close();
    }

    if (!task) {
      if (!watch) break;
      sleep(watch * 1000);
      continue;
    }
    toldIdle = false;
    runs++;
    ctx.out(`${p.bold('▶')} ${task.id}  ${task.title}  ${p.dim(`· ${task.spool.name}`)}`);
    if (asker) command = route(task, briefText, asker);

    const promptFile = path.join(os.tmpdir(), `spool-${task.id}-${process.pid}.md`);
    fs.writeFileSync(promptFile, prompt);
    const run = spawnSync(command.replaceAll('{prompt_file}', promptFile), {
      shell: true,
      cwd: task.spool.root,
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', ctx.inherit ? 'inherit' : 'pipe', ctx.inherit ? 'inherit' : 'pipe'],
      env: { ...ctx.env, SPOOL_ACTOR: ctx.env.SPOOL_ACTOR ?? 'agent', SPOOL_TASK: task.id, SPOOL_PROMPT_FILE: promptFile },
    });
    fs.rmSync(promptFile, { force: true });

    const after = Workspace.open(ctx.cwd, ctx.now, true);
    try {
      const now = after.find(task.id);
      if (now?.status === 'done') {
        tally.done++;
        ctx.out(`  ${p.green('✓')} done${now.summary ? ` — ${now.summary}` : ''}`);
      } else if (now?.status === 'active') {
        // The agent left without finishing or asking. Put the task back; don't spin on it.
        now.status = 'open';
        now.by = undefined;
        const how = run.error ? `could not start (${run.error.message})` : `exited ${run.status ?? run.signal}`;
        addLog(now, 'loop', `agent ${how} without finishing`, after.now());
        after.save(now);
        gaveUp.set(now.id, now.updated);
        tally.unfinished++;
        ctx.out(`  ${p.yellow('↺')} unfinished — agent ${how}; released`);
      } else {
        tally.waiting++;
        ctx.out(`  ${p.dim(`· now ${now?.status ?? 'gone'}${now && now.needs.length ? `, waiting on ${now.needs.join(', ')}` : ''}`)}`);
      }
    } finally {
      after.close();
    }
  }

  const end = Workspace.open(ctx.cwd, ctx.now);
  const queue = review(end, project);
  const left = ready(end, project).length;
  const lines = [
    `Loop stopped after ${runs} run(s): ${tally.done} done, ${tally.waiting} waiting, ${tally.unfinished} unfinished. ${left} still ready.`,
  ];
  if (queue.questions.length) lines.push(`  ${queue.questions.length} question(s) are waiting on you — spool review`);
  return { text: lines.join('\n'), data: { runs, ...tally, ready: left, questions: queue.questions.length } };
}
