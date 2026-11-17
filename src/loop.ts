/**
 * The loop: build what is ready, a thread at a time or several at once, until nothing is.
 *
 * Spool does not contain an agent and does not care which one you use. The loop starts no agent
 * itself: it holds the same runner the page does (`engine.ts`), signed as the loop, and is its
 * face in plain lines. The runner claims each thread, starts your agent command on it in a
 * folder of its own where it can have one, keeps its transcript and its session, and settles it
 * when the agent has gone: a thread the agent finished is done; one it asked a question on is
 * waiting for you; one it walked away from is put back for the next pass. The loop prints a
 * line as each starts, what its agent says, and a line as each ends, and returns when there is
 * nothing left to hand out. The lock is never held while an agent runs, so recorders and other
 * loops keep working alongside.
 */

import { fableCap } from './usage.ts';
import { commandFor, pickFor, stepNote, takesPick } from './agent.ts';
import { agentOfCommand, routingFor } from './roster.ts';
import type { Bare, Result } from './commands.ts';
import { notify, userConfig } from './context.ts';
import { DEFAULT_AGENT, type Face, Runner } from './engine.ts';
import { type Item, SpoolError, firstLine } from './model.ts';
import { itemLine } from './render.ts';
import { ready, review } from './schedule.ts';
import { Workspace } from './store.ts';

export { DEFAULT_AGENT, PREAMBLE } from './engine.ts';

function count(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SpoolError(`${flag} must be a whole number above zero`);
  return n;
}

/**
 * `spool loop`. A dry run, or a flag that is wrong, is answered at once; otherwise the answer
 * comes when the loop stops, and the command line waits for it.
 */
export function runLoop({ ctx, opts, p }: Bare): Result | Promise<Result> {
  const agent =
    (typeof opts.agent === 'string' && opts.agent) || ctx.env.SPOOL_AGENT || userConfig(ctx).agent || DEFAULT_AGENT;
  const max = opts.once ? 1 : opts.max !== undefined ? count(opts.max, '--max') : Infinity;
  const watch = opts.watch !== undefined ? count(opts.watch, '--watch') : 0;
  const project = typeof opts.project === 'string' ? opts.project : undefined;

  if (opts['dry-run']) {
    /** The command for this thread: the user's, with the model and effort it gets put in, and the line that says it stepped up, if it did. */
    const commandOf = (task: Item): { command: string; stepped?: string } => {
      const pick = pickFor(task, routingFor(ctx, task.spool.root, agentOfCommand(agent)), undefined, fableCap(ctx));
      const stepped = takesPick(agent) ? stepNote(pick) : undefined;
      return { command: commandFor(agent, pick), ...(stepped ? { stepped } : {}) };
    };
    const ws = Workspace.open(ctx.cwd, ctx.now);
    const queue = ready(ws, project);
    const planned = new Map(queue.map((t) => [t.id, commandOf(t)]));
    const lines = queue.length
      ? [
          `Would run \`${agent}\` on ${queue.length} task(s), in this order:`,
          ...queue.flatMap((t) => {
            const { command, stepped } = planned.get(t.id)!;
            return [`  ${itemLine(ws, t, p)}`, ...(stepped ? [`      ${p.dim(stepped)}`] : []), `      ${p.dim(`$ ${command}`)}`];
          }),
        ]
      : ['Nothing is ready, so the loop would stop at once.'];
    return {
      text: lines.join('\n'),
      data: {
        agent,
        queue: queue.map((t) => t.id),
        commands: Object.fromEntries(queue.map((t) => [t.id, planned.get(t.id)!.command])),
        stepped: queue.filter((t) => planned.get(t.id)!.stepped).map((t) => t.id),
      },
    };
  }

  const tally = { done: 0, waiting: 0, unfinished: 0 };
  let runs = 0;
  let toldIdle = false;

  return new Promise<Result>((resolve) => {
    // Once two threads have been going at once, each line says which thread it is about.
    let several = false;
    const which = (id: string): string => (several ? `${id} ` : '');
    const face: Face = {
      started: (task) => {
        runs++;
        toldIdle = false;
        // Told before the runner takes the run on: any run it holds now is another thread's.
        if ([...runner.runs.keys()].some((id) => id !== task.id)) several = true;
        ctx.out(`${p.bold('▶')} ${task.id}  ${task.title}  ${p.dim(`· ${task.spool.name}`)}`);
      },
      heard: (id, line) => ctx.out(`    ${which(id)}${p.dim(line)}`),
      settled: ({ id }, outcome, how, now) => {
        const tag = which(id);
        if (now?.status === 'done') {
          tally.done++;
          ctx.out(`  ${p.green('✓')} ${tag}done${now.summary ? ` — ${firstLine(now.summary)}` : ''}`);
        } else if (outcome.startsWith('unfinished')) {
          tally.unfinished++;
          ctx.out(`  ${p.yellow('↺')} ${tag}unfinished — agent ${how}; released`);
        } else {
          tally.waiting++;
          ctx.out(`  ${p.dim(`· ${tag}now ${now?.status ?? 'gone'}${now && now.needs.length ? `, waiting on ${now.needs.join(', ')}` : ''}`)}`);
        }
        // After the runner has let the run go: then it has room, and the next can be handed out.
        setImmediate(look);
      },
    };
    const runner = new Runner(ctx, project, agent, true, { as: 'loop', face, most: max });
    let timer: NodeJS.Timeout | undefined;
    let over = false;

    const stop = (): void => {
      if (over) return;
      over = true;
      if (timer) clearInterval(timer);
      runner.close();
      for (const signal of SIGNALS) process.off(signal, interrupted);
      resolve(summary());
    };
    // Ctrl-C: every thread an agent is on goes back to Build, and the agents end with the loop.
    const interrupted = (): void => stop();
    for (const signal of SIGNALS) process.once(signal, interrupted);

    /** With nothing being built, take the next; with nothing to take, say so, and stop unless told to watch. */
    function look(): void {
      if (over || runner.runs.size) return;
      runner.wake();
      if (runner.runs.size) return;
      if (!toldIdle) {
        const questions = readQuestions();
        if (questions) toldIdle = notify(ctx, 'idle', `Spool is idle with ${questions} question(s) waiting on you`);
      }
      if (!watch || runner.handedOut >= max) stop();
    }

    function readQuestions(): number {
      const ws = Workspace.open(ctx.cwd, ctx.now);
      try {
        return review(ws, project).questions.length;
      } finally {
        ws.close();
      }
    }

    function summary(): Result {
      const end = Workspace.open(ctx.cwd, ctx.now);
      try {
        const queue = review(end, project);
        const left = ready(end, project).length;
        const lines = [
          `Loop stopped after ${runs} run(s): ${tally.done} done, ${tally.waiting} waiting, ${tally.unfinished} unfinished. ${left} still ready.`,
        ];
        if (queue.questions.length) lines.push(`  ${queue.questions.length} question(s) are waiting on you — spool review`);
        return { text: lines.join('\n'), data: { runs, ...tally, ready: left, questions: queue.questions.length } };
      } finally {
        end.close();
      }
    }

    if (watch) timer = setInterval(look, watch * 1000);
    look();
  });
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
