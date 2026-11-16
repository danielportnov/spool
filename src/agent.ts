/**
 * Which model works a thread, and how hard it thinks.
 *
 * The agent command is the user's, from their own machine. A thread can only
 * say which model and which effort it wants, as two plain words, and a thread
 * that says nothing gets the one its size suggests: a one-line fix does not
 * need the biggest model thinking its hardest, and a large change deserves it.
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

/** What each size gets when the thread does not say. Unsized work is treated as medium. */
export const SUGGESTED: Record<Size, Required<Pick>> = {
  xs: { model: 'haiku', effort: 'low' },
  s: { model: 'sonnet', effort: 'medium' },
  m: { model: 'opus', effort: 'high' },
  l: { model: 'opus', effort: 'xhigh' },
  xl: { model: 'fable', effort: 'high' },
};

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

/** What will run the thread: what it says it wants, and the size's suggestion for the rest. */
export function pickFor(task: Item, routing: Routing): Pick & { suggested: Pick } {
  const suggested = suggestion(task, routing);
  return {
    model: safeModel(task.model) ?? suggested.model,
    effort: safeEffort(task.effort) ?? suggested.effort,
    suggested,
  };
}

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
