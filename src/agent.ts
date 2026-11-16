/**
 * Which model works a thread, and how hard it thinks.
 *
 * The agent command is the user's, from their own machine. A thread can say
 * which model and which effort it wants, as two plain words: the human's pick,
 * which always wins. Where it says nothing and the agent is Claude, the thread
 * is first passed to Fable, which reads its brief and decides which model works
 * it and how hard it thinks, leaning bigger and heavier than it seems to need;
 * it may take the thread itself. Where Fable cannot answer, or the user turned
 * it off, the size suggests a pick, again on the big side.
 *
 * The words reach the command one of two ways. A command that names
 * `{model}` or `{effort}` has them put in its place. A `claude` command that
 * does not choose for itself gets `--model` and `--effort` added. Any other
 * command is run as it is: Spool does not know its flags.
 *
 * The words come from files in the project, so they are checked here, at the
 * last moment, before they go near a shell: anything but a plain model name or
 * a known effort level is left out.
 */

import * as path from 'node:path';
import { type Item, type Size, SIZES, SpoolError } from './model.ts';

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Pick {
  model?: string;
  effort?: Effort;
}

/**
 * What each size gets when neither the human nor Fable says. Unsized work is
 * treated as medium. Every row leans a step bigger than the work looks: a
 * thread given too little does it badly, and one given too much only costs more.
 */
export const SUGGESTED: Record<Size, Required<Pick>> = {
  xs: { model: 'sonnet', effort: 'medium' },
  s: { model: 'opus', effort: 'high' },
  m: { model: 'opus', effort: 'xhigh' },
  l: { model: 'fable', effort: 'high' },
  xl: { model: 'fable', effort: 'xhigh' },
};

/** The model that reads a thread first and decides who works it, and how hard it thinks doing so. */
export const ROUTER = 'fable';
const ROUTER_EFFORT: Effort = 'high';

/** The user's own say, from their config: their table by size, or `false` for no suggestion at all. */
export type Routing = false | Partial<Record<Size, { model?: string; effort?: string }>> | undefined;

/** A model alias or full name: letters, digits, dots, dashes, and an optional `[1m]`. Nothing a shell reads. */
const MODEL_NAME = /^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$/i;

export function modelOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  if (v === 'none') return '';
  if (!MODEL_NAME.test(v)) throw new SpoolError(`"${v}" is not a model name`, `Try one of ${MODELS.join(', ')}, or a full model id.`);
  return v;
}

export function effortOf(value: unknown): Effort | '' | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'none') return '';
  if (!(EFFORTS as readonly string[]).includes(v)) throw new SpoolError(`effort must be one of ${EFFORTS.join(', ')}`);
  return v as Effort;
}

const safeModel = (v: unknown): string | undefined => (typeof v === 'string' && MODEL_NAME.test(v) ? v : undefined);
const safeEffort = (v: unknown): Effort | undefined =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined;

/** What the thread's size suggests, by the user's table where they have one. */
export function suggestion(task: Item, routing: Routing): Pick {
  if (routing === false) return {};
  const size: Size = task.size && SIZES.includes(task.size) ? task.size : 'm';
  const theirs = routing?.[size];
  return {
    model: safeModel(theirs?.model) ?? SUGGESTED[size].model,
    effort: safeEffort(theirs?.effort) ?? SUGGESTED[size].effort,
  };
}

/**
 * What will run the thread: what the human picked, then what Fable decided,
 * then the size's suggestion for whatever is still open.
 */
export function pickFor(task: Item, routing: Routing, routed?: Pick): Pick & { suggested: Pick } {
  const suggested = suggestion(task, routing);
  return {
    model: safeModel(task.model) ?? safeModel(routed?.model) ?? suggested.model,
    effort: safeEffort(task.effort) ?? safeEffort(routed?.effort) ?? suggested.effort,
    suggested,
  };
}

/** The user's say on routing, from their config: another model to route with, or `false` for the size table only. */
export type RouterSetting = false | string | undefined;

/**
 * The command that asks Fable to choose, or nothing where there is nothing to
 * ask: the agent is not Claude, the user switched routing or picking off, or
 * the human already picked both the model and the effort.
 */
export function routerCommand(base: string, task: Item, routing: Routing, router: RouterSetting): string | undefined {
  if (routing === false || router === false) return undefined;
  if (safeModel(task.model) && safeEffort(task.effort)) return undefined;
  if (/\{model\}|\{effort\}/.test(base)) return undefined;
  const program = base.trim().split(/\s+/)[0] ?? '';
  if (path.basename(program) !== 'claude') return undefined;
  return `${program} -p --model ${safeModel(router) ?? ROUTER} --effort ${ROUTER_EFFORT}`;
}

/** What Fable is asked: the thread's brief, what the human already fixed, and how to answer. */
export function routerPrompt(task: Item, brief: string): string {
  const fixed = [
    safeModel(task.model) && `The human already chose the model: ${task.model}. Keep it, and choose the effort.`,
    safeEffort(task.effort) && `The human already chose the effort: ${task.effort}. Keep it, and choose the model.`,
  ].filter(Boolean);
  return `You are choosing which Claude model works one thread of a coding project, and how hard it thinks.
Do not work the thread, and do not run anything: read the brief below and choose.

Models, biggest first: ${MODELS.join(', ')} (or a full model id). Efforts, lowest first: ${EFFORTS.join(', ')}.
You are ${ROUTER}; you may take the thread yourself.

Always lean bigger and toward heavier thinking than you think the thread needs. Between two
models, take the bigger; between two efforts, take the higher. A thread given too little is done
badly; one given too much only costs a little more.
${fixed.length ? `\n${fixed.join('\n')}\n` : ''}
Answer with one line of JSON and nothing else:
{"model": "<model>", "effort": "<effort>", "why": "<one short sentence>"}

THE THREAD

${brief}
`;
}

export type Route = Pick & { why?: string };

/** Fable's answer, read from what it printed: the last JSON object in it, with only plain words kept. */
export function parseRoute(out: string): Route | undefined {
  for (const raw of (out.match(/\{[^{}]*\}/g) ?? []).reverse()) {
    try {
      const v = JSON.parse(raw) as { model?: unknown; effort?: unknown; why?: unknown };
      const model = safeModel(typeof v.model === 'string' ? v.model.trim().toLowerCase() : undefined);
      const effort = safeEffort(typeof v.effort === 'string' ? v.effort.trim().toLowerCase() : undefined);
      if (!model && !effort) continue;
      const why = typeof v.why === 'string' ? v.why.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      return { model, effort, ...(why ? { why } : {}) };
    } catch {
      // Not JSON after all; look at the one before.
    }
  }
  return undefined;
}

/** The log line that says what Fable chose and why, or that it could not. */
export function routeNote(routed: Route | undefined, how?: string): string {
  if (!routed) return `${ROUTER} could not choose${how ? ` (${how})` : ''}; going by its size`;
  return `${ROUTER} chose ${pickLabel(routed)}${routed.why ? `: ${routed.why}` : ''}`;
}

/** How long Fable gets to choose before the size decides instead. */
export const ROUTE_TIMEOUT_MS = 5 * 60 * 1000;

/** The user's command, with the pick put in it where it can be. */
export function commandFor(base: string, pick: Pick): string {
  const model = safeModel(pick.model);
  const effort = safeEffort(pick.effort);
  if (/\{model\}|\{effort\}/.test(base)) {
    return base
      .replace(/(--model[ =])?\{model\}/g, (_, flag: string | undefined) => (model ? `${flag ?? ''}${model}` : ''))
      .replace(/(--effort[ =])?\{effort\}/g, (_, flag: string | undefined) => (effort ? `${flag ?? ''}${effort}` : ''))
      .replace(/\s+/g, ' ')
      .trim();
  }
  const program = path.basename(base.trim().split(/\s+/)[0] ?? '');
  if (program !== 'claude') return base;
  let command = base.trim();
  if (model && !/(^|\s)--model(\s|=)/.test(command)) command += ` --model ${model}`;
  if (effort && !/(^|\s)--effort(\s|=)/.test(command)) command += ` --effort ${effort}`;
  return command;
}

/** How a pick reads to a person: "opus · high". */
export function pickLabel(pick: Pick): string {
  return [pick.model, pick.effort].filter(Boolean).join(' · ');
}
