/**
 * The schema. Four kinds of item, each a markdown file with typed frontmatter.
 *
 *   note      what the human said, verbatim            new → filed | dropped
 *   task      something to do                           open → active → done | dropped
 *   decision  a question and, eventually, its answer    open | assumed → decided | dropped
 *   skill     a procedure an agent wrote down           active | dropped
 *
 * Not all work is a change to the code. A task has a type, which says what
 * finishing it produces:
 *
 *   change    commits                                   (the default)
 *   audit     a report, and its findings filed as tasks
 *   plan      a plan, and its parts filed as tasks
 *
 * and a size, xs to xl, which says how much would have to change. Size is what
 * lets the queue favour quick wins without starving the large work.
 *
 * Items point at each other: `from` is provenance (a task from a note, rework
 * from a decision, a skill from the task that taught it) and `needs` is what
 * must be settled first. Together they make the store a small typed graph.
 *
 * "Blocked" is not a status. It is computed from `needs` every time, so it
 * cannot go stale: answer a question and everything behind it is ready.
 *
 * "Proposed" is a status, and it is the gate. In a project that has the gate
 * on, every new task starts proposed and no agent can claim it: only the human
 * moves it to build. That is how they decide what gets built.
 *
 * "On hold" is different: it is the human saying not yet. An idea to keep but
 * not start, work parked behind a launch. It waits for their word and asks
 * nothing of them in the meantime.
 */

import { flowStrings, flowTokens, parseFrontmatter, quote } from './frontmatter.ts';

export type Kind = 'note' | 'task' | 'decision' | 'skill' | 'sprint';

export const KINDS: Record<Kind, { prefix: string; statuses: readonly string[]; initial: string }> = {
  note: { prefix: 'n', statuses: ['new', 'filed', 'dropped'], initial: 'new' },
  task: { prefix: 't', statuses: ['proposed', 'open', 'active', 'done', 'dropped'], initial: 'open' },
  decision: { prefix: 'd', statuses: ['open', 'assumed', 'decided', 'dropped'], initial: 'open' },
  skill: { prefix: 's', statuses: ['active', 'dropped'], initial: 'active' },
  // A sprint is a named set of tasks the human means to build together. It has no dates: agents
  // work in hours, so a sprint is over when its tasks are done, not when a fortnight is.
  sprint: { prefix: 'r', statuses: ['planned', 'running', 'done', 'dropped'], initial: 'planned' },
};

export const KIND_NAMES = Object.keys(KINDS) as Kind[];

export const SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type Size = (typeof SIZES)[number];

export const TYPES = ['change', 'audit', 'plan'] as const;
export type WorkType = (typeof TYPES)[number];

/** One project's `.spool/` directory. */
export interface Spool {
  /** The project directory that holds `.spool/`. */
  root: string;
  /** `<root>/.spool`. */
  dir: string;
  /** How the project is addressed: its path from the workspace home, or its own name at home. */
  name: string;
  /** True for the spool the command was run from; the rest are nested projects. */
  home: boolean;
  config: Config;
}

/** `.spool/config.json`. Declarative only — nothing in a repo's config is ever executed. */
export interface Config {
  version: number;
  name?: string;
  /** One line on what this project is, so a recorder can route feedback to it. */
  about?: string;
  /** Hours before an untouched claim is offered to someone else. Default 4. */
  leaseHours?: number;
  /** How deep to look for nested projects. Default 4. */
  depth?: number;
  /** Directory names never searched for nested projects. */
  ignore?: string[];
  /** Where new skills are written, relative to the project. Default `.claude/skills`. */
  skillsDir?: string;
  /** One pick in this many goes to large work, however many quick wins are waiting. Default 4. */
  largeEvery?: number;
  /**
   * The build gate. When on, every new task starts proposed, and nothing is
   * built until the human moves it to build. `spool init --gate` turns it on.
   *
   * 'locked' goes one step further (`spool init --lock`): the commands that
   * start work are refused unless a person ran them, at their own terminal or
   * from the Spool page. An agent told "build that" in a chat can no longer do
   * it itself; it hands the human the page.
   */
  gate?: boolean | 'locked';
}

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  /** Tasks: 0 (drop everything) to 3 (someday). */
  priority?: number;
  /**
   * Tasks in build: the place in line the human gave it, 1 first. Placed work is built before
   * anything the usual rule orders. Leaving build clears it.
   */
  place?: number;
  /** Tasks: how much would have to change. Unsized work is treated as medium. */
  size?: Size;
  /** Tasks: what finishing produces. Absent means a change. */
  type?: WorkType;
  /** Tasks: the model the human chose to work it, over what its size suggests. See agent.ts. */
  model?: string;
  /** Tasks: how hard that model thinks: low, medium, high, xhigh or max. */
  effort?: string;
  created: string;
  updated: string;
  /** Tasks: when it was last claimed. The scheduler reads these to pace large work. */
  started?: string;
  /** Who holds it: the claimer of a task, the chooser of a decision, the author of a skill. */
  by?: string;
  /**
   * Tasks: the folder it is built in, relative to the project, where it has a git worktree of its
   * own: the project's folder inside `.spool/worktrees/<id>`. See worktree.ts.
   */
  worktree?: string;
  /** Tasks: the branch that worktree is on, `spool/<id>`, until its work lands. */
  branch?: string;
  /** Tasks: why this is parked. A task on hold is never handed out; only the human releases it. */
  hold?: string;
  /**
   * Tasks: when it was put out of sight. An archived thread is not dropped: it keeps its status,
   * its hold and its sprint, and leaves the board, the lists and the counts until it is brought
   * back. It is never handed out. Moving it to build brings it back.
   */
  archived?: string;
  /**
   * Tasks: an agent's own idea, and why it suggests it. Nobody asked for it, so it starts on hold
   * and joins the work only when the human says yes. The reason stays, as where the thread came from.
   */
  suggested?: string;
  /** Ids that must be settled before this task is ready. */
  needs: string[];
  /** Ids this item came from. */
  from: string[];
  /** Decisions: the choices offered. */
  options: string[];
  /** Decisions: 1-based index of the option the agent would pick. */
  recommend?: number;
  /** Decisions: the answer. */
  choice?: string;
  /** Tasks: what changed, in a sentence, for the human's review. */
  summary?: string;
  /**
   * Tasks: how a person sees the change working, as two or three short steps they can follow in a
   * minute ("Open the board", "Drag a card up"). Read at review, so they are written for someone who
   * has not seen the code.
   */
  steps: string[];
  /** Tasks: the commits that did the work — the handle `spool revert` pulls. */
  commits: string[];
  /** Tasks: labels the human or an agent put on it, to group and find work by. */
  tags: string[];
  /** Tasks: the version it is meant for, or shipped in. */
  version?: string;
  /** Tasks: the sprint it has been put in, by id. */
  sprint?: string;
  /** Tasks: the project's check that passed before this was finished, as the command that was run. */
  checked?: string;
  /** Tasks: names of the skills used. */
  skills: string[];
  /** When the human acknowledged a finished task, an assumption or a new skill. */
  reviewed?: string;
  /** Skills: the skill's directory, relative to the project. */
  path?: string;
  /** Skills: how many finished tasks used it. */
  uses?: number;
  /** Skills: when it was last used. */
  used?: string;
  body: string;
  /** Frontmatter lines Spool does not own, written back untouched. */
  extra: string[];
  spool: Spool;
}

type FieldType = 'string' | 'int' | 'tokens' | 'strings';

/** Every field Spool owns, in the order it is written. */
const FIELDS: readonly (readonly [string, FieldType])[] = [
  ['id', 'string'],
  ['kind', 'string'],
  ['title', 'string'],
  ['status', 'string'],
  ['priority', 'int'],
  ['place', 'int'],
  ['size', 'string'],
  ['type', 'string'],
  ['model', 'string'],
  ['effort', 'string'],
  ['created', 'string'],
  ['updated', 'string'],
  ['started', 'string'],
  ['by', 'string'],
  ['worktree', 'string'],
  ['branch', 'string'],
  ['hold', 'string'],
  ['archived', 'string'],
  ['suggested', 'string'],
  ['needs', 'tokens'],
  ['from', 'tokens'],
  ['options', 'strings'],
  ['recommend', 'int'],
  ['choice', 'string'],
  ['summary', 'string'],
  ['steps', 'strings'],
  ['commits', 'tokens'],
  ['tags', 'tokens'],
  ['version', 'string'],
  ['sprint', 'string'],
  ['checked', 'string'],
  ['skills', 'tokens'],
  ['reviewed', 'string'],
  ['path', 'string'],
  ['uses', 'int'],
  ['used', 'string'],
];

const OWNED = new Set(FIELDS.map(([key]) => key));

export class SpoolError extends Error {
  hint?: string;
  code: number;
  constructor(message: string, hint?: string, code = 1) {
    super(message);
    this.hint = hint;
    this.code = code;
  }
}

export function serialize(item: Item): string {
  const record = item as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const [key, type] of FIELDS) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (type === 'int') lines.push(`${key}: ${value as number}`);
    else if (type === 'string') {
      if (value !== '') lines.push(`${key}: ${quote(value as string)}`);
    } else if ((value as string[]).length) {
      lines.push(`${key}: ${type === 'tokens' ? flowTokens(value as string[]) : flowStrings(value as string[])}`);
    }
  }
  lines.push(...item.extra);
  return `---\n${lines.join('\n')}\n---\n\n${item.body.trim()}\n`;
}

/** Parse an item file. Throws a plain Error describing what is wrong with it. */
export function deserialize(text: string, spool: Spool): Item {
  const fm = parseFrontmatter(text);
  if (!fm.found) throw new Error('no frontmatter');
  const record: Record<string, unknown> = { needs: [], from: [], options: [], steps: [], commits: [], skills: [], tags: [] };
  for (const [key, type] of FIELDS) {
    const value = fm.data.get(key);
    if (value === undefined) continue;
    if (type === 'tokens' || type === 'strings') {
      record[key] = Array.isArray(value) ? value : value === '' ? [] : [value];
    } else {
      const text = Array.isArray(value) ? value.join(', ') : value;
      if (type === 'int') {
        const n = Number(text);
        if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number, got "${text}"`);
        record[key] = n;
      } else {
        record[key] = text;
      }
    }
  }
  const item = record as unknown as Item;
  for (const key of ['id', 'kind', 'title', 'status', 'created'] as const) {
    if (!item[key]) throw new Error(`missing ${key}`);
  }
  const spec = KINDS[item.kind];
  if (!spec) throw new Error(`unknown kind "${String(item.kind)}"`);
  if (!spec.statuses.includes(item.status)) {
    throw new Error(`a ${item.kind} cannot be "${item.status}" (expected ${spec.statuses.join(', ')})`);
  }
  if (item.size && !SIZES.includes(item.size)) throw new Error(`size "${item.size}" must be one of ${SIZES.join(', ')}`);
  if (item.type && !TYPES.includes(item.type)) throw new Error(`type "${item.type}" must be one of ${TYPES.join(', ')}`);
  if (item.type === 'change') item.type = undefined;
  item.updated ||= item.created;
  item.extra = [...fm.raw].filter(([key]) => !OWNED.has(key)).map(([, lines]) => lines);
  item.body = fm.body.trim();
  item.spool = spool;
  return item;
}

// ------------------------------------------------------------------ bodies

/**
 * An item's body is free markdown followed by an append-only `## Log` — the
 * memory one agent leaves for the next.
 */
export function splitBody(body: string): { main: string; log: string[] } {
  const at = body.search(/^## Log[ \t]*$/m);
  if (at < 0) return { main: body.trim(), log: [] };
  const log = body
    .slice(at)
    .split('\n')
    .slice(1)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  return { main: body.slice(0, at).trim(), log };
}

export function joinBody(main: string, log: string[]): string {
  return [main.trim(), log.length ? `## Log\n${log.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

export function addLog(item: Item, actor: string, text: string, now: Date): void {
  const { main, log } = splitBody(item.body);
  const stamp = timestamp(now).replace('T', ' ').replace(/:\d\d\.\d+Z$/, 'Z');
  log.push(`- ${stamp} ${actor}: ${text.replace(/\s+/g, ' ').trim()}`);
  item.body = joinBody(main, log);
}

export function setMain(item: Item, main: string): void {
  item.body = joinBody(main, splitBody(item.body).log);
}

export function appendMain(item: Item, block: string): void {
  const { main, log } = splitBody(item.body);
  item.body = joinBody([main, block.trim()].filter(Boolean).join('\n\n'), log);
}

// ------------------------------------------------------------------- misc

/** To the millisecond: agents file things in bursts, and creation order is the order everything is listed in. */
export function timestamp(date: Date): string {
  return date.toISOString();
}

export function isPlan(item: Item | undefined): item is Item {
  return !!item && item.kind === 'task' && item.type === 'plan';
}

/** The tag on the thread of a manager's run. */
export const RUN_TAG = 'manage';

/**
 * The thread of a manager's run (manage.ts): an audit that is open while the backlog is being
 * put in order, holds the report afterwards, and is the id the whole run is undone by. It is
 * the manager's own, so it is never handed to a worker, and is no part of the backlog it tidies.
 */
export function isRun(item: Item): boolean {
  return item.kind === 'task' && item.type === 'audit' && item.tags.includes(RUN_TAG);
}

/**
 * Settled items no longer hold anything up. A plan is the exception that makes
 * plans useful: work that `needs` one waits until the human has approved it.
 */
export function isSettled(item: Item): boolean {
  if (isPlan(item) && item.status === 'done') return !!item.reviewed;
  return ['done', 'decided', 'assumed', 'dropped', 'filed'].includes(item.status);
}

/** Where the report of an audit or plan is kept: beside the items, named for its task. */
export function reportFile(item: Item): string {
  return `${item.spool.dir}/reports/${item.id}.md`;
}

export function isClosed(item: Item): boolean {
  return ['done', 'decided', 'dropped', 'filed'].includes(item.status);
}

export function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The `Why:` line of a thread's spec: the reason it exists, so the human can agree to it without
 * opening it. It reads the same labels the page's description does (`aboutOf` in board.ts). The
 * human's own words are quoted (`>`) and never read as the spec, and a reason that runs on over
 * a few lines is taken whole, up to the next blank line or the next label.
 */
export function whyOf(item: Item): string {
  const lines = splitBody(item.body).main.split('\n');
  const label = /^\s*(?:[-*]\s+)?\**([A-Za-z][A-Za-z ]{0,18}?)\**:\s*(.*)$/;
  const at = lines.findIndex((l) => /^(why|benefits?|so that)$/i.test(label.exec(l)?.[1]?.trim() ?? ''));
  if (at < 0) return '';
  const out = [label.exec(lines[at]!)![2]!.replace(/^\*+\s*/, '')];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || line.startsWith('>') || label.test(line)) break;
    out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(
  (
    'the and for with that this from when use used using into your you are was were but not has have had its ' +
    'can will should would could too very more most like feels feel just than then them they what which who how ' +
    'about make makes need needs want wants there here some any all out get got also really kind thing things ' +
    'think maybe little bit lot way still even much many when where while been being does did done'
  ).split(' '),
);

/** Lowercased content words, crudely stemmed. Good enough to spot "the same thing again". */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOP.has(word)) continue;
    const stem = word.replace(/(ing|ed|es|s)$/, '');
    out.add(stem.length >= 3 ? stem : word);
  }
  return out;
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
