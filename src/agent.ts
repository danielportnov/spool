/**
 * Which model works a thread, and how hard it thinks.
 *
 * The agent command is the user's, from their own machine. A thread can say
 * which model and which effort it wants, as two plain words: the human's pick,
 * which always wins. Where it says nothing, its size does: the smallest model
 * that can do work of that size, to spare the plan's usage when several are
 * built at once. A thread whose last run did not work (its work was undone, or
 * the run ended without finishing) is built next by the model one up from the
 * one that ran it (`stepUp`), and its log says so.
 *
 * The words reach the command one of two ways. A command that names
 * `{model}` or `{effort}` has them put in its place. A `claude` command that
 * does not choose for itself gets `--model` and `--effort` added. Any other
 * command is run as it is: Spool does not know its flags. A chat that builds
 * is told the pick by the brief its claim prints, and starts the subagent that
 * builds the thread on it; the claim's log line says what it was told
 * (`builderLine`), so the next step up knows where it stood.
 *
 * The words come from files in the project, so they are checked here, at the
 * last moment, before they go near a shell: anything but a plain model name or
 * a known effort level is left out.
 */

import * as path from 'node:path';
import { type Item, type Size, SIZES, SpoolError, splitBody } from './model.ts';

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Pick {
  model?: string;
  effort?: Effort;
}

/**
 * What each size gets when the human does not say: the smallest model that can do it. Unsized
 * work is treated as medium. A tiny thread is a line or a value, and Haiku does it; a small one is
 * one function or screen, for Sonnet; from several files up it is Opus, thinking harder the more
 * the work cuts across. Fable is left for a thread Opus could not do (`stepUp`), or the human's pick.
 */
export const SUGGESTED: Record<Size, Required<Pick>> = {
  xs: { model: 'haiku', effort: 'medium' },
  s: { model: 'sonnet', effort: 'medium' },
  m: { model: 'opus', effort: 'medium' },
  l: { model: 'opus', effort: 'high' },
  xl: { model: 'opus', effort: 'xhigh' },
};

/** The models, smallest first: a thread whose run did not work goes one up. */
export const LADDER = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/** The least effort a thread that steps up to a model is given there: Fable is at its best from high. */
const LEAST_EFFORT: Partial<Record<(typeof LADDER)[number], Effort>> = { fable: 'high' };

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

/** A thread stepped up a model: the one that ran it last, why that run did not work, and whether that was already the biggest. */
export interface Step {
  from: string;
  reason: string;
  top: boolean;
}

/** What will run the thread, and why: "by its size", "as the thread says", "stepped up from haiku: …". */
export type Picked = Pick & { suggested: Pick; stepped?: Step; why: string };

/**
 * What will run the thread: what the human picked, then, where its last run did not work, the
 * model one up from that run's, then the size's suggestion for whatever is still open. A run
 * picked up again in its own session is given `ran`, the pick it was started with: it carries on
 * as it ran, and does not step up.
 */
export function pickFor(task: Item, routing: Routing, ran?: Pick): Picked {
  const suggested = suggestion(task, routing);
  const human = { model: safeModel(task.model), effort: safeEffort(task.effort) };
  const up = ran || human.model ? undefined : stepUp(task, routing);
  return {
    model: human.model ?? safeModel(ran?.model) ?? up?.model ?? suggested.model,
    effort: human.effort ?? safeEffort(ran?.effort) ?? up?.effort ?? suggested.effort,
    suggested,
    ...(up ? { stepped: { from: up.from, reason: up.reason, top: up.top } } : {}),
    why: up ? stepWhy(up) : human.model || human.effort ? 'as the thread says' : ran ? 'as it ran' : 'by its size',
  };
}

// ------------------------------------------------------------ stepping up

/** What a log line says, without its time and who said it. */
const said = (line: string): string => /^- \S+ \S+ .+?: (.*)$/.exec(line)?.[1] ?? '';

/** How a claim's log line names what a chat's subagent is to be started on. */
const BUILDER = 'builder model: ';

/** How a claim's log line names the model that builds the thread, where the claim said so. */
const BUILT = 'built on ';

/** The value of a command's `--name` flag. */
const flagOf = (command: string, name: string): string | undefined => new RegExp(`(?:^|\\s)--${name}[ =](\\S+)`).exec(command)?.[1];

/**
 * What a run was given, from the log line that started it: the command the page or the loop
 * handed it to, or the model a claim named for a chat's subagent. Nothing for any other line.
 */
function givenBy(what: string): Pick | undefined {
  const handed = /^handed to `(.*)`$/.exec(what)?.[1];
  if (handed !== undefined) return { model: safeModel(flagOf(handed, 'model')), effort: safeEffort(flagOf(handed, 'effort')) };
  if (what.startsWith(BUILT)) {
    const [model, effort] = what.slice(BUILT.length).split(/[,;]/)[0]!.split(' · ');
    return { model: safeModel(model?.trim()), effort: safeEffort(effort?.trim()) };
  }
  if (!what.startsWith(BUILDER)) return undefined;
  const [model, effort] = what.slice(BUILDER.length).split(',')[0]!.split(' · ');
  return { model: safeModel(model?.trim()), effort: safeEffort(effort?.trim()) };
}

/**
 * The model the thread's current run is on, where Spool knows it: the `--model` of the command
 * the page or the loop handed it to, or, for a chat's subagent, the model its claim named
 * ("builder model: opus · medium"). Nothing where the run was handed to a command that names
 * none, or the last claim left no line: an older run's model is not this one's.
 */
export function ranOn(task: Item): string | undefined {
  const lines = splitBody(task.body).log.map(said);
  for (let i = lines.length - 1; i >= 0; i--) {
    const given = givenBy(lines[i]!);
    if (given) return given.model;
    if (/^(started\b|picked up after)/.test(lines[i]!)) return undefined;
  }
  return undefined;
}

/**
 * Why the last run did not work, read from what happened to the thread after it was given out,
 * or nothing where it did. Two things count: its work was undone (reverted, or taken back from
 * done), and it ended without finishing (its agent left, whether or not its check had failed).
 * The human stopping or aborting a run does not: that is their call, and a stopped run carries
 * on as it ran. Nor does a question: the thread waits on them, not on a better model.
 */
function setback(after: string[]): string | undefined {
  let done = false;
  let why: string | undefined;
  for (const what of after) {
    if (what.startsWith('done: ')) done = true;
    // The work being put back after an undo is the undo undone, not a failed run.
    if (/^put the work back/.test(what)) why = undefined;
    else if (/\breverted \d+ commit/.test(what) || (done && /^moved back to /.test(what))) why = 'its last run was undone';
    else if (/^agent .* without finishing/.test(what)) why = 'its last run ended without finishing';
  }
  return why;
}

/** The rung of the ladder a model is on, by its alias or a full id that names it, or -1. */
const rung = (model: string): number => LADDER.findIndex((m) => model.toLowerCase().includes(m));

/** The highest of some efforts. */
const highest = (...efforts: (Effort | undefined)[]): Effort =>
  efforts.reduce<Effort>((top, e) => (e && EFFORTS.indexOf(e) > EFFORTS.indexOf(top) ? e : top), 'low');

/** A step up: the model and effort it gives, and the step itself. */
export type Up = Required<Pick> & Step;

/**
 * The model one up from the one that last ran the thread, where that run did not work: Haiku to
 * Sonnet, Sonnet to Opus, Opus to Fable; a thread Fable could not do stays on Fable. It thinks at
 * least as hard as it did, and as hard as its size gives. Where the log does not say which model
 * ran it, the step is up from what its size gives. Nothing where the last run worked, or there
 * has been none.
 */
export function stepUp(task: Item, routing: Routing): Up | undefined {
  if (routing === false) return undefined;
  const lines = splitBody(task.body).log.map(said);
  const at = lines.findLastIndex((what) => !!givenBy(what));
  if (at < 0) return undefined;
  const reason = setback(lines.slice(at + 1));
  if (!reason) return undefined;
  const ran = givenBy(lines[at]!)!;
  const size = suggestion(task, routing);
  const from = ran.model ?? size.model ?? '';
  const on = rung(from);
  if (on < 0) return undefined;
  const top = on === LADDER.length - 1;
  const model = LADDER[top ? on : on + 1]!;
  return { model, effort: highest(ran.effort, size.effort, LEAST_EFFORT[model]), from, reason, top };
}

const stepWhy = (up: Step): string => `${up.top ? 'kept on the biggest model' : `stepped up from ${up.from}`}: ${up.reason}`;

/**
 * The log line that says a thread stepped up, just before the line that hands it out:
 * "stepped up from haiku to sonnet · medium: its last run was undone".
 */
export function stepNote(pick: Picked): string | undefined {
  const up = pick.stepped;
  if (!up) return undefined;
  const to = pickLabel(pick);
  return `${up.top ? `kept on ${to}, the biggest model` : `stepped up from ${up.from} to ${to}`}: ${up.reason}`;
}

/**
 * The log line a claim leaves, saying what the subagent that builds the thread is to be started
 * on: "builder model: sonnet · medium, by its size". The next step up reads it back. Nothing
 * where there is no pick to say.
 */
export function builderLine(pick: Picked, ran?: string): string | undefined {
  const suggested = pick.model || pick.effort ? `${pickLabel(pick)}, ${pick.why}` : '';
  // What the claim says it is built on is the fact; what Spool would pick stays beside it, as its suggestion.
  if (ran) return `${BUILT}${ran}${suggested ? `; Spool suggested ${suggested}` : ''}`;
  return suggested ? `${BUILDER}${suggested}` : undefined;
}

// ------------------------------------------------------------ who signs

/** Words that name a model, after an agent's own name: "Claude Opus 5.5", "Codex GPT-6". */
const MODEL_WORD = /^(opus|sonnet|haiku|fable|claude-|gpt|o\d|gemini|grok|llama|mistral|qwen|deepseek|\d)/i;

/**
 * An agent's name and the model in it, where it names one: "Claude Opus 5.5" is Claude on
 * opus-5.5, "Codex GPT-6" is Codex on gpt-6, "Codex" is Codex on nothing it says.
 */
export function signer(name: string): { agent: string; model?: string } {
  const words = name.trim().split(/\s+/);
  const at = words.findIndex((w, i) => i > 0 && MODEL_WORD.test(w));
  if (at < 0) return { agent: name.trim() };
  const model = words.slice(at).join('-').toLowerCase();
  return { agent: words.slice(0, at).join(' '), model: safeModel(model) };
}

/** Names that are not an agent's: the human, Spool's own page and loop, and nobody. */
const NOT_AGENTS = new Set(['human', 'page', 'loop', 'agent', '']);

/**
 * Who a line is signed by, on a thread claimed by `by`: a command nobody signed (`given` is
 * undefined) signs as the claimer, and an agent that signs as itself in another form ("Codex"
 * for "Codex GPT-6", or the other way) signs as the claimer too, so a thread has one name per
 * agent. Anyone else signs as they said.
 */
export function signAs(given: string | undefined, by: string | undefined, fallback: string): string {
  const claimer = by?.trim() ?? '';
  if (NOT_AGENTS.has(claimer.toLowerCase())) return given ?? fallback;
  if (given === undefined || given.trim().toLowerCase() === 'agent') return claimer;
  if (NOT_AGENTS.has(given.trim().toLowerCase())) return given;
  return signer(given).agent.toLowerCase() === signer(claimer).agent.toLowerCase() ? claimer : given;
}

/** Whether an agent command takes the pick at all: a `claude` command, or one that names `{model}` or `{effort}`. */
export function takesPick(base: string): boolean {
  if (/\{model\}|\{effort\}/.test(base)) return true;
  return path.basename(base.trim().split(/\s+/)[0] ?? '') === 'claude';
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
