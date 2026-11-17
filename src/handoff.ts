/**
 * Handing a thread off: an agent that runs out of usage mid-thread gives it to one that has some.
 *
 * `spool handoff <t-id> -m "<where it stopped>" [--to <agent or model>]` is what the agent building
 * a thread runs when its usage is spent, or nearly (the plan's limit, or the target the human set).
 * It checkpoints the work: anything not committed in the thread's worktree is committed there, with
 * the thread's trailer, so nothing is lost. It logs the note, says who it is for, and puts the thread
 * back in Build with its worktree kept. The next claim goes back into that worktree, and its brief
 * shows the note at the top, so the new agent carries on from where the last one stopped.
 *
 * `--to` names who may take it: another agent on the roster ("Codex"), and then only that agent is
 * handed it; or a model ("sonnet"), and then the next claim is built on that model, whoever claims
 * it. Without `--to`, anyone may. Where nobody has usage left, the thread waits in Build, and its
 * log and brief say it was handed off and why.
 *
 * A hand-off is not a failed run: the model that ran it did nothing wrong, it ran out. So it never
 * counts toward a step up (agent.ts): its log line is none of the lines a step up reads as a setback.
 * The page's runner does not hold it either: only the human stopping a thread does that.
 */

import type { Command } from './commands.ts';
import { LADDER, modelOf, signer } from './agent.ts';
import { git } from './git.ts';
import { type Item, SpoolError, addLog, oneLine, splitBody } from './model.ts';
import { rosterOf } from './roster.ts';
import { taskState } from './schedule.ts';
import { worktreeDir } from './worktree.ts';

/** A hand-off as its log line has it: who handed it off, for whom, the note, and the checkpoint. */
export interface Handoff {
  by: string;
  /** The agent or model it is for, as given; empty where it is for anyone. */
  to: string;
  /** Set where `to` is a model: the next claim is built on it. */
  model?: string;
  note: string;
  /** The commit the work so far was at, where it had a worktree. */
  at?: string;
}

const LINE = /^handed off(?: to (.+?))?: (.*?)(?: \(work so far at ([0-9a-f]{7,40})\))?; back in build$/;
/** A log line: its time, who wrote it, and what it says. */
const ENTRY = /^- \S+ \S+ (.+?): (.*)$/;
/** A claim: the next one after a hand-off is the one carrying it on. */
const CLAIM = /^(started\b|picked up after)/;
/** What ends a hand-off's say: the thread finished, put back some other way, or taken back. */
const OVER = /^(done: |moved back to |reverted |stopped |agent .* without finishing)/;

/** The model a `--to` names, where it is one on the ladder: "sonnet", "opus". */
const modelNamed = (to: string): string | undefined => {
  const m = modelOf(to)?.toLowerCase();
  return m && (LADDER as readonly string[]).includes(m) ? m : undefined;
};

/**
 * The hand-off the thread is in now, or null: the last one in its log, while nothing has ended it
 * and no more than one claim (the one carrying it on) has come after it.
 */
export function handoffOf(task: Item): Handoff | null {
  let found: Handoff | null = null;
  let claims = 0;
  for (const line of splitBody(task.body).log) {
    const entry = ENTRY.exec(line);
    if (!entry) continue;
    const [, by, what] = entry as unknown as [string, string, string];
    const h = LINE.exec(what);
    if (h) {
      const to = h[1] ?? '';
      found = { by, to, model: modelNamed(to), note: h[2] ?? '', at: h[3] };
      claims = 0;
    } else if (found && OVER.test(what)) found = null;
    else if (found && CLAIM.test(what) && ++claims > 1) found = null;
  }
  return found;
}

/** The agent a waiting hand-off is kept for, where it is not `actor`'s agent: it is passed over. */
export function handedToOther(task: Item, actor: string): string | undefined {
  if (task.status !== 'open') return undefined;
  const h = handoffOf(task);
  if (!h?.to || h.model) return undefined;
  return h.to.toLowerCase() === signer(actor).agent.toLowerCase() ? undefined : h.to;
}

/** What the brief says at its top, where the thread was handed off to whoever builds it now. */
export function handoffBrief(task: Item): string[] {
  const h = handoffOf(task);
  if (!h) return [];
  const stop = /[.!?]$/.test(h.note) ? '' : '.';
  const at = h.at ? ` Its work so far is committed on the branch, at ${h.at.slice(0, 7)}: carry on from there.` : '';
  return [`HANDED OFF — ${h.by} stopped here${h.to ? `, for ${h.to}` : ''}: ${h.note}${stop}${at}`];
}

/** Commit whatever is not committed in the thread's worktree, with its trailer. The commit it is at now. */
function checkpoint(task: Item, note: string): string | undefined {
  if (!task.worktree) return undefined;
  const dir = worktreeDir(task);
  const status = git(dir, ['status', '--porcelain']);
  if (!status.ok) throw new SpoolError(`the worktree of ${task.id} could not be read: ${status.err}`);
  if (status.out) {
    const add = git(dir, ['add', '-A']);
    const message = `Hand-off checkpoint: ${oneLine(note, 60)}\n\nSpool: ${task.id}\n`;
    const made = add.ok ? git(dir, ['commit', '-q', '-m', message]) : add;
    if (!made.ok) throw new SpoolError(`the work in ${task.id}'s worktree could not be committed: ${made.err}`, `Commit it there yourself (cd ${dir}), then hand it off again.`);
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  return head.ok ? head.out : undefined;
}

export const HANDOFF: Command = {
  name: 'handoff',
  group: 'agents',
  usage: 'handoff <t-id> -m "<where it stopped>" [--to <agent or model>]',
  summary:
    'Out of usage mid-thread: checkpoint the work in its worktree, log where it stopped, and put it back in Build for another agent (--to Codex) or model (--to sonnet) to carry on from there',
  write: true,
  options: { message: { type: 'string', short: 'm' }, to: { type: 'string' } },
  run(call) {
    const { ws, actor } = call;
    const ref = call.args[0];
    if (!ref) throw new SpoolError('which thread?', 'spool handoff <t-id> -m "<where it stopped>"');
    const task = ws.get(ref, 'task');
    const note = (typeof call.opts.message === 'string' ? call.opts.message : call.args.slice(1).join(' ')).replace(/\s+/g, ' ').trim();
    if (!note) throw new SpoolError('where it stopped is missing', `The next agent starts from it: spool handoff ${task.id} -m "<what is done, what is left>"`);
    if (taskState(ws, task) !== 'active' && taskState(ws, task) !== 'stale') {
      throw new SpoolError(`${task.id} is not being built`, 'Only a thread being built is handed off; one in Build is taken as it is');
    }
    if (task.by && signer(task.by).agent.toLowerCase() !== signer(actor).agent.toLowerCase()) {
      throw new SpoolError(`${task.id} is being built by ${task.by}`, 'Only the agent building it hands it off');
    }
    const to = typeof call.opts.to === 'string' ? call.opts.to.trim() : '';
    const model = to ? modelNamed(to) : undefined;
    const roster = rosterOf(call.ctx, task.spool.root);
    const agent = to && !model ? roster.find((e) => e.name.toLowerCase() === to.toLowerCase()) : undefined;
    if (to && !model && !agent) {
      throw new SpoolError(`"${to}" is neither an agent on the roster nor a model`, `Name an agent (${roster.map((e) => e.name).join(', ')}) or a model (${LADDER.join(', ')}), or leave --to off for anyone`);
    }
    const at = checkpoint(task, note);
    const whom = agent?.name ?? model ?? '';
    addLog(task, actor, `handed off${whom ? ` to ${whom}` : ''}: ${note}${at ? ` (work so far at ${at.slice(0, 7)})` : ''}; back in build`, ws.now());
    task.status = 'open';
    task.by = undefined;
    ws.save(task, { actor, command: 'handoff' });
    const kept = task.worktree ? `\n  Its worktree is kept${at ? `, at ${at.slice(0, 7)}` : ''}: the next claim goes back into it.` : '';
    const forWhom = agent ? `only ${agent.name} is handed it` : model ? `the next claim is built on ${model}` : 'anyone may take it';
    return {
      text: `Handed off ${task.id}: back in Build, ${forWhom}.${kept}\n  Stop work on it now.`,
      data: { id: task.id, to: whom, model: model ?? '', at: at ?? '' },
    };
  },
};
