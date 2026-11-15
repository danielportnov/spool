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
 * "On hold" is different: it is the human saying not yet. An idea to keep but
 * not start, work parked behind a launch. It waits for their word and asks
 * nothing of them in the meantime.
 */

import { flowStrings, flowTokens, parseFrontmatter, quote } from './frontmatter.ts';

export type Kind = 'note' | 'task' | 'decision' | 'skill';

export const KINDS: Record<Kind, { prefix: string; statuses: readonly string[]; initial: string }> = {
  note: { prefix: 'n', statuses: ['new', 'filed', 'dropped'], initial: 'new' },
  task: { prefix: 't', statuses: ['open', 'active', 'done', 'dropped'], initial: 'open' },
  decision: { prefix: 'd', statuses: ['open', 'assumed', 'decided', 'dropped'], initial: 'open' },
  skill: { prefix: 's', statuses: ['active', 'dropped'], initial: 'active' },
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
}

export interface Item {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  /** Tasks: 0 (drop everything) to 3 (someday). */
  priority?: number;
  /** Tasks: how much would have to change. Unsized work is treated as medium. */
  size?: Size;
  /** Tasks: what finishing produces. Absent means a change. */
  type?: WorkType;
  created: string;
  updated: string;
  /** Tasks: when it was last claimed. The scheduler reads these to pace large work. */
  started?: string;
  /** Who holds it: the claimer of a task, the chooser of a decision, the author of a skill. */
  by?: string;
  /** Tasks: why this is parked. A task on hold is never handed out; only the human releases it. */
  hold?: string;
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
  /** Tasks: the commits that did the work — the handle `spool revert` pulls. */
  commits: string[];
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
  ['size', 'string'],
  ['type', 'string'],
  ['created', 'string'],
  ['updated', 'string'],
  ['started', 'string'],
  ['by', 'string'],
  ['hold', 'string'],
  ['needs', 'tokens'],
  ['from', 'tokens'],
  ['options', 'strings'],
  ['recommend', 'int'],
  ['choice', 'string'],
  ['summary', 'string'],
  ['commits', 'tokens'],
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
  const record: Record<string, unknown> = { needs: [], from: [], options: [], commits: [], skills: [] };
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
