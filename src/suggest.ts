/**
 * Suggesting skills: noticing a procedure that keeps being worked out again.
 *
 * An agent that does a multi-step job is asked to write it down, but it sees
 * only its own task. The queue sees all of them. When several finished tasks
 * describe themselves in the same words ("build, bump the version, tag") and
 * none of them used a skill, somebody keeps working that out from scratch,
 * and this is where Spool says so.
 *
 * It finds repetition and nothing more. It cannot know the steps, so it never
 * writes a skill: it names the tasks and the words they share. An agent reads
 * that and, where it agrees, offers it to the human as an AI-suggested thread,
 * the way anything nobody asked for is offered. On their yes an agent writes
 * the steps down. Their no is a dropped thread, and it is not raised again.
 *
 * Matching is lexical on purpose: the crude stems `matchSkills` uses, no model
 * and no network, the same answer every time. So one procedure written up in
 * different words is missed, and three tasks on one subject can pass for a
 * procedure. Matching by meaning is a separate, later piece of work. Until
 * then the thresholds below lean towards staying quiet, and an agent reads
 * every candidate before a person does.
 */

import * as path from 'node:path';
import { type Item, type Spool, splitBody, tokens } from './model.ts';
import type { Workspace } from './store.ts';

/** The thresholds, in one place so they are easy to change. */
export const SUGGEST = {
  /** Finished tasks that must show the same steps. Twice is a coincidence. */
  minTasks: 3,
  /** Telling terms every one of them must share. One or two shared words is a subject, not a procedure. */
  minTerms: 4,
  /**
   * A term tells of a group only if at least this share of the finished tasks that use it are in
   * the group. "version" in three release tasks and nowhere else is evidence; "screen" in those
   * three and twenty others is the project talking.
   */
  belongs: 0.5,
  /** Only the most recent finished tasks are compared: what was done long ago is history, and this runs on every `done`. */
  recent: 200,
  /** Terms named for a candidate, most telling first. */
  termsShown: 8,
} as const;

export interface Candidate {
  /** Where the skill would live: the deepest project that holds every task it was seen in. */
  spool: Spool;
  /** The finished tasks that show it, oldest first. */
  tasks: Item[];
  /** What they all share, rarest in the project first, in the words of the oldest task. */
  terms: string[];
}

/**
 * Words any write-up of any work uses: what was done to it in general, the
 * queue's own nouns, and the small words `tokens` lets through. Sharing them
 * is no evidence of a shared procedure.
 */
const GENERIC = stems(
  'add added fix fixed change changed update updated remove removed new now see show shown ' +
    'work works task tasks thread threads spool commit commits test tests pass check file files code human agent ' +
    'one two three four first second last next each every both either neither other another same own such ' +
    'never always ever often once again already yet only instead rather else ' +
    'nothing something anything everything none nobody someone anyone everyone ' +
    'before after until since because why whether though although unless ' +
    'through under over between within without above below behind beside onto off down back ' +
    'say says said tell tells told ask asks know knows give gives take takes put keep keeps let goes come comes ' +
    'does doing can cannot may might must shall its their his her our whose those these',
);

/**
 * One word to its stem. `tokens` leaves "release" and "released" apart, and
 * "tag" and "tagged"; write-ups mix tenses, so fold a final e and a doubled
 * consonant as well. Still crude, still lexical.
 */
function stem(word: string): string | undefined {
  const [base] = tokens(word);
  if (!base) return undefined;
  const folded = base.replace(/e$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return folded.length >= 3 ? folded : base;
}

function stems(text: string): Set<string> {
  return new Set(text.split(' ').map(stem).filter((s): s is string => !!s));
}

/** Log lines Spool writes itself, and the human's words it quotes. Only what an agent noted about the work counts. */
const BOOKKEEPING =
  /^(started$|builder model: |built on |picked up after the last claim|done: |edited: |put on hold: |released from hold|approved|dropped|reverted \d+ commit|put the work back|waiting on d-|assumed d-|d-\w+ changed: )/;

function notes(task: Item): string[] {
  return splitBody(task.body)
    .log.map((line) => /^- \d{4}-\d\d-\d\d \d\d:\d\dZ .*?: (.*)$/.exec(line)?.[1] ?? line)
    .filter((text) => !BOOKKEEPING.test(text));
}

interface Doc {
  task: Item;
  /** Stem to the word as this task wrote it. */
  said: Map<string, string>;
  terms: Set<string>;
}

/**
 * What a finished task says about how it was done: its title, its summary and
 * the notes left in its log. Not its body: that is the human's request, and
 * tasks cut from one piece of feedback share its words without sharing steps.
 */
function read(task: Item): Doc {
  const text = [task.title, task.summary ?? '', ...notes(task)].join('\n').toLowerCase();
  const said = new Map<string, string>();
  // Ids are names, not vocabulary: two tasks that mention the same decision have not done the same thing.
  for (const word of text.replace(/\b[ntds]-[a-z0-9]{4,}\b/g, ' ').split(/[^a-z0-9]+/)) {
    const s = stem(word);
    if (s && !GENERIC.has(s) && !said.has(s)) said.set(s, word);
  }
  return { task, said, terms: new Set(said.keys()) };
}

function within(scope: Spool, spool: Spool): boolean {
  return spool === scope || spool.root.startsWith(scope.root + path.sep);
}

/** How many of the docs each term appears in. */
function spread(docs: Doc[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const d of docs) for (const t of d.terms) count.set(t, (count.get(t) ?? 0) + 1);
  return count;
}

/** How widely a term may be used and still tell of a group of this size. */
function reach(size: number): number {
  return Math.max(size, SUGGEST.minTasks) / SUGGEST.belongs;
}

/**
 * Grow a group from one task: keep adding the task that shares the most
 * telling terms with what the group still has in common, while that stays at
 * the threshold. What is left in common at the end is the recurring vocabulary.
 */
function grow(seed: Doc, pool: Doc[], seen: Map<string, number>): { group: Doc[]; core: string[] } {
  const group = [seed];
  let core = [...seed.terms];
  const telling = (terms: string[], size: number) => terms.filter((t) => seen.get(t)! <= reach(size));
  for (;;) {
    let best: Doc | undefined;
    let most = SUGGEST.minTerms - 1;
    for (const d of pool) {
      if (group.includes(d)) continue;
      const shared = telling(core, group.length + 1).filter((t) => d.terms.has(t)).length;
      if (shared > most) [best, most] = [d, shared];
    }
    if (!best) return { group, core: telling(core, group.length) };
    const next = best;
    group.push(next);
    core = core.filter((t) => next.terms.has(t));
  }
}

/** Whether a skill, or an offer to write one, already came from these tasks. */
function spokenFor(ws: Workspace, group: Item[]): boolean {
  const ids = new Set(group.map((t) => t.id));
  const from = (item: Item) => item.from.filter((id) => ids.has(id)).length;
  return ws.items.some(
    (i) =>
      // A skill written from any one of them, kept or dropped: the procedure has been written down, or refused.
      (i.kind === 'skill' && from(i) >= 1) ||
      // A suggested thread that came from two or more of them is the offer itself, whatever became of it:
      // waiting, taken up, done, or dropped because the answer was no. One alone is an ordinary follow-up idea.
      (i.kind === 'task' && !!i.suggested && from(i) >= 2),
  );
}

/**
 * Procedures that recur across the finished tasks of one project and the
 * projects below it, with no skill used and none written or refused since.
 * Strongest first: seen in the most tasks, then sharing the most.
 */
export function suggestSkills(ws: Workspace, scope: Spool): Candidate[] {
  // Changes only. An audit or a plan is finished by its report, and how to write one is the loop's own rule.
  const finished = ws.items
    .filter((i) => i.kind === 'task' && i.status === 'done' && !i.type && within(scope, i.spool))
    .slice(-SUGGEST.recent)
    .map(read);
  // Counted over every finished task, the ones that used a skill too: a few tasks that skipped a skill
  // the others followed share its words with all of them, and so do not look like something new.
  const seen = spread(finished);
  // A task that reported a skill followed a procedure already written down: nothing to learn from it.
  const pool = finished.filter((d) => !d.task.skills.length);

  const taken = new Set<Doc>();
  const out: Candidate[] = [];
  for (const seed of pool) {
    if (taken.has(seed)) continue;
    const { group, core } = grow(seed, pool.filter((d) => !taken.has(d)), seen);
    if (group.length < SUGGEST.minTasks) continue;
    for (const d of group) taken.add(d);
    const tasks = group.map((d) => d.task).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    if (spokenFor(ws, tasks)) continue;
    const oldest = group.find((d) => d.task === tasks[0])!;
    const terms = core
      .sort((a, b) => seen.get(a)! - seen.get(b)! || a.localeCompare(b))
      .slice(0, SUGGEST.termsShown)
      .map((t) => oldest.said.get(t) ?? t);
    out.push({ spool: home(ws, scope, tasks), tasks, terms });
  }
  return out.sort((a, b) => b.tasks.length - a.tasks.length || b.terms.length - a.terms.length);
}

/** The deepest project every one of these tasks is in or under: a skill there reaches them all. */
function home(ws: Workspace, scope: Spool, tasks: Item[]): Spool {
  const holds = ws.spools.filter((s) => within(scope, s) && tasks.every((t) => within(s, t.spool)));
  return holds.sort((a, b) => b.root.length - a.root.length)[0] ?? scope;
}

function target(c: Candidate): string {
  // Both commands file beside the first task they came from unless told where.
  const ids = c.tasks.map((t) => t.id).join(',');
  return `--from ${ids}${c.tasks[0]!.spool === c.spool ? '' : ` -P ${c.spool.name}`}`;
}

/**
 * The line that offers a candidate to the human: an AI-suggested thread, which
 * waits for their yes like any other idea an agent has. The name and the steps
 * are left for the agent, who can read the tasks; the reason is filled in.
 */
export function offerLine(c: Candidate): string {
  const why = `agents worked these steps out ${c.tasks.length} times over; written down, the next one just follows them`;
  return `spool task "Write down how we <the procedure, in their words> as a skill" --suggested "${why}" ${target(c)} --size s -b "<the steps, as far as you know them>"`;
}

/** The line that writes it down, once they have said yes. The steps are the agent's to supply: the engine cannot know them. */
export function addLine(c: Candidate): string {
  return `spool skill add <name> -d "<what it does and when to use it>" ${target(c)} -b - <<'EOF' … EOF`;
}
