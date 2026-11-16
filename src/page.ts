/**
 * The Spool page: the project's spool as a board in a browser.
 *
 * `spool page` starts a small server on this machine and opens a kanban board
 * of every thread: backlog, build, building, done. A second view is the
 * backlog itself, with sprints to fill and play. It is where the human plans
 * and steers. They drag a thread into build, or press play on it, and
 * that is the only way anything gets built; they add a thread at the foot of a
 * column; they open a card and read its thread: what they asked, what was done
 * and by which agent, and everything that happened in between; they write a
 * note on it and it lands there in their words; they answer a question and
 * work moves again; and they mark finished work complete when they have
 * looked at it.
 * Agents read the same spool and keep working while the page is open.
 *
 * Everything the page does is an ordinary command run in-process, as the
 * human: `build`, `propose`, `order`, `capture`, `task`, `file`, `edit`, `answer`, `approve`,
 * `sprint`, `play`, `drop`, `revert`, `archive`. So the page can do
 * nothing the command line cannot, and every rule the commands enforce holds
 * here too.
 *
 * The server listens on 127.0.0.1 only. Changing anything needs the token it
 * hands to its own page, and a Host header that names this machine, so another
 * website open in the same browser cannot press play on your behalf.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brief, morning } from './brief.ts';
import { run } from './cli.ts';
import type { Bare, Result } from './commands.ts';
import { type Builder, type Ctx, builderOf, parallelOf, saveBuilder, userConfig } from './context.ts';
import { detachPage, forgetPage, pageStatus, pageUp, rememberPage, stopPage } from './detach.ts';
import { DEFAULT_AGENT, PREAMBLE } from './loop.ts';
import {
  EFFORTS,
  MODELS,
  ROUTER,
  ROUTE_TIMEOUT_MS,
  type Routing,
  commandFor,
  parseRoute,
  pickFor,
  routeNote,
  routerCommand,
  routerPrompt,
  suggestion,
} from './agent.ts';
import { dirtyPaths, discardPaths, git, repoRoot } from './git.ts';
import { type Item, SpoolError, addLog, isPlan, oneLine, reportFile, splitBody, timestamp, whyOf } from './model.ts';
import { prime } from './prime.ts';
import { age, brief, paint, sprintAbout, tableRows } from './render.ts';
import { blockers, children, dependents, docket, ready, review, sprintOf, sprintTasks, taskState, tasks } from './schedule.ts';
import { atOnceIn, sharedFolderWhy } from './slots.ts';
import { Workspace } from './store.ts';
import { hearLine, streaming, transcriptFile } from './stream.ts';
import { watched } from './watch.ts';
import { closeWorktree, openWorktree, workDir } from './worktree.ts';

type Column = 'proposed' | 'build' | 'building' | 'done';

interface Card {
  id: string;
  /** Its number in the loop's list, so the board and the chat point at the same thread. */
  n: number | null;
  title: string;
  difficulty: string;
  priority: string;
  urgent: boolean;
  type: string;
  /** What the human needs to know about it right now, if anything. */
  note: string;
  /** Why it exists: the Why line of its spec, shown on the card so the human can agree to it unopened. */
  why: string;
  suggested: string;
  /** The fields a ticket shows and the human can change. */
  size: string;
  /** The model and effort the human chose for it, if they did, and what its size suggests. */
  model: string;
  effort: string;
  /** `by` names the model that chooses for it when it starts, where one does. */
  suggest: { model: string; effort: string; by: string };
  p: number;
  tags: string[];
  version: string;
  /** The sprint it is in, by id, or none. */
  sprint: string;
  column: Column;
  created: string;
  updated: string;
  /** Shipped, and whether the human has marked it complete. */
  done: boolean;
  complete: boolean;
  /** Finished: the steps a person follows to see it working, as the agent wrote them. */
  steps: string[];
  thread: Thread;
  question: { id: string; title: string; options: string[]; recommend: number | null } | null;
  /** While it is being built: when the agent took it, and the latest thing it said it was doing. */
  live: Live | null;
  /** The folder it is built in, from the project's, where it has a git worktree of its own; empty where it is the project's own folder. */
  worktree: string;
  /** Why it cannot move on by itself, where it cannot. */
  waiting: Waiting | null;
}

/**
 * What a thread is waiting on: an answer from the human (`you`), another thread (`thread`), the
 * human's hold (`hold`), or nothing but a word from them after its agent gave up (`stuck`).
 */
interface Waiting {
  kind: 'you' | 'thread' | 'hold' | 'stuck';
  /** What it waits on, in a line: the question, the hold's reason, how the agent ended. */
  text: string;
  /** The threads it waits on, to link to. */
  on: { id: string; title: string }[];
  /** An agent that gave up: the last thing it said, and what it was refused. */
  said: string;
  refused: string[];
}

interface Live {
  since: string;
  note: string;
}

/** A card opened up: what was asked, what was done about it and by whom, and where it came from. */
interface Thread {
  /** The human's own words, each as they said it. */
  said: { text: string; note: string; on: string }[];
  spec: string;
  /** The spec read as plain parts, each under a heading the page can mark: what it is, why, when it is done. */
  about: About[];
  /** Everything that happened to it, oldest first. */
  steps: { at: string; who: string; what: string }[];
  /**
   * The same story told as a conversation, oldest first: what the human said, what an agent
   * answered, and the small events in between.
   */
  feed: Post[];
  /** The report an audit or a plan handed in, in full: the long read belongs on the page. */
  report: string;
  /** Who built it, as they signed themselves. */
  by: string;
  /** The project's check that passed before it was finished, as the command that ran. */
  checked: string;
  summary: string;
  commits: string[];
  cameFrom: { id: string; title: string }[];
  parts: { id: string; title: string; state: string }[];
  /** The decisions it waits on or was decided by: questions asked, and calls an agent made for it. */
  questions: { id: string; title: string; status: string; choice: string; why: string }[];
}

/** One part of a thread's description: what changes, how it helps, when it is done, or anything else written. */
interface About {
  key: 'what' | 'why' | 'done' | 'other';
  label: string;
  text: string;
}

/**
 * What waits on the human besides building: the decisions the page puts in front of them.
 * `threads` says which threads each is about, so the page shows it there; one about no thread
 * is shown at the top of the backlog.
 */
interface Needs {
  questions: { id: string; title: string; options: string[]; recommend: number | null; why: string; holds: string[]; threads: string[] }[];
  plans: { id: string; title: string; summary: string; parts: string[] }[];
  calls: { id: string; title: string; choice: string; why: string; by: string; holds: string[]; threads: string[] }[];
  skills: { id: string; name: string; about: string; by: string; threads: string[] }[];
  notes: { id: string; text: string }[];
}

/** The first line of a decision is the reason given for it, unless it is only the pointer to its thread. */
function reasonOf(d: Item): string {
  const line = splitBody(d.body).main.split('\n')[0] ?? '';
  return line.startsWith('For [[') ? '' : oneLine(line, 240);
}

function needsOf(ws: Workspace, spool: Item['spool']): Needs {
  const queue = review(ws, spool);
  const why = reasonOf;
  const holds = (d: Item): string[] => dependents(ws, d).map((t) => oneLine(t.title, 70));
  const threads = (d: Item): string[] => dependents(ws, d).map((t) => t.id);
  return {
    questions: queue.questions.map((d) => ({ id: d.id, title: d.title, options: d.options, recommend: d.recommend ?? null, why: why(d), holds: holds(d), threads: threads(d) })),
    plans: queue.plans.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary ?? '',
      parts: children(ws, t).filter((k) => k.status !== 'dropped').map((k) => oneLine(k.title, 90)),
    })),
    calls: queue.assumptions.map((d) => ({ id: d.id, title: d.title, choice: d.choice ?? '', why: why(d), by: d.by ?? '', holds: holds(d), threads: threads(d) })),
    // A skill knows the threads that taught it.
    skills: queue.skills.map((k) => ({ id: k.id, name: k.title, about: oneLine(splitBody(k.body).main, 200), by: k.by ?? '', threads: k.from.filter((id) => id.startsWith('t-')) })),
    notes: queue.inbox.map((n) => ({ id: n.id, text: splitBody(n.body).main })),
  };
}

interface Post {
  at: string;
  who: string;
  /**
   * said: the human's words · post: an agent's note · shipped: it finished · asked: it needs a call ·
   * decided: an agent made a call itself · event: bookkeeping.
   */
  kind: 'said' | 'post' | 'shipped' | 'asked' | 'decided' | 'event';
  text: string;
  /** The decision a post is about: the question asked, or the call made. */
  ref?: string;
}

/** The queue's own log lines: what moved where. Anything else an agent logged is something it had to say. */
const BOOKKEEPING = /^(started|check passed|moved to build|moved back to proposed|edited: |put on hold|released from hold|approved|picked up after|handed to |agent |session |transcript |reverted|reopened|dropped|agreed|filed |placed )/;

function feedOf(ws: Workspace, task: Item, said: Thread['said'], steps: Thread['steps']): Post[] {
  const words: Post[] = said.map((s) => ({
    // A note knows when it was said; words with no note behind them were there from the start.
    at: (ws.find(s.note)?.created ?? task.created).slice(0, 16).replace('T', ' ') + 'Z',
    who: 'human',
    kind: 'said',
    text: s.text,
  }));
  const rest: Post[] = steps.map((s) => {
    if (s.what.startsWith('done: ')) return { at: s.at, who: s.who, kind: 'shipped', text: s.what.slice(6) };
    const asked = /^waiting on d-[a-z0-9]+: (.*)$/.exec(s.what);
    if (asked) return { at: s.at, who: s.who, kind: 'asked', text: asked[1]! };
    const decided = /^assumed (d-[a-z0-9]+): (.*)$/.exec(s.what);
    if (decided) return { at: s.at, who: s.who, kind: 'decided', text: decided[2]!, ref: decided[1]! };
    return { at: s.at, who: s.who, kind: BOOKKEEPING.test(s.what) || s.who === 'human' ? 'event' : 'post', text: s.what };
  });
  // Stable: things said in the same minute keep the order they were written in, words first.
  return [...words, ...rest].map((p, i) => ({ p, i })).sort((a, b) => a.p.at.localeCompare(b.p.at) || a.i - b.i).map((x) => x.p);
}

interface Board {
  project: string;
  /** The human's mark in this project: an identicon drawn from its name, so each spool has its own. */
  you: string;
  version: string;
  /** Which build of Spool's own code this page is served by. The open page reloads itself when it changes. */
  build: string;
  /** Something about the page itself the human should know: it is rebuilding, or a rebuild failed. */
  notice: string;
  gate: boolean;
  /** Only a person can move work to build: an agent is refused. */
  locked: boolean;
  /** Every tag and version in use, to offer when the human types one. */
  tags: string[];
  versions: string[];
  /** How many finished threads the human has marked complete, shown or not. */
  history: number;
  /** Everything waiting on the human that is not a thread to build. */
  needs: Needs;
  /**
   * Who builds, and how it is going. `builder` is the human's pick: `headless`, the page's own
   * runner starting the agent command, or `chat`, a Claude Code chat running the loop, where the
   * page starts nothing and `watching` says whether a chat is listening for work. The rest is the
   * page's own runner: whether it is on, with what command, how many threads it builds at once,
   * and for each one it is building now, what its agent is saying.
   */
  runner: {
    builder: Builder;
    watching: boolean;
    on: boolean;
    agent: string;
    parallel: number;
    running: { id: string; seconds: number; lines: string[] }[];
    /** Threads the human stopped while they were being built: the runner leaves them in Build until they carry on. */
    stopped: string[];
    recent: { id: string; title: string; outcome: string }[];
  };
  /** The sprints, oldest first: what is in each and how far along it is. */
  sprints: { id: string; name: string; status: string; goal: string; why: string; doneWhen: string; total: number; done: number; waiting: number }[];
  columns: Record<Column, Card[]>;
  /** Threads put out of sight, newest first: on no column, shown only in the Backlog view's Archived section. */
  archived: Card[];
  also: { assumptions: number; skills: number; inbox: number };
  /** The morning brief, as `spool brief --json` gives it, for the panel above the columns. Null with nothing shipped and nothing needing him. */
  brief: Brief | null;
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;
/** Finished work is kept for good. The page carries what is still to check, and the most recent of the rest as history. */
const HISTORY_SHOWN = 60;

/** Which column a thread sits in. On hold is the human saying not yet, so it sits with what is not in build. */
function columnOf(state: string): Column | null {
  // An archived thread is off the board, but it is still the backlog's: moved anywhere, it moves from there.
  if (state === 'proposed' || state === 'held' || state === 'archived') return 'proposed';
  if (state === 'ready' || state === 'stale' || state === 'blocked') return 'build';
  if (state === 'active') return 'building';
  if (state === 'done') return 'done';
  return null;
}

/** A thread's body is the human's words, quoted and signed, around whatever spec was written for it. */
function readBody(main: string): { said: Thread['said']; spec: string } {
  const said: Thread['said'] = [];
  const spec: string[] = [];
  for (const block of main.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (!lines.every((l) => l.startsWith('>'))) {
      spec.push(block);
      continue;
    }
    const words = lines.map((l) => l.replace(/^> ?/, ''));
    const signed = /^— \[\[(n-[a-z0-9]+)\]\], (\d{4}-\d\d-\d\d)$/.exec(words.at(-1) ?? '');
    said.push({ text: (signed ? words.slice(0, -1) : words).join('\n').trim(), note: signed?.[1] ?? '', on: signed?.[2] ?? '' });
  }
  return { said, spec: spec.join('\n\n').trim() };
}

// The words a spec puts in front of a part, and the plain heading each one gets on the page.
const ABOUT: [RegExp, About['key'], string][] = [
  [/^(what|goal|change|the change)$/i, 'what', 'What changes'],
  [/^(why|benefit|benefits|so that)$/i, 'why', 'How it helps Spool'],
  [/^(done when|finished when)$/i, 'done', 'Done when'],
];

/**
 * A spec is written as "What: … / Why: … / Done when: …" lines, more or less. Read it into parts,
 * each under its heading, so the page can lay them out instead of showing one block of text.
 * Text under no known label is kept as it was, as more detail; a blank line ends a labelled part.
 */
export function aboutOf(spec: string): About[] {
  const parts: About[] = [];
  let open = false;
  for (const line of spec.split('\n')) {
    const labelled = /^\s*(?:[-*]\s+)?\**([A-Za-z][A-Za-z ]{0,18}?)\**:\s*(.*)$/.exec(line);
    const known = labelled ? ABOUT.find(([pattern]) => pattern.test(labelled[1]!.trim())) : undefined;
    if (labelled && known) {
      parts.push({ key: known[1], label: known[2], text: labelled[2]!.replace(/^\*+\s*/, '') });
      open = true;
    } else if (!line.trim()) {
      if (parts.at(-1)?.key !== 'other') open = false;
      else parts.at(-1)!.text += '\n';
    } else if (open || parts.at(-1)?.key === 'other') {
      parts.at(-1)!.text += '\n' + line;
    } else {
      parts.push({ key: 'other', label: 'More detail', text: line });
      open = true;
    }
  }
  return parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
}

function readReport(task: Item): string {
  try {
    return fs.readFileSync(reportFile(task), 'utf8').trim();
  } catch {
    return '';
  }
}

function threadOf(ws: Workspace, task: Item, main: string, log: string[]): Thread {
  const steps = log.map((line) => {
    const parsed = /^- (\d{4}-\d\d-\d\d \d\d:\d\dZ) (.+?): (.*)$/.exec(line);
    return parsed ? { at: parsed[1]!, who: parsed[2]!, what: parsed[3]! } : { at: '', who: '', what: line.replace(/^- /, '') };
  });
  const from = task.from.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind !== 'note');
  const asked = task.needs.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind === 'decision');
  const read = readBody(main);
  return {
    ...read,
    about: aboutOf(read.spec),
    steps,
    feed: feedOf(ws, task, read.said, steps),
    report: readReport(task),
    by: task.by ?? '',
    checked: task.checked ?? '',
    summary: task.summary ?? '',
    commits: task.commits.map((c) => c.slice(0, 7)),
    cameFrom: from.map((i) => ({ id: i.id, title: i.title })),
    parts: children(ws, task).map((k) => ({ id: k.id, title: k.title, state: taskState(ws, k) })),
    questions: asked.map((d) => ({ id: d.id, title: d.title, status: d.status, choice: d.choice ?? '', why: reasonOf(d) })),
  };
}

// The log lines that mean an agent has just taken the thread.
const CLAIM = /^(started|picked up after|handed to )/;

/**
 * What a Building card says is happening: the latest note the agent left since it took the
 * thread, and when it took it. A thread with no note yet is only starting.
 */
export function liveNow(task: Item): Live {
  const steps = splitBody(task.body).log.map((line) => /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d)Z (.+?): (.*)$/.exec(line));
  let claimed = -1;
  steps.forEach((m, i) => {
    if (m && CLAIM.test(m[4]!)) claimed = i;
  });
  const claim = steps[claimed];
  const said = steps.slice(claimed + 1).filter((m) => m && !BOOKKEEPING.test(m[4]!)).at(-1);
  return {
    since: task.started ?? (claim ? `${claim[1]}T${claim[2]}:00Z` : task.updated),
    note: said ? oneLine(said[4]!, 200) : '',
  };
}

/** How a card learns what will pick its model: the size table, and who chooses first. */
interface Picking {
  models: Routing;
  chooser: (task: Item) => string;
}

// How a run that gave up is written on its thread, by the page's runner or the loop.
const GAVE_UP = /^agent (.+?) without finishing/;

/** Why a thread cannot move on by itself, read from what the board already knows of it. */
function waitingOf(ws: Workspace, task: Item, steps: Thread['steps'], asked: Item | undefined): Waiting | null {
  const none = { on: [], said: '', refused: [] };
  if (asked) return { kind: 'you', text: asked.title, ...none };
  const state = taskState(ws, task);
  if (state === 'held') return { kind: 'hold', text: task.hold ?? '', ...none };
  if (state === 'blocked') {
    const tasksOn = blockers(ws, task).filter((b) => b.kind === 'task');
    const plan = tasksOn.find((b) => isPlan(b) && b.status === 'done');
    if (plan) return { kind: 'you', text: `Your go-ahead for the plan “${plan.title}”`, ...none, on: [{ id: plan.id, title: plan.title }] };
    return { kind: 'thread', text: '', ...none, on: tasksOn.map((b) => ({ id: b.id, title: b.title })) };
  }
  // Back in Build after an agent left it unfinished, and not taken again since.
  if (state !== 'ready' && state !== 'stale') return null;
  const gave = steps.findLastIndex((st) => GAVE_UP.test(st.what));
  const took = steps.findLastIndex((st) => CLAIM.test(st.what));
  if (gave < 0 || took > gave) return null;
  const run = steps.slice(took + 1, gave);
  const said = run.filter((st) => !['page', 'loop', 'human'].includes(st.who) && !BOOKKEEPING.test(st.what)).at(-1);
  return {
    kind: 'stuck',
    text: GAVE_UP.exec(steps[gave]!.what)![1]!,
    on: [],
    said: said ? oneLine(said.what, 300) : '',
    refused: run.filter((st) => st.what.startsWith('permission denied: ')).map((st) => oneLine(st.what.slice(19), 160)),
  };
}

function card(ws: Workspace, task: Item, n: number | null, note: string, column: Column, routing?: Picking): Card {
  const suggest = suggestion(task, routing?.models);
  const { main, log } = splitBody(task.body);
  const asked = blockers(ws, task).find((b) => b.kind === 'decision' && b.status === 'open');
  const thread = threadOf(ws, task, main, log);
  return {
    id: task.id,
    n,
    title: task.title,
    difficulty: task.size ? DIFFICULTY[task.size] : '',
    priority: URGENCY[task.priority ?? 2] ?? 'Normal',
    urgent: (task.priority ?? 2) <= 1,
    type: task.type ?? 'change',
    note,
    why: whyOf(task),
    suggested: task.suggested ?? '',
    size: task.size ?? '',
    model: task.model ?? '',
    effort: task.effort ?? '',
    suggest: { model: suggest.model ?? '', effort: suggest.effort ?? '', by: routing?.chooser(task) ?? '' },
    p: task.priority ?? 2,
    tags: task.tags,
    version: task.version ?? '',
    sprint: sprintOf(ws, task)?.id ?? '',
    column,
    created: task.created,
    updated: task.updated,
    done: task.status === 'done',
    complete: task.status === 'done' && !!task.reviewed,
    steps: task.status === 'done' ? task.steps : [],
    thread,
    question: asked ? { id: asked.id, title: asked.title, options: asked.options, recommend: asked.recommend ?? null } : null,
    live: column === 'building' ? liveNow(task) : null,
    worktree: task.worktree ?? '',
    waiting: task.status === 'done' || task.status === 'dropped' ? null : waitingOf(ws, task, thread.steps, asked),
  };
}

/** The project's own version, where it keeps one in a place Spool knows; otherwise none is shown. */
function projectVersion(root: string): string {
  try {
    const found = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    if (typeof found === 'string') return found;
  } catch {
    // No package.json, or not one with a version: try the plain file.
  }
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim().split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * What a card says under its title. The column already says proposed, and a
 * question is shown with its buttons, so neither is repeated; what is left is
 * the reason an agent suggested it, or what it is waiting on.
 */
function cardNote(row: { item: Item; mark: string; note: string }): string {
  // A thread whose spec says why already shows it on its own line; the agent's reason stays on its chip.
  if (row.item.suggested) return whyOf(row.item) ? '' : `Why: ${row.item.suggested}`;
  if (row.mark === '🟠' || (row.mark === '🔴' && row.note.startsWith('Needs you: ') && !row.note.includes('go-ahead'))) return '';
  return `${row.mark} ${row.note}`.replace(/\*\*/g, '').trim();
}

/**
 * An identicon in the way GitHub draws one: a five by five grid, mirrored left to right,
 * with a colour and a pattern both taken from a hash of the seed. The same name always
 * draws the same mark, and another name almost always draws another.
 */
export function identicon(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  const hue = Math.round((h.readUInt16BE(0) / 0x10000) * 360);
  const sat = 45 + (h[2]! % 20);
  const light = 45 + (h[3]! % 12);
  const cells: string[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if ((h[4 + row * 3 + col]! & 1) === 0) continue;
      for (const x of new Set([col, 4 - col])) cells.push(`<rect x="${x + 1}" y="${row + 1}" width="1" height="1"/>`);
    }
  }
  return `<svg viewBox="0 0 7 7" role="img" aria-label="You" shape-rendering="crispEdges"><rect width="7" height="7" fill="#f0f0f0"/><g fill="hsl(${hue} ${sat}% ${light}%)">${cells.join('')}</g></svg>`;
}

/** The whole board for one project, read fresh from disk. */
export function board(ws: Workspace, project?: string, runner?: Runner, upkeep?: Upkeep): Board {
  const spool = project ? ws.project(project) : ws.home;
  const d = docket(ws, spool);
  const columns: Record<Column, Card[]> = { proposed: [], build: [], building: [], done: [] };
  const routing = runner?.routing();
  // The open threads, in the order and with the numbers the loop's list gives them.
  for (const row of tableRows(ws, d)) {
    const column = columnOf(taskState(ws, row.item));
    if (column) columns[column].push(card(ws, row.item, row.n, cardNote(row), column, routing));
  }
  const done = tasks(ws, spool)
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  // What the human has not looked at yet comes first, all of it; what they marked complete is history.
  const shown = [...done.filter((t) => !t.reviewed), ...done.filter((t) => t.reviewed).slice(0, HISTORY_SHOWN)];
  for (const t of shown) {
    columns.done.push(card(ws, t, null, `${age(t.updated, ws.now())} ago${t.summary ? ` · ${oneLine(t.summary, 160)}` : ''}`, 'done', routing));
  }
  const queue = review(ws, spool);
  const all = tasks(ws, spool);
  return {
    project: spool.name,
    you: identicon(spool.name),
    version: projectVersion(spool.root),
    build: upkeep?.build ?? '',
    notice: upkeep?.notice ?? '',
    gate: !!spool.config.gate,
    locked: spool.config.gate === 'locked',
    tags: [...new Set(all.flatMap((t) => t.tags))].sort(),
    versions: [...new Set(all.map((t) => t.version ?? '').filter(Boolean))].sort().reverse(),
    history: done.filter((t) => t.reviewed).length,
    needs: needsOf(ws, spool),
    runner: {
      builder: runner?.builder ?? 'headless',
      // Looked for only where it is shown: with a chat building.
      watching: runner?.builder === 'chat' && watched(spool.root),
      on: !!runner?.on,
      agent: runner?.agent ?? '',
      parallel: runner?.parallel ?? 1,
      running: [...(runner?.runs.values() ?? [])].map((run) => ({ id: run.id, seconds: Math.round((Date.now() - run.began) / 1000), lines: run.lines })),
      // One carried on with that waits for room is no longer stopped. With a chat building, nothing holds a
      // stopped thread back: the chat takes whatever is in Build.
      stopped: runner?.builder === 'chat' ? [] : all.filter((t) => stoppedInBuild(t) && !runner?.isNext(t.id)).map((t) => t.id),
      recent: runner?.recent ?? [],
    },
    sprints: ws.items
      .filter((i) => i.kind === 'sprint' && i.spool === spool && i.status !== 'dropped')
      .sort((a, b) => a.created.localeCompare(b.created))
      .map((s) => {
        const inIt = sprintTasks(ws, s);
        return {
          id: s.id,
          name: s.title,
          status: s.status,
          ...sprintAbout(s),
          total: inIt.length,
          done: inIt.filter((t) => t.status === 'done').length,
          // What pressing play would move: in the sprint, and not yet in build.
          waiting: inIt.filter((t) => t.status === 'proposed' || !!t.hold).length,
        };
      }),
    columns,
    archived: all
      .filter((t) => taskState(ws, t) === 'archived')
      .sort((a, b) => b.archived!.localeCompare(a.archived!))
      .map((t) => card(ws, t, null, age(t.archived!, ws.now()) === 'now' ? 'Archived just now' : `Archived ${age(t.archived!, ws.now())} ago`, 'proposed', routing)),
    also: { assumptions: queue.assumptions.length, skills: queue.skills.length, inbox: queue.inbox.length },
    brief: briefOf(ws, spool),
  };
}

/**
 * The brief, kept per spool for as long as nothing it reads has changed. The board is asked for
 * about once a second, and the brief asks git about every commit of every thread not yet
 * reviewed. So it is made again only when an item of the spool changed: its state, or its updated
 * stamp. A thread being built is left out of the stamps, since its agent touches it every few
 * seconds and only its state (building, or gone quiet) changes what the brief says.
 */
const briefs = new Map<string, { key: string; brief: Brief | null }>();

function briefOf(ws: Workspace, spool: Item['spool']): Brief | null {
  const key = ws.items
    .filter((i) => i.spool === spool)
    .map((i) => {
      const state = i.kind === 'task' ? taskState(ws, i) : i.status;
      return `${i.id}:${state}:${i.reviewed ?? ''}:${state === 'active' ? '' : i.updated}`;
    })
    .join(' ');
  const kept = briefs.get(spool.root);
  if (kept?.key === key) return kept.brief;
  const b = morning(ws, { project: spool });
  const needs = b.needsYou.questions.length + b.needsYou.plans.length + b.needsYou.stopped.length;
  const brief = b.shipped || needs ? b : null;
  briefs.set(spool.root, { key, brief });
  return brief;
}

// ------------------------------------------------------------------ the page runs the agents

const LIVE_LINES = 60;

/** The file a page writes its agent's prompt to. It lives exactly as long as the agent. */
const promptFile = (id: string, pid: number): string => path.join(os.tmpdir(), `spool-${id}-${pid}.md`);

/** Whether the last claim on a thread was a page handing it to an agent, not someone starting it. */
function handedByPage(task: Item): boolean {
  const claims = splitBody(task.body).log.filter((line) => /^- \S+ \S+ (page: handed to |[^:]+: (started|picked up after))/.test(line));
  return / page: handed to /.test(claims.at(-1) ?? '');
}

/** A log line that says how a thread came to wait in Build, or that someone took it from there. */
const STANDS = /^(moved to build|released from hold|reverted |started$|picked up after |handed to |agent .* without finishing|.*; back in build$)/;
/** The human stopping a thread that was being built: Stop on the page, or the thread moved back to Build. */
const STOP = /^stopped (from the page|while .* was building it); back in build$/;

/**
 * Whether the human stopped this thread while it was being built, and has not set it going
 * since. The page's runner leaves such a thread in Build until they carry on with it. It is read
 * from the thread's own log, so it holds on every page and across a restart: of the lines that
 * say how the thread came to wait in Build, the last is a stop. A note or an edit since changes
 * nothing; moving it, or an agent taking it, does.
 */
export function stoppedInBuild(task: Item): boolean {
  if (task.status !== 'open') return false;
  const said = splitBody(task.body).log.map((line) => /^- \S+ \S+ .+?: (.*)$/.exec(line)?.[1] ?? '');
  return STOP.test(said.filter((what) => STANDS.test(what)).at(-1) ?? '');
}

/** Whether a page on this machine, other than this one, has an agent on the thread right now. */
function pageRunning(id: string): boolean {
  let names: string[] = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return false;
  }
  return names.some((name) => {
    const found = /^spool-(t-[a-z0-9]+)-(\d+)\.md$/.exec(name);
    if (!found || found[1] !== id) return false;
    const pid = Number(found[2]);
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
}

/** End a program started in a process group of its own, and everything it started. */
function endGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

/** How long an agent told to end has to do so, before what is left of it is killed. */
const END_GRACE_MS = 2000;

/**
 * The folder a run's agent works in: the thread's own worktree, where `handOut` gave it one, or the
 * project's folder where it could not have one. Two agents never share the project's folder: see
 * `handOut`.
 */
function runFolder(task: Item): string {
  return workDir(task);
}

/** How a thread's log says, once, that it is built in the project's own folder and not in a worktree. */
const OWN_FOLDER = "built in the project's own folder, not a worktree of its own: ";

/** One agent on one thread. Everything about a run is kept here, so that several can go at once. */
interface Run {
  id: string;
  title: string;
  /** The folder its agent works in. */
  folder: string;
  /** Files already changed there, and not committed, when it began: undoing its edits leaves those alone. Null where git could not say. */
  before: Set<string> | null;
  child: ChildProcess;
  lines: string[];
  began: number;
  /** Ended from the page, and not by the agent: stopped, moved to another column, or the page itself going. */
  stopped: boolean;
  /** The thread was moved back to the backlog, so once the agent is gone, what it changed is undone. */
  undo?: boolean;
  /** Another run worked in the same folder while this one did: what is uncommitted there cannot be told apart. */
  shared?: boolean;
  /** Its worktree, by its folder from the project, and the branch it is on: none where it works in the project's own folder. */
  worktree?: { folder: string; branch: string };
}

/** What is settled about a run when its thread is handed out, before any program is started for it. */
type Handed = Pick<Run, 'id' | 'title' | 'folder' | 'before' | 'worktree'>;

/** What one try at handing out a thread came to: an agent started, nothing there to hand out, or a thread that could not be started. */
type HandOut = 'started' | 'none' | 'skipped';

/**
 * The runner: with it on, the page builds what is in Build by itself. It takes
 * the next thread, starts the user's agent command on it with the rules and
 * the brief on stdin, shows what the agent prints as it works, and takes the
 * next when there is room: as many at once as `parallel` in the user's config
 * says, three unless it is set. Each is built in a git worktree of its own and
 * lands on the checkout with its own `spool done`; a project that cannot have
 * worktrees is built in its own folder, one thread at a time. A thread is
 * taken the moment it lands in Build.
 *
 * It is the same contract as `spool loop`: a thread the agent finished is
 * done, one it asked a question on waits for the human, and one it walked
 * away from is put back and not tried again until something about it changes.
 * The agent command comes from the user's machine, never from the project.
 *
 * That is building headless. The human can pick a chat to build instead, on the
 * page: a Claude Code session running the loop. Then the runner starts nothing,
 * whether it is on or not, and an agent it had already started is left to finish.
 */
export class Runner {
  on: boolean;
  readonly agent: string;
  /** The folder of the project this page shows: the human's pick of who builds is kept by it. */
  private root = '';
  /** What is being built now, by thread, in the order each was started. */
  readonly runs = new Map<string, Run>();
  /** The threads dragged into Building, in the order they were dragged: they are taken next, ahead of the rest of Build. */
  private first: string[] = [];
  /**
   * The page looking after its own code, once a tick and before anything is started. It answers
   * true while nothing new should start: Spool is being rebuilt, or the page is about to restart.
   */
  upkeep: (() => boolean) | undefined;
  /** What upkeep answered at the last tick. */
  private held = false;
  /** How many threads it has handed out. Upkeep reads it: one taken and finished between two of its looks was work all the same. */
  handedOut = 0;
  /** How the last few threads it ran turned out, newest first. */
  recent: { id: string; title: string; outcome: string }[] = [];
  private gaveUp = new Map<string, string>();
  private timer: NodeJS.Timeout;
  private ctx: Ctx;
  private project: string | undefined;

  constructor(ctx: Ctx, project: string | undefined, agent: string | undefined, on: boolean) {
    this.ctx = ctx;
    this.project = project;
    this.agent = agent || ctx.env.SPOOL_AGENT || userConfig(ctx).agent || DEFAULT_AGENT;
    this.on = on;
    try {
      const ws = Workspace.open(ctx.cwd, ctx.now);
      try {
        this.root = (project ? ws.project(project) : ws.home).root;
      } finally {
        ws.close();
      }
    } catch {
      // No spool to read: there is nothing to build either.
    }
    this.recover();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Who builds what is in Build: read fresh, so a pick made on any page of this project shows at once. */
  get builder(): Builder {
    return this.root ? builderOf(this.ctx, this.root) : 'headless';
  }

  set builder(builder: Builder) {
    if (this.root) saveBuilder(this.ctx, this.root, builder);
  }

  /**
   * How many of this project's threads are built at once: read fresh, so a change to the user's
   * config shows at once. One where they would share the project's folder.
   */
  get parallel(): number {
    return this.root ? atOnceIn(this.ctx, this.root) : parallelOf(this.ctx);
  }

  /**
   * The page is going away. Every thread an agent of its is on goes back to Build now,
   * while the process is still here to write it: the agents end with the page,
   * so nobody would be working a thread left marked as handed out.
   */
  close(): void {
    clearInterval(this.timer);
    // Nothing more is started from here, whatever is moved to Build on the way out.
    this.held = true;
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      run.stopped = true;
      this.putBack(run.id, 'the page was stopped; back in build');
      this.end(run.child);
      fs.rmSync(promptFile(run.id, process.pid), { force: true });
    }
  }

  /** Put a thread the page handed out back in Build, if it is still out. */
  private putBack(id: string, why: string): void {
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task?.status !== 'active') return;
        task.status = 'open';
        task.by = undefined;
        addLog(task, 'page', why, ws.now());
        ws.save(task);
      } finally {
        ws.close();
      }
    } catch {
      // The store could not be written; the next page to start finds the thread and puts it back.
    }
  }

  /**
   * A page that ended without settling (killed outright, or a version before this
   * one) leaves its thread marked as handed out with nobody on it. On start, put
   * back every thread whose last claim was a page's hand-off where no page has an
   * agent on it: a running agent's prompt file, named with its page's pid, lives as long as it does.
   */
  private recover(): void {
    let orphans: string[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        orphans = tasks(ws, this.project)
          .filter((t) => t.status === 'active' && handedByPage(t) && !pageRunning(t.id))
          .map((t) => t.id);
      } finally {
        ws.close();
      }
    } catch {
      return;
    }
    for (const id of orphans) this.putBack(id, 'its page had stopped with nobody working it; back in build');
  }

  /**
   * Stop the agent on one thread, at once. Its thread goes back to Build as stopped, and is left
   * there until the human carries on with it. The runner stays on, and its other agents work on.
   * False if no agent of this page's is on the thread.
   */
  stop(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.stopped = true;
    this.end(run.child);
    return true;
  }

  /** Stop every agent that is working, each as `stop` does, and switch the runner off. */
  stopAll(): void {
    if (!this.runs.size) return;
    this.on = false;
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  /**
   * The thread was moved by the human while it was being built: if an agent of this page's is
   * on it, end that agent. Moved back to the backlog, what the agent changed is undone once it has gone.
   */
  abort(id: string, undo = false): boolean {
    const run = this.runs.get(id);
    if (run && undo) run.undo = true;
    return this.stop(id);
  }

  /**
   * Build this thread next, ahead of the rest of Build: now, if there is room for it.
   * True if its agent is started.
   */
  take(id: string): boolean {
    if (!this.first.includes(id)) this.first.push(id);
    this.wake();
    return this.runs.has(id);
  }

  /** Whether the human has asked for this thread next, and it waits only for room. */
  isNext(id: string): boolean {
    return this.first.includes(id);
  }

  /** Something has just landed in Build: look now, without waiting for the next tick. */
  wake(): void {
    this.fill();
  }

  /**
   * Undo what an agent this page ran changed on a thread moved back to the
   * backlog, once the agent is gone: files it changed and did not commit go
   * back to how they were, then the commits with its trailer are reverted.
   * Files that were already changed when it began are left alone: they may be the human's.
   */
  private undoEdits(run: Run): string {
    if (run.worktree) return this.undoWorktree(run, run.worktree);
    const { id, before } = run;
    const said: string[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      let root: string | null = null;
      let dir = '';
      try {
        const task = ws.find(id);
        if (task) {
          root = repoRoot(run.folder);
          dir = task.spool.dir;
        }
      } finally {
        ws.close();
      }
      // Without a record of how things were, nothing uncommitted is touched: it could be anyone's.
      // The same holds where another agent was at work in the folder: some of it is that agent's.
      if (root && before && run.shared) said.push('uncommitted files left as they are, since another agent was working in the same folder');
      else if (root && before) {
        const now = dirtyPaths(root, dir) ?? [];
        const its = now.filter((p) => !before.has(p));
        discardPaths(root, its);
        if (its.length) said.push(`${its.length} uncommitted file(s) put back`);
      }
    } catch (error) {
      said.push(`its uncommitted edits could not be put back (${(error as Error).message})`);
    }
    const undone = act(this.ctx, ['propose', '--undo', id]);
    const shas = ((undone.data as { reverted?: Record<string, string[]> } | null)?.reverted ?? {})[id] ?? [];
    if (!undone.ok) said.push(`its commits could not be undone: ${undone.text}`);
    else if (shas.length) said.push(`${shas.length} commit(s) reverted`);
    const line = said.length ? `edits undone: ${said.join('; ')}` : 'edits undone: it had changed nothing';
    this.note(id, [line]);
    return line;
  }

  /**
   * The same, for a run in a worktree of its own. Taking the thread back to the backlog removed the
   * worktree and its branch already, with every commit made there: none of it had landed, and the
   * checkout was never touched. Nothing uncommitted is put back, since the folder it was in is gone.
   * What is left: a folder the agent may have written on its way out, and any commit of the thread's
   * that did land on the checkout before, which is reverted as anywhere.
   */
  private undoWorktree(run: Run, worktree: { folder: string; branch: string }): string {
    const said: string[] = [];
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        const task = ws.find(run.id);
        if (task) {
          // What `propose --abort` took with the worktree, as it wrote it on the thread.
          const removed = splitBody(task.body)
            .log.map((line) => / worktree and branch \S+ removed(?:, with (\d+) commit\(s\) that never landed)?/.exec(line))
            .filter(Boolean)
            .at(-1);
          const lost = Number(removed?.[1] ?? 0);
          said.push(lost ? `its worktree and branch are gone, with the ${lost} commit(s) made there` : 'its worktree and branch are gone; nothing had been committed there');
          // Started again since, it has a worktree that is not this run's to touch.
          const left = task.worktree ? null : closeWorktree({ ...task, worktree: worktree.folder, branch: worktree.branch });
          if (left?.problem) said.push(left.problem);
        }
      } finally {
        ws.close();
      }
    } catch (error) {
      said.push(`its worktree could not be looked at (${(error as Error).message})`);
    }
    const undone = act(this.ctx, ['propose', '--undo', run.id]);
    const shas = ((undone.data as { reverted?: Record<string, string[]> } | null)?.reverted ?? {})[run.id] ?? [];
    if (!undone.ok) said.push(`its commits could not be undone: ${undone.text}`);
    else said.push(shas.length ? `${shas.length} commit(s) that had landed reverted` : 'nothing had reached the checkout');
    const line = `edits undone: ${said.join('; ')}`;
    this.note(run.id, [line]);
    return line;
  }

  /**
   * End the agent and whatever it started: it runs in a group of its own, so the whole group is
   * told. A stuck agent may not listen, so what is left of the group a moment later is killed.
   */
  private end(child: ChildProcess): void {
    endGroup(child);
    setTimeout(() => endGroup(child, 'SIGKILL'), END_GRACE_MS).unref();
  }

  private tick(): void {
    this.held = !!this.upkeep?.();
    this.fill();
  }

  /** Start an agent on each waiting thread there is room for. */
  private fill(): void {
    if (this.held || !this.on) return;
    // A chat builds here: nothing is started from the page.
    if (this.builder === 'chat') return;
    // The user's number is for the whole page; a project whose threads would share its folder gets one of them at most.
    // A thread that could not be started is not tried again until it changes, so each try here either starts one or moves on.
    let room = parallelOf(this.ctx) - this.runs.size;
    for (let tries = 0; room > 0 && tries < 100; tries++) {
      const out = this.handOut();
      if (out === 'none') return;
      if (out === 'started') room--;
    }
  }

  /** Take a run on. It takes the place of the run that chose its thread's model, where there was one. */
  private keep(run: Run): void {
    run.shared = this.runs.get(run.id)?.shared;
    // Two agents in one folder: what either leaves uncommitted there cannot be told from the other's.
    for (const other of this.runs.values()) {
      if (other.id !== run.id && other.folder === run.folder) other.shared = run.shared = true;
    }
    this.runs.set(run.id, run);
  }

  /**
   * Hand the next waiting thread to an agent, in a git worktree of its own: made now, or the one it
   * kept from a stop. Where the project cannot have one, the agent works in the project's folder,
   * and no other thread of it is handed out until that one is over.
   */
  private handOut(): HandOut {
    let task: Item | undefined;
    let handed: Handed;
    let prompt = '';
    let command = this.agent;
    let asker: string | undefined;
    let briefText = '';
    const { models, router } = userConfig(this.ctx);
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        // A thread an agent of this page's is on is never handed out twice, however long it has gone quiet.
        const waiting = ready(ws, this.project).filter((t) => !this.runs.has(t.id));
        // What was dragged into Building and still waits comes first; the rest of Build follows, top first.
        this.first = this.first.filter((id) => waiting.some((t) => t.id === id));
        // A project whose threads would share its folder, with an agent at work there already: the rest of it waits.
        const why = new Map<string, string>();
        const shares = (t: Item): string => {
          if (!why.has(t.spool.root)) why.set(t.spool.root, sharedFolderWhy(t.spool.root));
          return why.get(t.spool.root)!;
        };
        const inOwnFolder = new Set([...this.runs.values()].filter((r) => !r.worktree).map((r) => r.folder));
        const free = waiting.filter((t) => !inOwnFolder.has(t.spool.root) || !shares(t));
        // Left where they are: a thread whose agent walked away, until something about it changes, and one the human stopped.
        task =
          this.first.map((id) => free.find((t) => t.id === id)).find(Boolean) ??
          free.find((t) => this.gaveUp.get(t.id) !== t.updated && !stoppedInBuild(t));
        if (!task) return 'none';
        const taken = task.id;
        this.first = this.first.filter((id) => id !== taken);
        const shared = shares(task);
        if (shared) {
          // Said once on the thread, the first time it is built so: it is the same every time after.
          if (!splitBody(task.body).log.some((line) => line.includes(OWN_FOLDER))) {
            addLog(task, 'page', `${OWN_FOLDER}${shared}, so its threads are built one at a time`, ws.now());
          }
        } else {
          try {
            openWorktree(task);
          } catch (error) {
            // Not this tick, and not every second after: it waits in Build until something about it changes.
            const e = error as SpoolError;
            addLog(task, 'page', `not started: it could not have a worktree of its own (${e.message}${e.hint ? `. ${e.hint}` : ''})`, ws.now());
            ws.save(task);
            this.gaveUp.set(task.id, task.updated);
            return 'skipped';
          }
        }
        const folder = runFolder(task);
        // In a worktree of its own, nothing there is anyone else's: it is the run's to keep or lose whole.
        const root = task.worktree ? null : repoRoot(folder);
        const dirty = root ? dirtyPaths(root, task.spool.dir) : null;
        handed = {
          id: task.id,
          title: task.title,
          folder,
          before: dirty ? new Set(dirty) : null,
          worktree: task.worktree ? { folder: task.worktree, branch: task.branch ?? '' } : undefined,
        };
        command = streaming(commandFor(this.agent, pickFor(task, models)));
        asker = routerCommand(this.agent, task, models, router);
        task.status = 'active';
        task.by = this.name();
        task.started = timestamp(ws.now());
        if (!asker) addLog(task, 'page', `handed to \`${command}\``, ws.now());
        ws.save(task);
        briefText = brief(ws, task, paint(false));
        prompt = `${PREAMBLE}\n${prime(ws, 'worker')}\n\nYOUR TASK\n\n${briefText}\n`;
      } finally {
        ws.close();
      }
    } catch {
      return 'none'; // The store was busy for an instant; the next tick looks again.
    }
    this.handedOut++;
    if (asker) this.route(task, handed, prompt, briefText, asker);
    else this.start(task, handed, prompt, command);
    return 'started';
  }

  /**
   * Pass the thread to Fable first, to choose which model works it and how hard
   * it thinks; then start that. While Fable reads, the thread shows as building
   * and Stop ends Fable. If Fable cannot answer, the size decides.
   */
  private route(task: Item, handed: Handed, prompt: string, briefText: string, asker: string): void {
    const child = spawn(asker, {
      shell: true,
      cwd: handed.folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...this.ctx.env, SPOOL_ROUTING: task.id },
    });
    const run: Run = { ...handed, child, lines: [`${ROUTER} is choosing the model…`], began: Date.now(), stopped: false };
    this.keep(run);
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      if (out.length < 1024 * 1024) out += chunk.toString('utf8');
    });
    child.stderr!.on('data', () => {});
    child.stdin!.on('error', () => {});
    child.stdin!.end(routerPrompt(task, briefText));
    const timer = setTimeout(() => this.end(child), ROUTE_TIMEOUT_MS);
    let over = false;
    const end = (code: number | null, how: string): void => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      if (run.stopped || this.runs.get(run.id) !== run) {
        this.settle(run, how);
        return;
      }
      const routed = code === 0 ? parseRoute(out) : undefined;
      const note = routeNote(routed, routed ? undefined : code === 0 ? 'no answer it could read' : how);
      const command = streaming(commandFor(this.agent, pickFor(task, userConfig(this.ctx).models, routed)));
      let still = true;
      try {
        const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
        try {
          const now = ws.find(task.id);
          still = now?.status === 'active';
          if (now && still) {
            addLog(now, 'page', note, ws.now());
            addLog(now, 'page', `handed to \`${command}\``, ws.now());
            ws.save(now);
          }
        } finally {
          ws.close();
        }
      } catch {
        // The notes are only notes; the run goes ahead without them.
      }
      // Someone took the thread back while Fable read it; there is nothing to start.
      if (still) this.start(task, handed, prompt, command);
      else this.settle(run, how);
    };
    child.on('error', (error) => end(null, `could not start (${error.message})`));
    child.on('exit', (code, signal) => end(code, `exited ${code ?? signal}`));
  }

  /**
   * The user's table of which model and effort each size gets, and the model that
   * chooses first for a thread, if one does: read fresh so a change shows at once.
   */
  routing(): Picking {
    const { models, router } = userConfig(this.ctx);
    const by = (typeof router === 'string' && router) || ROUTER;
    return { models, chooser: (task) => (routerCommand(this.agent, task, models, router) ? by : '') };
  }

  /** What the agent is called on the thread: the program it is, so "claude" shows as Claude. */
  private name(): string {
    return this.ctx.env.SPOOL_ACTOR ?? path.basename(this.agent.trim().split(/\s+/)[0] ?? 'agent');
  }

  private start(task: Item, handed: Handed, prompt: string, command: string): void {
    const file = promptFile(task.id, process.pid);
    fs.writeFileSync(file, prompt);
    const child = spawn(command.replaceAll('{prompt_file}', file), {
      shell: true,
      cwd: handed.folder,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
      env: { ...this.ctx.env, SPOOL_ACTOR: this.name(), SPOOL_TASK: task.id, SPOOL_PROMPT_FILE: file },
    });
    const run: Run = { ...handed, child, lines: [], began: Date.now(), stopped: false };
    this.keep(run);
    // Everything the agent prints is kept with the thread as it came, stderr as events of its own.
    let transcript: string | undefined;
    let keep: number | undefined;
    try {
      transcript = transcriptFile(task.spool.dir, task.id, new Date(run.began));
      keep = fs.openSync(transcript, 'a');
    } catch {
      transcript = undefined; // Nowhere to keep it; the run goes ahead without.
    }
    const shown = transcript ? path.relative(task.spool.root, transcript) : '';
    const keepRaw = (text: string): void => {
      if (keep === undefined) return;
      try {
        fs.writeSync(keep, text);
      } catch {
        // A full disk loses the transcript, not the run.
      }
    };
    // What goes on the thread's log: its session, and each tool call it was refused.
    const notes: string[] = [];
    let session: string | undefined;
    const hear = (line: string): void => {
      // A line at a time, without the terminal's colour codes.
      const heard = hearLine(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
      for (const l of heard.lines) run.lines.push(l.slice(0, 400));
      if (run.lines.length > LIVE_LINES) run.lines.splice(0, run.lines.length - LIVE_LINES);
      let tell = false;
      if (heard.session && !session) {
        session = heard.session;
        notes.push(`session ${session}${shown ? ` · transcript ${shown}` : ''} · open it with \`claude --resume ${session}\``);
        tell = true;
      }
      for (const d of heard.denials ?? []) {
        notes.push(`permission denied: ${d}`);
        tell = true;
      }
      if (tell) this.note(task.id, notes);
    };
    const reader = (stderr: boolean) => {
      let rest = '';
      const take = (part: string): void => {
        if (stderr && part.trim()) keepRaw(`${JSON.stringify({ type: 'stderr', text: part })}\n`);
        hear(part);
      };
      return {
        data: (chunk: Buffer): void => {
          const text = chunk.toString('utf8');
          if (!stderr) keepRaw(text);
          const parts = (rest + text).split('\n');
          rest = parts.pop() ?? '';
          parts.forEach(take);
        },
        flush: (): void => {
          if (rest) take(rest);
          rest = '';
        },
      };
    };
    const out = reader(false);
    const err = reader(true);
    child.stdout!.on('data', out.data);
    child.stderr!.on('data', err.data);
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
    let over = false;
    const end = (how: string): void => {
      if (over) return;
      over = true;
      out.flush();
      err.flush();
      if (keep !== undefined) fs.closeSync(keep);
      fs.rmSync(file, { force: true });
      // A run with no session still says where its transcript is; notes the store was too busy for go now.
      if (!session && transcript && fs.statSync(transcript).size > 0) notes.push(`transcript ${shown}`);
      this.note(task.id, notes);
      this.settle(run, how);
    };
    child.on('error', (error) => end(`could not start (${error.message})`));
    child.on('exit', (code, signal) => end(`exited ${code ?? signal}`));
  }

  /** Write a run's notes on its thread and empty the list; if the store is busy they wait for the next try. */
  private note(id: string, notes: string[]): void {
    if (!notes.length) return;
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const task = ws.find(id);
        if (task) {
          for (const n of notes) addLog(task, 'page', n, ws.now());
          ws.save(task);
        }
        notes.length = 0;
      } finally {
        ws.close();
      }
    } catch {
      // Busy for an instant; they go with the next note, or when the agent exits.
    }
  }

  private settle(run: Run, how: string): void {
    let outcome = 'gone';
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const now = ws.find(run.id);
        if (now?.status === 'done') outcome = 'done';
        else if (now?.status === 'proposed') outcome = 'aborted: back in the backlog';
        else if (now?.status === 'active') {
          // The agent left without finishing or asking, or was stopped. Put the thread back, and do not spin on it:
          // what the human stopped waits for them, as its log now says, and the rest waits for something to change.
          now.status = 'open';
          now.by = undefined;
          addLog(now, 'page', run.stopped ? 'stopped from the page; back in build' : `agent ${how} without finishing; back in build`, ws.now());
          ws.save(now);
          if (!run.stopped) this.gaveUp.set(now.id, now.updated);
          outcome = run.stopped ? 'stopped' : `unfinished: the agent ${how}${run.lines.length ? ` — ${run.lines.at(-1)}` : ''}`;
        } else if (now?.status === 'open' && run.stopped && !now.needs.length) {
          // Dragged back to Build while it was being built: that is a stop too, and its log says so.
          outcome = 'stopped: waiting in build';
        } else if (now) outcome = `waiting${now.needs.length ? ' on you' : ''}`;
      } finally {
        ws.close();
      }
    } catch {
      outcome = 'unknown: the spool could not be read';
    }
    if (run.undo) outcome = `back in the backlog; ${this.undoEdits(run)}`;
    this.recent.unshift({ id: run.id, title: run.title, outcome });
    this.recent.splice(5);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
  }
}

// ------------------------------------------------------------------ the page keeps its own code current

/** Where the code this page runs was loaded from: the package's dist/, or src/ when it is run from source. */
const CODE_FILE = fileURLToPath(import.meta.url);
const CODE_DIR = path.dirname(CODE_FILE);
const CODE_EXT = path.extname(CODE_FILE);

/** The code files beside this one. */
function codeFiles(): string[] {
  return fs.readdirSync(CODE_DIR).filter((name) => name.endsWith(CODE_EXT)).sort();
}

/** The size and time of every code file: cheap to take, and different whenever a build has written. */
function codeStamp(): string {
  try {
    return codeFiles()
      .map((name) => {
        const stat = fs.statSync(path.join(CODE_DIR, name));
        return `${name} ${stat.size} ${stat.mtimeMs}`;
      })
      .join('\n');
  } catch {
    return ''; // A build is moving the files about; the next look sees them.
  }
}

/** A short name for exactly this code. The same files with the same contents always give the same one. */
export function buildId(): string {
  try {
    const hash = createHash('sha256');
    for (const name of codeFiles()) hash.update(`${name}\n`).update(fs.readFileSync(path.join(CODE_DIR, name))).update('\n');
    return hash.digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * Spool building Spool. The page serves the code it was started from. Where that is a checkout
 * of Spool with its sources beside it, and not an installed copy, the code is only as new as the
 * last `npm run build`; and where that checkout is a project this page builds, agents are
 * changing those sources. Only then does the page rebuild, and this is the folder to do it in.
 */
function ownCheckout(ctx: Ctx, project: string | undefined): string | undefined {
  const root = path.dirname(CODE_DIR);
  try {
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
    if (typeof scripts?.build !== 'string' || !fs.statSync(path.join(root, 'src')).isDirectory()) return undefined;
    const real = fs.realpathSync(root);
    const ws = Workspace.open(ctx.cwd, ctx.now);
    try {
      const built = project ? [ws.project(project)] : ws.spools;
      return built.some((s) => fs.realpathSync(s.root) === real) ? root : undefined;
    } finally {
      ws.close();
    }
  } catch {
    return undefined; // No package.json, no sources, no spool: nothing of Spool's own to build here.
  }
}

/** How long the code on disk must have been still before it is taken for a finished build. */
const SETTLE_MS = 2000;
/** What the page says while it lets its agents finish before restarting onto new code. */
const DRAINING = 'A new build of Spool is on disk. Nothing new is started until the agents at work now have finished; then this page restarts onto it.';
/** How long new work waits for a restart that is on its way. */
const HOLD_MS = 30_000;
const REBUILD_MINUTES = 10;

/**
 * The page keeping its own code current, so that what is marked done is what the page shows.
 * Two things, looked at once a second:
 *
 *   - When Build and Building have both emptied after work was in them, and this page builds
 *     Spool's own checkout, it runs `npm run build` there. Never sooner: a build made while a
 *     thread is being built bakes in an agent's half-made edits, and a `spool` call made while
 *     the build writes can find half a file.
 *   - When the code on disk is no longer the code this process loaded (that rebuild, anyone
 *     else's, an upgrade, or a thread landing on Spool's own sources), it starts nothing new,
 *     and once no agent of this page's is running it restarts onto it. The
 *     board carries the name of the build that serves it, and an open page that sees another
 *     name reloads itself.
 *
 * A build that failed, or one that does not start, is never restarted onto: the page stays as it
 * is, and says so.
 */
export class Upkeep {
  /** The name of the code this process loaded. */
  readonly build: string;
  /** What the human should know about the page itself, shown on it: it is rebuilding, or a rebuild failed. */
  notice = '';
  /** The code on disk as it was when this process loaded it, or as it was last found to be the same. */
  private loaded: string;
  /** The newest code on disk that is not what was loaded: when it was first seen so, and its name once worked out. */
  private seen = { stamp: '', at: 0, id: '' };
  /** When the code on disk was first found changed, for as long as that is not settled. */
  private changed = 0;
  /** Code on disk that is not to be started: a failed build left it, or it was tried and did not start. */
  private refused = '';
  /** Something has been in Build or Building since the last rebuild. */
  private worked = false;
  /** How many threads the runner had handed out at the last look. */
  private counted = 0;
  private building = false;
  private over = false;
  private ctx: Ctx;
  private project: string | undefined;
  private runner: Runner;
  private own: string | undefined;
  private restart: ((agentsOn: boolean) => void) | undefined;

  constructor(ctx: Ctx, project: string | undefined, runner: Runner, restart?: (agentsOn: boolean) => void) {
    this.ctx = ctx;
    this.project = project;
    this.runner = runner;
    this.build = buildId();
    this.loaded = codeStamp();
    this.own = ownCheckout(ctx, project);
    // With no name for what was loaded, there is nothing to hold the disk against.
    this.restart = this.build && this.loaded ? restart : undefined;
  }

  /** One look. True while nothing new should be started: a rebuild is running, or a restart is on its way. */
  check(): boolean {
    if (this.over) return true;
    try {
      this.rebuildWhenIdle();
      return this.restartWhenNew() || this.building;
    } catch {
      return this.building; // The spool was busy for an instant; the next look is a second away.
    }
  }

  close(): void {
    this.over = true;
  }

  private rebuildWhenIdle(): void {
    if (!this.own || this.building) return;
    // A thread the runner took the moment it landed in Build may be finished before this look: it was work.
    if (this.counted !== this.runner.handedOut) {
      this.counted = this.runner.handedOut;
      this.worked = true;
    }
    // An agent that has said done may still be on its way out: it counts until it has gone.
    let busy = this.runner.runs.size > 0;
    if (!busy) {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        busy = tasks(ws, this.project).some((t) => {
          const column = columnOf(taskState(ws, t));
          return column === 'build' || column === 'building';
        });
      } finally {
        ws.close();
      }
    }
    if (busy) {
      this.worked = true;
      return;
    }
    if (!this.worked) return;
    this.worked = false;
    this.rebuild(this.own);
  }

  private rebuild(root: string): void {
    const kept = path.join(os.tmpdir(), `spool-rebuild-${process.pid}.log`);
    let log: number | undefined;
    try {
      log = fs.openSync(kept, 'w');
    } catch {
      log = undefined; // Nowhere to keep what it prints; it runs all the same.
    }
    this.building = true;
    this.notice = 'Build and Building are empty, so Spool is being rebuilt. This page reloads itself if anything changed.';
    const child = spawn('npm run build', {
      shell: true,
      cwd: root,
      // Printing to a file, in a group of its own: a page stopped mid-build must not leave half a build behind.
      stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      detached: process.platform !== 'win32',
      env: this.ctx.env,
    });
    if (log !== undefined) fs.closeSync(log);
    const timer = setTimeout(() => endGroup(child), REBUILD_MINUTES * 60_000);
    let ended = false;
    const end = (failed: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      let said = '';
      try {
        // The last thing the build itself said, past npm's own lines about it.
        const lines = fs.readFileSync(kept, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
        said = lines.filter((line) => !/^(npm |>)/.test(line)).at(-1) ?? lines.at(-1) ?? '';
        fs.rmSync(kept, { force: true });
      } catch {
        // What it printed is lost; how it ended is still known.
      }
      this.building = false;
      if (!failed) {
        this.notice = '';
        return;
      }
      // Whatever a failed build left on disk is not started.
      this.refused = codeStamp();
      this.notice = `Rebuilding Spool ${failed}, so this page is still the build from before${said ? `: ${oneLine(said, 300)}` : '.'}`;
    };
    child.on('error', (error) => end(`could not run (${error.message})`));
    child.on('exit', (code, signal) => end(code === 0 ? '' : signal ? `was stopped (${signal})` : `failed (exit ${code})`));
  }

  /**
   * True while a restart is on its way, so that nothing is started only to be ended by it. With
   * several agents at once, one finishing makes room for the next, and a moment with none at work
   * might never come: so once new code is waiting, nothing new starts, and the page restarts as
   * soon as the last agent has gone.
   */
  private restartWhenNew(): boolean {
    if (!this.restart) return false;
    if (this.notice === DRAINING) this.notice = '';
    const stamp = codeStamp();
    if (!stamp || stamp === this.loaded || stamp === this.refused) {
      this.changed = 0;
      return false;
    }
    const now = Date.now();
    if (stamp !== this.seen.stamp) this.seen = { stamp, at: now, id: '' };
    this.changed ||= now;
    const soon = now - this.changed < HOLD_MS;
    // A build may still be writing: wait until the files have been still for a moment.
    if (this.building || now - this.seen.at < SETTLE_MS) return soon;
    this.seen.id ||= buildId();
    if (!this.seen.id) return soon;
    if (this.seen.id === this.build) {
      // Written again, and the same code: there is nothing to restart for.
      this.loaded = stamp;
      this.changed = 0;
      return false;
    }
    // Never under an agent: a restart would end it. It comes when the last of them has gone, and none is started meanwhile.
    if (this.runner.runs.size) {
      this.notice = DRAINING;
      return true;
    }
    if (!this.starts()) {
      this.refused = stamp;
      this.changed = 0;
      this.notice = 'A new build of Spool is on disk, but it does not start, so this page is still the build from before.';
      return false;
    }
    try {
      this.restart(this.runner.on);
    } catch {
      // It could not be handed over; this page carries on as it is.
      this.refused = stamp;
      this.changed = 0;
      return false;
    }
    this.over = true;
    return true;
  }

  /** Whether the code now on disk starts at all: the whole of it is loaded, in a process of its own. */
  private starts(): boolean {
    const ran = spawnSync(process.execPath, [...process.execArgv, path.join(CODE_DIR, `cli${CODE_EXT}`), '--version'], { stdio: 'ignore', timeout: 30_000 });
    return ran.status === 0;
  }
}

// ------------------------------------------------------------------ what a thread changed

const PATCH_LIMIT = 200_000;

interface Diff {
  commits: { sha: string; subject: string }[];
  files: { path: string; added: number; removed: number }[];
  patch: string;
  /** The patch was too long to send whole. */
  cut: boolean;
}

/** The files and lines a thread's commits changed: what "Mark as complete" is a judgement of. */
export function diffOf(ws: Workspace, id: string): Diff {
  const task = ws.get(id, 'task');
  const root = repoRoot(task.spool.root);
  const diff: Diff = { commits: [], files: [], patch: '', cut: false };
  if (!root) return diff;
  const files = new Map<string, { added: number; removed: number }>();
  for (const sha of task.commits) {
    const stat = git(root, ['show', '--no-color', '--format=%h%x09%s', '--numstat', sha]);
    if (!stat.ok) continue;
    const [head, ...lines] = stat.out.split('\n');
    const [short, subject] = (head ?? '').split('\t');
    diff.commits.push({ sha: short ?? sha.slice(0, 7), subject: subject ?? '' });
    for (const line of lines) {
      const [added, removed, file] = line.split('\t');
      if (!file) continue;
      const sum = files.get(file) ?? { added: 0, removed: 0 };
      // A binary file reports "-" for both; it changed, and that is all there is to say.
      sum.added += Number(added) || 0;
      sum.removed += Number(removed) || 0;
      files.set(file, sum);
    }
    if (diff.patch.length < PATCH_LIMIT) diff.patch += `${git(root, ['show', '--no-color', '--format=', '--patch', sha]).out}\n`;
  }
  diff.files = [...files].map(([file, sum]) => ({ path: file, ...sum }));
  diff.cut = diff.patch.length > PATCH_LIMIT;
  diff.patch = diff.patch.slice(0, PATCH_LIMIT).trimEnd();
  return diff;
}

// ------------------------------------------------------------------ the server

interface Started {
  url: string;
  server: http.Server;
  /** What a POST must carry: kept in the page's record, so `spool agents` on this machine can use it. */
  token: string;
}

/** Run one command as the human, in-process, and say whether it worked. */
function act(ctx: Ctx, argv: string[]): { ok: boolean; text: string; data: unknown } {
  const out: string[] = [];
  const err: string[] = [];
  // --json goes first: after a `--`, everything is the human's words.
  const code = run(['--json', ...argv], {
    ...ctx,
    env: { ...ctx.env, SPOOL_ACTOR: 'human' },
    // Everything the page does is a click a person made on it.
    human: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  });
  let data: unknown = null;
  try {
    data = JSON.parse(out.join('\n'));
  } catch {
    // Not every failure is JSON; the text below carries it.
  }
  const failed = (data as { error?: string } | null)?.error;
  return { ok: code === 0, text: failed ?? err.join('\n') ?? '', data };
}

type Body = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * A thread dragged to any column, from any column, at any time. Each move is the
 * commands a person would have typed for it:
 *
 *   - Backlog: off whoever is building it, and its work undone. An agent this
 *     page runs is ended first, then the files it changed and its commits are put back.
 *   - Build: it waits there. One being built is stopped with its work kept, and stays stopped until carried on; one done is reverted.
 *   - Building: this page builds it next, with agents switched on: now, if there is room. Where a chat builds, it waits in Build for the chat.
 *   - Done: the human marking it done; an agent of this page's on it is ended.
 */
function moveThread(ctx: Ctx, runner: Runner, id: string, to: string): { ok: boolean; text: string; data?: unknown } {
  if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
  if (!['proposed', 'build', 'building', 'done'].includes(to)) return { ok: false, text: 'a thread can be moved to the backlog, build, building or done' };
  let from: Column | null;
  let title = '';
  const ws = Workspace.open(ctx.cwd, ctx.now);
  try {
    const task = ws.get(id, 'task');
    from = columnOf(taskState(ws, task));
    title = task.title;
  } finally {
    ws.close();
  }
  if (!from) return { ok: false, text: `${id} was dropped` };
  if (from === to) return { ok: true, text: '' };
  const ours = runner.runs.has(id);

  if (to === 'proposed') {
    if (from === 'build') return act(ctx, ['propose', id]);
    if (from === 'building' && ours) {
      // Moved now, so the agent cannot finish it; its edits come off once it has gone.
      const moved = act(ctx, ['propose', '--abort', id]);
      if (moved.ok) runner.abort(id, true);
      return moved.ok ? { ...moved, text: 'Stopped, and back in the backlog. What the agent changed is being undone.' } : moved;
    }
    const undone = act(ctx, ['propose', '--undo', id]);
    return undone.ok ? { ...undone, text: `Back in the backlog, its commits undone: ${title}` } : undone;
  }

  if (to === 'build') {
    if (from === 'proposed') {
      const built = act(ctx, ['build', id]);
      // In Build is the human saying start: with room for it, its agent starts now.
      if (built.ok) runner.wake();
      return built;
    }
    if (from === 'done') {
      const reverted = act(ctx, ['revert', id, '--message=moved back to build on the page']);
      return reverted.ok ? { ...reverted, text: `Undone, and back in build: ${title}` } : reverted;
    }
    const stopped = act(ctx, ['build', '--abort', id]);
    if (stopped.ok) runner.abort(id);
    return stopped.ok ? { ...stopped, text: `Stopped, with its work kept. It waits in build until you carry on: ${title}` } : stopped;
  }

  if (to === 'building') {
    if (from === 'done') {
      const reverted = act(ctx, ['revert', id, '--message=moved back to building on the page']);
      if (!reverted.ok) return reverted;
    }
    if (from === 'proposed') {
      const built = act(ctx, ['build', id]);
      if (!built.ok) return built;
    }
    const check = Workspace.open(ctx.cwd, ctx.now);
    let state = '';
    try {
      state = taskState(check, check.get(id, 'task'));
    } finally {
      check.close();
    }
    if (state !== 'ready') return { ok: true, text: `In build, but it cannot start yet: it is ${state}.` };
    // With a chat building, the page starts nothing: the thread waits in Build for the chat to take.
    if (runner.builder === 'chat') return { ok: true, text: `In build, for the chat to take: ${title}` };
    runner.on = true;
    return { ok: true, text: runner.take(id) ? `Building now: ${title}` : `Next up, once an agent is free: ${title}` };
  }

  // Done: the human saying it is finished. A thread still in the backlog goes through build, as any start does.
  if (from === 'proposed') {
    const built = act(ctx, ['build', id]);
    if (!built.ok) return built;
  }
  const done = act(ctx, ['done', id, '--message=Marked done on the page']);
  if (!done.ok) {
    if (from === 'proposed') act(ctx, ['propose', id]);
    return done;
  }
  if (ours) runner.abort(id);
  return { ...done, text: `Done: ${title}` };
}

/** What the page can do. Each is the command a person would have typed. */
function change(ctx: Ctx, action: string, body: Body, project?: string): { ok: boolean; text: string } {
  const id = text(body.id);
  if (action === 'complete-all') {
    // Every finished thread still to check, approved in one go. Only threads: the calls agents made are not swept in.
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      ids = review(ws, project ? ws.project(project) : ws.home).shipped.map((t) => t.id);
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing left to check.' };
  }
  if (action === 'move-many') {
    // "Add to Build" at the foot of the backlog: exactly the threads the page was showing, and no others.
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length || ids.length > 500 || !ids.every((x) => /^t-[a-z0-9]+$/.test(x))) return { ok: false, text: 'which threads?' };
    return act(ctx, ['build', ...ids]);
  }
  if (action === 'add') {
    const words = text(body.text);
    const to = text(body.to);
    if (!words) return { ok: false, text: 'say what to add' };
    if (to !== 'proposed' && to !== 'build') return { ok: false, text: 'a thread can be added to proposed, or to build' };
    // Their words are kept whole as the note; the thread's name is the first line of them.
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'it could not be saved' };
    const filed = act(ctx, ['task', '--from', note, '--', oneLine(words.split('\n')[0]!, 110)]);
    const task = (filed.data as { task?: { id?: string; status?: string } } | null)?.task;
    if (!filed.ok || !task?.id) return { ok: false, text: filed.text || 'it could not be filed' };
    // Adding it under Build is the human putting it in build; under Proposed it waits, gate or no gate.
    if (to === 'build' && task.status === 'proposed') return act(ctx, ['build', task.id]);
    if (to === 'proposed' && task.status !== 'proposed') return act(ctx, ['propose', task.id]);
    return { ok: true, text: '' };
  }
  if (action === 'note') {
    const words = text(body.text);
    if (!words) return { ok: false, text: 'the note is empty' };
    if (id && !/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    // Their words, exactly, as a note; on a thread, it is attached to it.
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'the note could not be saved' };
    if (!id) return { ok: true, text: '' };
    const filed = act(ctx, ['file', note, '--into', id]);
    if (filed.ok || !/already (done|dropped)/.test(filed.text)) return filed;
    // A reply on finished work is feedback on it: new work, linked to what it answers, and proposed like any other.
    const next = act(ctx, ['task', '--from', note, '--from', id, '--', oneLine(words.split('\n')[0]!, 110)]);
    return next.ok ? { ok: true, text: 'That thread is finished, so your reply is a new proposed thread linked to it.' } : next;
  }
  if (action === 'sprint') {
    const name = text(body.name);
    return name ? act(ctx, ['sprint', ...(project ? [`--project=${project}`] : []), '--', name]) : { ok: false, text: 'the sprint needs a name' };
  }
  if (action === 'assign') {
    // Into a sprint, or back to the backlog.
    const sprint = text(body.sprint);
    if (!/^t-[a-z0-9]+$/.test(id) || (sprint && !/^r-[a-z0-9]+$/.test(sprint))) return { ok: false, text: 'which thread, and which sprint?' };
    return act(ctx, ['edit', id, `--sprint=${sprint || 'none'}`]);
  }
  if (action === 'sprint-about') {
    // What a sprint is for, written or changed on the page: its goal, the reason, and when it is done.
    if (!/^r-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which sprint?' };
    const lines = [['Goal', body.goal], ['Why', body.why], ['Done when', body.doneWhen]]
      .map(([label, value]) => [label, text(value).replace(/\s+/g, ' ')])
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}: ${value}`);
    return act(ctx, ['edit', id, `--body=${lines.join('\n')}`]);
  }
  if (action === 'play') {
    // Pressing play on a sprint: everything in it moves to build.
    return /^r-[a-z0-9]+$/.test(id) ? act(ctx, ['play', id]) : { ok: false, text: 'which sprint?' };
  }
  if (action === 'drop-sprint') {
    // The sprint goes; what was in it is back in the backlog, untouched.
    return /^r-[a-z0-9]+$/.test(id) ? act(ctx, ['drop', id]) : { ok: false, text: 'which sprint?' };
  }
  if (action === 'edit') {
    // The ticket's fields. Each is the `spool edit` a person would have typed; the command checks the values.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    const argv = ['edit', id];
    if (typeof body.title === 'string' && body.title.trim()) argv.push(`--title=${body.title.trim()}`);
    if (typeof body.priority === 'number') argv.push(`--priority=${body.priority}`);
    if (typeof body.size === 'string' && body.size) argv.push(`--size=${body.size}`);
    // An empty model or effort is the human handing the choice back to the thread's size.
    if (typeof body.model === 'string') argv.push(`--model=${body.model.trim() || 'none'}`);
    if (typeof body.effort === 'string') argv.push(`--effort=${body.effort.trim() || 'none'}`);
    if (Array.isArray(body.tags)) argv.push(...(body.tags.length ? body.tags.map((t) => `--tag=${String(t)}`) : ['--tag=none']));
    if (typeof body.version === 'string') argv.push(`--version=${body.version.trim() || 'none'}`);
    if (argv.length === 2) return { ok: false, text: 'nothing to change' };
    return act(ctx, argv);
  }
  if (action === 'approve') {
    // "Fine", on a call an agent made, a plan, or a new skill: the human accepting it.
    return /^[dts]-[a-z0-9]+$/.test(id) ? act(ctx, ['approve', id]) : { ok: false, text: 'which one?' };
  }
  if (action === 'approve-calls') {
    // Every call agents made by themselves, accepted in one go. Plans and threads are not swept in.
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      ids = review(ws, project ? ws.project(project) : ws.home).assumptions.map((d) => d.id);
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing left to look at.' };
  }
  if (action === 'drop-skill') {
    return /^s-[a-z0-9]+$/.test(id) ? act(ctx, ['drop', id, '--message=dropped on the page']) : { ok: false, text: 'which skill?' };
  }
  if (action === 'note-thread' || action === 'note-aside') {
    // A note nobody filed: make it a thread in the backlog, or set it aside.
    if (!/^n-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which note?' };
    if (action === 'note-aside') return act(ctx, ['file', id, '--drop', '--message=set aside on the page']);
    const title = text(body.title);
    return title ? act(ctx, ['task', '--from', id, '--', oneLine(title.split('\n')[0]!, 110)]) : { ok: false, text: 'it needs a name' };
  }
  if (action === 'undo') {
    // Undo exactly what this thread changed. With their reason it is done again; dropped, it is not.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    const why = text(body.why);
    return act(ctx, ['revert', id, ...(why ? [`--message=${why}`] : []), ...(body.drop === true ? ['--drop'] : [])]);
  }
  if (action === 'archive' || action === 'unarchive') {
    // Out of sight, not dropped; and back again, just as it was.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    return act(ctx, ['archive', ...(action === 'unarchive' ? ['--undo'] : []), id]);
  }
  if (action === 'complete') {
    // "Mark as complete" is the human saying the change is good: the same as approving it.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    return act(ctx, ['approve', id]);
  }
  if (action === 'answer') {
    const choice = text(body.choice);
    if (!/^d-[a-z0-9]+$/.test(id) || !choice) return { ok: false, text: 'which question, and what is the answer?' };
    return act(ctx, ['answer', id, '--', choice]);
  }
  return { ok: false, text: `the page cannot ${action}` };
}

function send(res: http.ServerResponse, status: number, type: string, payload: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

/** What a page restarting onto new code hands to the page that takes over: the same address, and whether agents were on. */
interface Resume {
  port: number;
  run: boolean;
}

/**
 * Start the page's server. Returns once it is listening.
 *
 * `restart` is how the page gets onto new code once it finds some on disk: without it, it stays
 * on what it loaded. `resumed` says this page is taking over from one that restarted.
 */
export function startPage(
  ctx: Ctx,
  options: { port?: number; project?: string; run?: boolean; agent?: string; resumed?: boolean; restart?: (resume: Resume) => void },
  ready: (started: Started) => void,
): http.Server {
  const token = randomBytes(18).toString('base64url');
  const runner = new Runner(ctx, options.project, options.agent, !!options.run);
  const handOver = (agentsOn: boolean): void => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the page is not listening');
    // Nothing more is started from here: the page that takes over does it.
    runner.close();
    options.restart!({ port: address.port, run: agentsOn });
  };
  const upkeep = new Upkeep(ctx, options.project, runner, options.restart ? handOver : undefined);
  runner.upkeep = () => upkeep.check();
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    // Only a browser pointed at this machine: a name another site resolved here is refused.
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'not this machine');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html', PAGE.replace('__TOKEN__', token).replace('__BUILD__', upkeep.build));
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(board(ws, options.project, runner, upkeep)));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^t-[a-z0-9]+$/.test(id)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread?' }));
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(diffOf(ws, id)));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-spool-token'] !== token) return send(res, 403, 'application/json', JSON.stringify({ ok: false, text: 'reload the page' }));
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64_000) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', () => {
          let body: Body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body;
          } catch {
            return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'not JSON' }));
          }
          const action = url.pathname.slice('/api/'.length);
          // The runner is the page's own: switching it on or off, and stopping the agent it started.
          if (action === 'runner') {
            runner.on = body.on === true;
            runner.wake();
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: runner.on ? 'Agents are on: this page builds what is in Build.' : 'Agents are off.' }));
          }
          // Who builds: this page, starting the agent command, or a Claude Code chat running the loop.
          if (action === 'builder') {
            if (body.builder !== 'headless' && body.builder !== 'chat') return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'headless, or chat?' }));
            runner.builder = body.builder;
            const words =
              body.builder === 'chat'
                ? `A Claude Code chat builds now: say /spool-loop in one. This page starts no agents.${runner.runs.size ? ' What it had started is built to the end.' : ''}`
                : `This page builds now, headless. ${runner.on ? 'Agents are on.' : 'Switch Agents on to start.'}`;
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: words }));
          }
          if (action === 'move' || action === 'abort') {
            // A thread moved to any column, from any column. Abort is the move straight back to the backlog.
            const result = moveThread(ctx, runner, text(body.id), action === 'abort' ? 'proposed' : text(body.to));
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
          }
          if (action === 'order') {
            // A place in Build's line: `spool order`, after the same move to Build a drop on the column makes.
            const id = text(body.id);
            const before = text(body.before);
            const after = text(body.after);
            const spot = before ? `--before=${before}` : after ? `--after=${after}` : body.first === true ? '--first' : body.last === true ? '--last' : '';
            const ok = /^t-[a-z0-9]+$/.test(id) && spot && [before, after].every((t) => !t || /^t-[a-z0-9]+$/.test(t));
            if (!ok) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread, and where?' }));
            const moved = moveThread(ctx, runner, id, 'build');
            const result = moved.ok ? act(ctx, ['order', id, spot]) : moved;
            const words = result.ok ? (moved.text ? `${moved.text}. ` : '') + 'Build is in your order now.' : result.text;
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify({ ...result, text: words }));
          }
          if (action === 'stop') {
            // Stop on a thread ends that thread's agent and no other. With no thread named, every agent is stopped and agents are switched off.
            const id = text(body.id);
            if (!id) {
              runner.stopAll();
              return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: 'Stopped. What was being built is back in Build, and agents are off.' }));
            }
            const stopped = runner.stop(id);
            const words = stopped ? 'Stopped. It waits in Build until you carry on.' : 'No agent of this page is building that thread.';
            return send(res, stopped ? 200 : 400, 'application/json', JSON.stringify({ ok: stopped, text: words }));
          }
          const result = change(ctx, action, body, options.project);
          send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
        });
        return;
      }
      send(res, 404, 'text/plain', 'nothing here');
    } catch (error) {
      const message = error instanceof SpoolError ? error.message : 'something went wrong';
      send(res, 500, 'application/json', JSON.stringify({ ok: false, text: message }));
      if (!(error instanceof SpoolError)) ctx.err(String(error));
    }
  });
  // Once, however many ports were tried first.
  server.once('listening', () => ready({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server, token }));
  const listen = (port: number, triesLeft: number): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The usual port is taken, by another project's page perhaps: take the next one.
      if (error.code === 'EADDRINUSE' && triesLeft > 0 && !options.port) listen(port + 1, triesLeft - 1);
      // A page taking over keeps the address the open page already has: wait for the last one to let go of it.
      else if (error.code === 'EADDRINUSE' && triesLeft > 0 && options.resumed) setTimeout(() => listen(port, triesLeft - 1), 150);
      else {
        ctx.err(`spool: the page could not start: ${error.message}`);
        // With no page there is nothing to stay up for, and nothing should go on building: end the process once the message is out.
        runner.close();
        process.exitCode = 1;
        process.stderr.write('', () => process.exit(1));
      }
    });
    server.listen(port, '127.0.0.1');
  };
  listen(options.port ?? 4747, 20);
  // The server's own close comes later than a process that is exiting: put the thread back on the way out too.
  const leaving = (): void => runner.close();
  process.once('exit', leaving);
  server.on('close', () => {
    process.off('exit', leaving);
    runner.close();
    upkeep.close();
  });
  return server;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * How a page that was started by another says, as it ends: start me again, on the code now on
 * disk. The exit code also says whether its agents were on, since nothing else is sure to arrive.
 */
const RESTART = { on: 75, off: 76 } as const;

/** What a restarting page handed over, read from wherever it arrived; nothing unless it is whole. */
function resumeOf(value: unknown): Resume | undefined {
  try {
    const given = (typeof value === 'string' ? JSON.parse(value) : value) as { port?: unknown; run?: unknown } | null;
    if (given && typeof given.port === 'number' && Number.isInteger(given.port) && given.port > 0 && given.port < 65536) {
      return { port: given.port, run: given.run === true };
    }
  } catch {
    // Not what a page writes: there is nothing to take over.
  }
  return undefined;
}

/**
 * Stay up as the process the terminal, or the harness, started, and run the page in a child of
 * it. A process cannot load its own code a second time, so a page moves onto a new build by
 * ending and being started again; this is what starts it again, at the same address and with
 * agents as they were. Stopping this process stops the page, as it always did.
 */
function keepPage(ctx: Ctx, page: { project?: string; agent?: string }, first: Resume): void {
  const argv = [
    ...process.execArgv,
    path.join(CODE_DIR, `cli${CODE_EXT}`),
    'page',
    '--no-open',
    ...(page.project ? ['--project', page.project] : []),
    ...(page.agent ? ['--agent', page.agent] : []),
  ];
  let child: ChildProcess | undefined;
  let leaving = false;
  const start = (resume: Resume): void => {
    const started = spawn(process.execPath, argv, {
      cwd: ctx.cwd,
      // The terminal, and a channel: the page knows by the channel closing that this process has died.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...ctx.env, SPOOL_PAGE_RESUME: JSON.stringify(resume) },
    });
    child = started;
    started.on('error', (error) => {
      ctx.err(`spool: the page could not be started again: ${error.message}`);
      process.exit(1);
    });
    started.on('exit', (code, signal) => {
      if (!leaving && (code === RESTART.on || code === RESTART.off)) start({ port: first.port, run: code === RESTART.on });
      else process.exit(code ?? (signal ? 1 : 0));
    });
  };
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      // Told to stop: the page is told the same, and puts back what it was building before both go.
      leaving = true;
      const running = child;
      if (running && running.exitCode === null && running.signalCode === null) {
        running.kill(signal);
        setTimeout(() => {
          running.kill('SIGKILL');
          process.exit(0);
        }, 5000).unref();
      } else process.exit(0);
    });
  }
  start(first);
}

function openUrl(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** `spool page`: start the server, say where it is, and open it. The process stays up until it is stopped. */
export function servePage({ ctx, opts }: Bare): Result {
  // A page that restarted onto new code says where the one before it was, and whether its agents were on.
  const resumed = resumeOf(ctx.env.SPOOL_PAGE_RESUME);
  const port = resumed ? resumed.port : opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SpoolError('--port must be a port number');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool or no such project.
  const ws = Workspace.open(ctx.cwd, ctx.now);
  let root: string;
  try {
    board(ws, project);
    root = (project ? ws.project(project) : ws.home).root;
  } finally {
    ws.close();
  }
  const chatBuilds = builderOf(ctx, root) === 'chat';
  const run = resumed ? resumed.run : !!opts.run;
  const agent = typeof opts.agent === 'string' ? opts.agent : undefined;
  if (opts.status) return pageStatus(ctx, root);
  if (opts.stop) return stopPage(ctx, root);
  // One page to a project: a second start points at the first instead of taking the next port.
  // Asked for a port of its own, it is given one: something is counting on that address (a preview pane, a test).
  const there = resumed ? undefined : pageUp(ctx, root);
  const up = there && (port === undefined || new URL(there.url).port === String(port)) ? there : undefined;
  if (up) {
    if (!opts['no-open'] && !opts.detach) openUrl(up.url);
    return { text: `The Spool page is already up for this project: ${up.url}` };
  }
  if (opts.detach) {
    const args = [...(port ? ['--port', String(port)] : []), ...(run ? ['--run'] : []), ...(agent ? ['--agent', agent] : []), ...(project ? ['--project', project] : [])];
    return detachPage(ctx, root, path.join(CODE_DIR, `cli${CODE_EXT}`), args);
  }
  // Started by a page that is staying up to restart this one: it is told how, and this one ends if it does.
  const kept = !!resumed && typeof process.send === 'function';
  // The process a terminal or `-d` started is the one to signal: a kept page is its child.
  const owner = kept ? process.ppid : process.pid;
  let handing = false;
  process.once('exit', () => handing || forgetPage(ctx, root, owner));
  // Ctrl-C, or closing the terminal, ends the page and the agent it started with it.
  const stop = (): void => {
    server.close();
    process.exit(0);
  };
  const restart = (resume: Resume): void => {
    // Started by a page that stayed up for this: ending this way is asking it to start the next.
    handing = kept;
    if (kept) process.exit(resume.run ? RESTART.on : RESTART.off);
    // The first restart. This process stays, since it is the one the terminal holds, and the page runs in a child from here on.
    for (const signal of SIGNALS) process.off(signal, stop);
    server.close();
    server.closeAllConnections();
    keepPage(ctx, { project, agent }, resume);
  };
  // What tells a page it is taking over is for that page alone, not for the agents it starts.
  const own: Ctx = { ...ctx, env: { ...ctx.env, SPOOL_PAGE_RESUME: undefined, SPOOL_PAGE_DETACHED: undefined } };
  const server = startPage(own, { port, project, run, agent, resumed: !!resumed, restart }, ({ url, token }) => {
    const before = resumed ? pageUp(ctx, root) : undefined;
    const since = before?.pid === owner ? before.since : ctx.now().toISOString();
    rememberPage(ctx, { pid: owner, url, root, project, since, run, detached: ctx.env.SPOOL_PAGE_DETACHED === '1', token });
    if (resumed) {
      ctx.out(`Restarted on the new build: ${url}`);
      return;
    }
    ctx.out(`Spool page: ${url}`);
    if (run) ctx.out(chatBuilds ? 'A chat builds here, as picked on the page: this page starts no agents until that is set back to Headless.' : 'Agents are on: this page builds what is in Build, with no chat open.');
    ctx.out('Leave this running while you use the page. Ctrl-C stops it.');
    if (!opts['no-open']) openUrl(url);
  });
  for (const signal of SIGNALS) process.once(signal, stop);
  if (kept) process.once('disconnect', stop);
  return { text: '' };
}

// ------------------------------------------------------------------ the page

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spool</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🧶%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #f7f6f3; --panel: #ffffff; --col: #efede8; --ink: #1d1c1a; --soft: #6b6861; --line: #dfdcd5;
    --accent: #c2410c; --go: #15803d; --blue: #1d4ed8; --warn: #b45309; --chip: #eeece6; --hot: #c9372c;
    --shadow: 0 1px 2px rgba(30, 25, 15, .14);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151413; --panel: #222120; --col: #1b1a19; --ink: #f1efea; --soft: #a19d95; --line: #353330;
      --accent: #fb923c; --go: #4ade80; --blue: #93c5fd; --warn: #fbbf24; --chip: #2d2b28; --hot: #f87171;
      --shadow: 0 1px 2px rgba(0, 0, 0, .5); }
  }
  * { box-sizing: border-box; }
  /* Hidden means gone. Without this, a rule that sets display (the board's grid) keeps a hidden view on screen. */
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  button { font: inherit; cursor: pointer; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 5px 10px; }
  button:hover { border-color: var(--soft); }
  button.go { background: var(--go); border-color: var(--go); color: #fff; font-weight: 600; }
  @media (prefers-color-scheme: dark) { button.go { color: #052e16; } }
  input, select, textarea { font: inherit; color: var(--ink); }

  /* the bar: the project, the two views, and a search */
  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 18px; padding: 0 20px; height: 52px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .brand { font-size: 17px; font-weight: 700; white-space: nowrap; }
  .where { color: var(--soft); font-size: 13px; font-weight: 400; margin-left: 6px; }
  .tabs { display: flex; gap: 2px; align-self: stretch; }
  .tab { background: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; padding: 0 12px; color: var(--soft); font-weight: 600; }
  .tab.on { color: var(--ink); border-bottom-color: var(--accent); }
  .search { margin-left: auto; width: min(260px, 40vw); padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  .runner { white-space: nowrap; color: var(--soft); }
  .runner.on { color: var(--go); border-color: var(--go); font-weight: 600; }
  /* who builds: two picks side by side, the one in force filled in */
  .builder { display: flex; white-space: nowrap; margin-right: -8px; }
  .builder button { color: var(--soft); border-radius: 0; }
  .builder button:first-child { border-radius: 7px 0 0 7px; }
  .builder button:last-child { border-radius: 0 7px 7px 0; margin-left: -1px; }
  .builder button.on { position: relative; color: var(--ink); background: var(--bg); border-color: var(--soft); font-weight: 600; }
  .live { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--soft); }
  .live .now { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live .for { color: var(--blue); white-space: nowrap; }
  .live .pulse { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--blue); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .flag { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 12px; font-weight: 650; color: var(--soft); }
  .flag::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .flag.you { color: var(--warn); } .flag.thread { color: var(--blue); } .flag.stuck { color: var(--hot); }
  /* Only what waits on the human gets an edge: an answer, or a word after an agent gave up. */
  .card:has(> .flag.you) { box-shadow: inset 3px 0 0 var(--warn), var(--shadow); }
  .card:has(> .flag.stuck) { box-shadow: inset 3px 0 0 var(--hot), var(--shadow); }
  .livelog { max-height: 220px; overflow: auto; margin-top: 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; color: var(--soft); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rule { padding: 8px 20px 0; color: var(--warn); font-size: 13px; }
  #quick { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 20px 0; font-size: 13px; min-height: 12px; }
  .pill { border-radius: 999px; padding: 2px 11px; background: var(--panel); border: 1px solid var(--line); color: var(--soft); }
  .pill.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }

  /* the board */
  #board { display: grid; grid-template-columns: repeat(4, minmax(230px, 1fr)); gap: 12px; padding: 12px 20px 32px; align-items: start; overflow-x: auto; }
  @media (max-width: 900px) { #board { grid-template-columns: repeat(4, 82vw); } }
  .col { background: var(--col); border-radius: 10px; padding: 8px; min-height: 140px; border: 2px solid transparent; }
  .over { border-color: var(--go) !important; }
  .col h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; margin: 5px 6px 10px; display: flex; gap: 8px; color: var(--soft); font-weight: 600; }
  .col h2 .count { background: var(--chip); border-radius: 999px; padding: 0 8px; }
  .tools { display: flex; gap: 6px; margin: -4px 4px 8px; }
  .tools select { flex: 1; min-width: 0; padding: 2px 4px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--soft); font-size: 12px; cursor: pointer; }
  .tools select:hover { border-color: var(--line); }
  .tools select.set { color: var(--accent); border-color: var(--line); background: var(--panel); }
  .card { background: var(--panel); border: 1px solid transparent; border-radius: 8px; padding: 9px 10px 8px; margin-bottom: 7px; box-shadow: var(--shadow); }
  .card:hover { border-color: var(--line); }
  .card[draggable=true], .row[draggable=true] { cursor: grab; }
  .dragging { opacity: .45; }
  /* Where a card dragged over Build will land. */
  .landing { height: 3px; margin: -5px 2px 2px; border-radius: 2px; background: var(--go); pointer-events: none; }
  .col .hint { margin: -6px 6px 10px; color: var(--soft); font-size: 12px; }
  .card.past { opacity: .7; }
  .title { font-weight: 500; cursor: pointer; overflow-wrap: anywhere; }
  .title:hover { text-decoration: underline; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .chip.ai { color: var(--blue); }
  .chip.ok { color: var(--go); }
  .chip.check { color: var(--warn); }
  .chip.sprint { color: var(--accent); }
  .tag { cursor: pointer; }
  .tag b { font-weight: 400; margin-left: 5px; opacity: .6; }
  .tag b:hover { opacity: 1; }
  .note { margin-top: 6px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  /* Why a thread exists: one quiet line, cut short, the whole of it on hover. */
  .why { margin-top: 5px; font-size: 12px; color: var(--soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .q { margin-top: 8px; padding: 8px; border-radius: 8px; background: var(--chip); font-size: 13px; }
  .q button { margin: 6px 6px 0 0; }
  button.rec { border-color: var(--go); }
  .meta { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--soft); }
  .key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; }
  .meta .push { margin-left: auto; }
  .prio { font-weight: 800; letter-spacing: -1px; }
  .prio.p0 { color: var(--hot); } .prio.p1 { color: var(--accent); } .prio.p3 { color: var(--blue); }
  .size { border-radius: 999px; background: var(--chip); padding: 0 7px; font-weight: 600; }
  .act { padding: 2px 9px; font-size: 12px; }
  .arch { width: 24px; height: 24px; padding: 0; display: inline-grid; place-items: center; color: var(--soft); }
  .arch:hover { color: var(--ink); }
  .arch svg { width: 14px; height: 14px; }
  .tick { width: 24px; height: 24px; padding: 0; border-radius: 50%; color: var(--go); font-weight: 700; }
  .tick:hover { background: var(--go); border-color: var(--go); color: #fff; }
  .empty { color: var(--soft); font-size: 13px; padding: 8px 6px; }
  .add { width: 100%; text-align: left; border-style: dashed; background: transparent; color: var(--soft); }
  .add:hover { color: var(--ink); }
  .adding textarea, .adding input { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); resize: vertical; }
  .acts { display: flex; gap: 6px; margin-top: 6px; }
  .foot { width: 100%; margin-bottom: 8px; }
  .addall { margin-bottom: 0; }
  .history { background: none; border: 0; padding: 6px; color: var(--soft); font-size: 13px; width: 100%; text-align: left; }
  .history:hover { color: var(--ink); }

  /* while you were away: the morning brief, above the columns, one column that wraps */
  #brief { margin: 12px 20px 0; max-width: 760px; background: var(--col); border-radius: 10px; padding: 8px; }
  #brief .bhead { display: flex; gap: 8px; width: 100%; text-align: left; background: none; border: 0; padding: 4px 6px; font-weight: 600; overflow-wrap: anywhere; }
  #brief .bhead .fold { color: var(--soft); flex: none; }
  #brief h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; margin: 12px 6px 8px; display: flex; gap: 8px; color: var(--soft); font-weight: 600; }
  #brief h2 .count { background: var(--chip); border-radius: 999px; padding: 0 8px; }
  #brief .card { margin-bottom: 7px; }
  #brief .why { white-space: normal; }
  #brief .sprint { margin: 8px 6px 6px; font-size: 13px; color: var(--soft); }
  #brief .history { margin-top: 2px; }
  #brief .foot { margin: 10px 0 0; }

  /* the backlog: sprints to fill and play, and everything not in one */
  #backlog { padding: 12px 20px 32px; max-width: 1100px; }
  .group { background: var(--col); border-radius: 10px; padding: 8px; margin-bottom: 14px; border: 2px solid transparent; }
  .ghead { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 4px 6px 9px; }
  .gname { font-weight: 650; font-size: 15px; }
  .gmeta { color: var(--soft); font-size: 13px; }
  .state { border-radius: 4px; padding: 0 7px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--chip); color: var(--soft); }
  .state.running, .state.building { color: var(--blue); }
  .state.build, .state.done { color: var(--go); }
  .prog { flex: 0 0 110px; height: 6px; background: var(--chip); border-radius: 999px; overflow: hidden; }
  .prog i { display: block; height: 100%; background: var(--go); }
  .ghead .push { margin-left: auto; display: flex; gap: 6px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; background: var(--panel); padding: 7px 10px; border-bottom: 1px solid var(--line); }
  .row:first-of-type { border-radius: 8px 8px 0 0; }
  .row:last-of-type { border-radius: 0 0 8px 8px; border-bottom: 0; }
  .row:only-of-type { border-radius: 8px; }
  .row .right { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--soft); white-space: nowrap; }
  .group .add, .group .adding { margin-top: 8px; }
  .about { padding: 0 6px 10px; font-size: 13px; color: var(--soft); cursor: pointer; }
  .about b { color: var(--ink); font-weight: 600; }
  .about:hover { color: var(--ink); }
  .aboutform { padding: 0 6px 10px; display: grid; gap: 6px; max-width: 720px; }
  .aboutform input { padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }

  /* what waits on the human: on its thread, or in the strip at the top of the backlog when it has none */
  .need { background: var(--panel); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; box-shadow: var(--shadow); }
  .need .what { font-weight: 600; overflow-wrap: anywhere; }
  .need .more { color: var(--soft); font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
  .need .chose { margin-top: 6px; }
  .need .acts { flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .say { display: inline-flex; flex: 1 1 260px; gap: 6px; }
  .say input { flex: 1; min-width: 0; padding: 5px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
  .acts.wrap { flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .need ul { margin: 6px 0 0; padding-left: 18px; color: var(--soft); font-size: 13px; }

  /* the ticket */
  #veil { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); z-index: 3; }
  #thread { position: fixed; z-index: 4; top: 5vh; left: 50%; transform: translateX(-50%); width: min(1000px, 96vw); max-height: 90vh; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow-y: auto; padding: 22px 24px 26px; box-shadow: 0 24px 64px rgba(0, 0, 0, .3); }
  .ticket { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 28px; }
  @media (max-width: 760px) { .ticket { grid-template-columns: 1fr; } #thread { top: 0; max-height: 100vh; border-radius: 0; width: 100vw; } }
  #thread .key { font-size: 12px; color: var(--soft); margin: 0 40px 6px 0; cursor: default; }
  #thread h2 { font-size: 21px; margin: 0 0 6px -4px; overflow-wrap: anywhere; border-radius: 6px; padding: 2px 4px; outline: none; cursor: text; }
  #thread h2:hover, #thread h2:focus { background: var(--chip); }
  #thread h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 22px 0 8px; }
  #thread .x { position: absolute; top: 14px; right: 16px; }
  #thread .title { cursor: text; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 6px 0; }
  textarea { width: 100%; min-height: 54px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); resize: vertical; }
  .side { border-left: 1px solid var(--line); padding-left: 22px; }
  @media (max-width: 760px) { .side { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); } }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin-bottom: 5px; }
  .field select, .field input { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .field .val { font-size: 14px; }
  .field .pick { display: flex; gap: 6px; }
  .field .pick select { flex: 1; min-width: 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .feed { margin-top: 18px; }
  .post { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 18px; }
  .post::before { content: ''; position: absolute; left: 19px; top: 44px; bottom: 2px; width: 2px; background: var(--line); }
  .post:last-child::before { display: none; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; color: #fff; background: var(--soft); flex: none; }
  .avatar.you { background: var(--ink); color: var(--bg); overflow: hidden; }
  .avatar.you svg, .avatar.who22.you svg { width: 100%; height: 100%; }
  .avatar.claude { background: #fbf3ea; border: 1px solid #ecd9c6; }
  .avatar svg { width: 26px; height: 26px; }
  .avatar.who22 { width: 22px; height: 22px; font-size: 11px; }
  .avatar.who22 svg { width: 15px; height: 15px; }
  .byline { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; min-height: 20px; }
  .byline b { font-weight: 650; }
  .byline .model { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .byline .at, .sep { color: var(--soft); font-size: 13px; }
  .byline .stop { margin-left: auto; align-self: center; }
  .post pre { margin: 2px 0 0; line-height: 1.5; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; background: var(--chip); border-radius: 4px; padding: 0 4px; overflow-wrap: anywhere; }
  /* The agent at work: a calm pulse on its avatar, and a caret after what it is doing now. */
  .avatar { position: relative; }
  .avatar .pulse { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; border-radius: 50%; background: var(--blue); border: 2px solid var(--panel); animation: pulse 1.6s ease-in-out infinite; }
  .livenow { margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere; }
  .caret { display: inline-block; width: 7px; height: 14px; margin-left: 3px; vertical-align: -2px; background: var(--blue); animation: blink 1.1s steps(2, start) infinite; }
  @keyframes blink { to { visibility: hidden; } }
  @media (prefers-reduced-motion: reduce) { .pulse, .caret { animation: none !important; } }
  .post .badge { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--go); }
  .post .badge.ask { color: var(--warn); }
  .event { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 10px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  .event::before { content: ''; position: absolute; left: 19px; top: 0; bottom: 0; width: 2px; background: var(--line); }
  .event .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin: 6px auto 0; position: relative; box-shadow: 0 0 0 3px var(--panel); }
  .event .sep { margin: 0 5px; }
  .fold { justify-self: start; background: none; border: 0; padding: 0; color: var(--soft); font-size: 13px; }
  .fold:hover { color: var(--ink); text-decoration: underline; }
  .feed > .empty { padding: 0 0 14px 52px; }
  .compose { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; margin-top: 6px; }
  .compose textarea { min-height: 44px; }
  .compose .acts { margin-top: 8px; align-items: center; justify-content: flex-end; gap: 12px; }
  .compose .hint { font-size: 12px; color: var(--soft); }
  .compose button:disabled { opacity: .45; cursor: default; }
  /* Where the keyboard is, in the ticket: one quiet ring, the palette's blue. */
  #thread button:focus-visible, #thread a:focus-visible, #thread summary:focus-visible, #thread select:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
  #thread textarea:focus, #thread input:focus { outline: none; border-color: var(--blue); }
  .notice { margin: 12px 0 0; padding: 10px 14px 12px; border-radius: 10px; background: var(--chip); border-left: 3px solid var(--soft); overflow-wrap: anywhere; }
  .notice .head { font-weight: 650; }
  .notice.you { border-left-color: var(--warn); } .notice.you .head { color: var(--warn); }
  .notice.thread { border-left-color: var(--blue); }
  .notice.stuck { border-left-color: var(--hot); } .notice.stuck .head { color: var(--hot); }
  .notice .what { margin-top: 2px; }
  .notice .soft { margin-top: 6px; font-size: 13px; color: var(--soft); }
  .notice button { margin: 8px 6px 0 0; }
  .notice a { display: block; margin-top: 4px; color: var(--ink); text-decoration: none; }
  .notice a:hover { text-decoration: underline; }
  #thread .notice a .key { margin: 0; font-size: 12px; color: var(--soft); cursor: pointer; }
  details.desc { margin: 12px 0 0; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  details.desc summary { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); cursor: pointer; }
  details.desc .kind { margin: 10px 0 4px; font-weight: 600; }
  details.desc .kind span { font-weight: 400; color: var(--soft); }
  details.desc .part { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; padding: 9px 0 0; margin-top: 9px; border-top: 1px solid var(--line); }
  details.desc .part .icon { font-size: 18px; line-height: 1.2; text-align: center; }
  details.desc .part .label { font-size: 12px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--soft); }
  details.desc .part pre { margin: 2px 0 0; }
  details.desc .part.why .label { color: var(--go); }
  details.desc .part.done .label { color: var(--blue); }
  .changes { margin-top: 12px; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .plus { color: var(--go); } .minus { color: var(--hot); }
  .changes .sum { margin-top: 10px; font-size: 13px; display: flex; gap: 8px; align-items: baseline; }
  .changes .commits { margin: 4px 0 10px; font-size: 12px; color: var(--soft); }
  .changes .commits .mono { margin-right: 4px; }
  .changes .file { border: 1px solid var(--line); border-radius: 8px; margin-top: 6px; overflow: hidden; min-width: 0; }
  .changes .filehead { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 13px; cursor: pointer; user-select: none; }
  .changes .filehead:hover { background: var(--chip); }
  .changes .twist { color: var(--soft); width: 10px; }
  .changes .path { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .changes .dir { color: var(--soft); }
  .changes .word { font-size: 11px; color: var(--soft); background: var(--chip); border-radius: 6px; padding: 1px 6px; }
  .changes .stat { display: inline-flex; gap: 1px; }
  .changes .stat i { width: 7px; height: 7px; border-radius: 1px; background: var(--line); }
  .changes .stat i.plus { background: var(--go); } .changes .stat i.minus { background: var(--hot); }
  .changes .filebody { border-top: 1px solid var(--line); background: var(--bg); }
  .changes .filebody .note { padding: 6px 10px; }
  .changes .scroll { max-height: 520px; overflow: auto; }
  .changes table.lines { border-collapse: collapse; min-width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; tab-size: 4; }
  .changes table.lines td { padding: 0; white-space: pre; }
  .changes td.num { width: 1%; min-width: 34px; padding: 0 6px; text-align: right; color: var(--soft); opacity: 0.7; user-select: none; }
  .changes td.sign { width: 1%; padding: 0 4px; user-select: none; }
  .changes td.code { padding-right: 10px; }
  .changes tr.plus td.sign { color: var(--go); } .changes tr.minus td.sign { color: var(--hot); }
  .changes tr.plus, .changes tr.minus { color: var(--ink); }
  .changes tr.plus { background: color-mix(in srgb, var(--go) 14%, transparent); }
  .changes tr.minus { background: color-mix(in srgb, var(--hot) 14%, transparent); }
  .changes tr.none td.code { color: var(--soft); font-style: italic; }
  .changes tr.at td { color: var(--soft); background: var(--chip); padding: 1px 10px; }
  .undo { margin-top: 12px; display: grid; gap: 8px; }
  .undo input { padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
  .finish { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); }
  .finish button { width: 100%; padding: 10px; font-size: 15px; }
  .finish .ok { color: var(--go); font-weight: 600; }
  #said { position: fixed; z-index: 5; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #said.on { opacity: 1; }
</style>
</head>
<body>
<div class="bar">
  <div class="brand">🧶 <span id="project">Spool</span><span class="where" id="where"></span></div>
  <div class="tabs">
    <button class="tab" data-view="board">Board</button>
    <button class="tab" data-view="backlog">Backlog</button>
  </div>
  <input class="search" id="search" placeholder="Search threads   /" autocomplete="off">
  <div class="builder" id="builder" role="group" aria-label="Who builds" hidden><button data-builder="headless">Headless</button><button data-builder="chat">Chat</button></div>
  <button class="runner" id="runner" hidden></button>
</div>
<div class="rule" id="rule" hidden></div>
<div id="quick"></div>
<section id="brief" aria-label="While you were away" hidden></section>
<main id="board"></main>
<main id="backlog" hidden></main>
<div id="veil" hidden></div>
<aside id="thread" hidden></aside>
<div id="said"></div>
<script>
const TOKEN = '__TOKEN__';
// Which build of Spool this page came from. The board names the build that serves it now.
const BUILD = '__BUILD__';
const COLUMNS = [
  ['proposed', 'Backlog', 'Nothing here is built. Drag a thread to Build, or press ▶.'],
  ['build', 'Build', 'Agents take these in order, top first. Drag a card up or down to change it.'],
  ['building', 'Building', 'An agent has it now.'],
  ['done', 'Done', 'For you to check.'],
];
const DOT = { proposed: '🟠', build: '🟢', building: '🔵', done: '✅' };
const STATE = { proposed: 'Backlog', build: 'Build', building: 'Building', done: 'Done' };
const SIZES = [['xs', 'Tiny'], ['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Huge']];
const PRIORITIES = ['Urgent', 'High', 'Normal', 'Someday'];
const MODELS = ${JSON.stringify(MODELS)};
const EFFORTS = ${JSON.stringify(EFFORTS)};
const ARROWS = ['↑↑', '↑', '=', '↓'];

let last = '';
let current = null;
let busy = false;
// Which view is up: the board, or the backlog with its sprints.
let view = 'board';
// A view the page no longer has, remembered or linked to, is the board.
try { view = localStorage.getItem('spool-view') === 'backlog' ? 'backlog' : 'board'; } catch (e) {}
// A link can name the view: /?view=backlog
const asked = /[?&]view=(board|backlog)\b/.exec(location.search);
if (asked) view = asked[1];
// The thread that is open, if one is, and notes begun but not yet added.
let openId = null;
const drafts = new Map();
// A page that reloaded itself onto a new build brings the replies that were begun along.
try {
  for (const [id, words] of JSON.parse(sessionStorage.getItem('spool-drafts') || '[]')) drafts.set(id, words);
  sessionStorage.removeItem('spool-drafts');
} catch (e) {}
// Completed threads are history: kept, and out of the way until asked for.
let showHistory = false;
// Archived threads are out of sight: their section at the foot of the backlog stays folded until opened.
let showArchived = false;
// What the board is narrowed to: { kind: 'tag' | 'version' | 'sprint', value }, and whatever is typed in the search.
let only = null;
let query = '';
// The "+ Add" that is open ('proposed', 'build', or 'sprint' for a new sprint), and what has been typed into it.
let adding = null;
let addDraft = '';

// (An attribute given as true is written empty, which is right for "hidden" or "open" and wrong for
// "draggable": that one has to say "true", or the browser does not let the thing be dragged.)
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) node.append(kid);
  return node;
};

function say(words) {
  const box = document.getElementById('said');
  box.textContent = words;
  box.classList.add('on');
  clearTimeout(say.t);
  say.t = setTimeout(() => box.classList.remove('on'), 2600);
}

// The page's server hands out a new token each time it starts. A page left open across a restart
// asks for the new one and tries again, where it used to fail and lose what had been typed.
let token = TOKEN;
async function freshToken() {
  const found = /const TOKEN = '([^']+)';/.exec(await (await fetch('/')).text());
  if (found) token = found[1];
}
function send(action, body) {
  return fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
}

async function post(action, body, done) {
  busy = true;
  say('Saving…');
  try {
    let res = await send(action, body);
    if (res.status === 403) {
      await freshToken();
      res = await send(action, body);
    }
    const out = await res.json();
    say(out.ok ? out.text || done : out.text || 'That did not work');
    return out.ok;
  } catch (e) {
    say('The page lost its server. Run spool page again.');
    return false;
  } finally {
    busy = false;
    last = '';
    // Show what was just done at once. The box they typed in still has the focus, and waiting for
    // it to lose it is what made adding feel stuck.
    load(true);
  }
}

// ---- what is shown: narrowed by a sprint, a tag or a version, and by the search

const sprintName = (b, id) => (b.sprints.find((s) => s.id === id) || {}).name || '';
function shows(c) {
  if (only && (only.kind === 'tag' ? !c.tags.includes(only.value) : only.kind === 'version' ? c.version !== only.value : c.sprint !== only.value)) return false;
  if (!query) return true;
  const hay = (c.title + ' ' + c.id + ' ' + c.tags.join(' ') + ' ' + c.version + ' ' + c.note).toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => hay.includes(word));
}
const narrow = (kind, value) => { only = only && only.kind === kind && only.value === value ? null : { kind, value }; redraw(); };
const everyCard = (b) => COLUMNS.flatMap(([key]) => b.columns[key]);

// ---- one thread, as a card on the board and as a row in the backlog

function chipsOf(c, b) {
  return [
    c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : planWaits(b, c.id) ? 'Waiting for your go-ahead' : 'For you to check'),
    lookAt(b, c.id) > 0 && el('span', { class: 'chip tag', title: 'Calls an agent made, or a skill it wrote, for you to look at on the thread', onclick: () => openThread(c.id) }, '🧾 ' + lookAt(b, c.id) + ' to look at'),
    c.type !== 'change' && el('span', { class: 'chip' }, c.type),
    c.suggested && el('span', { class: 'chip ai', title: c.suggested }, '✨ AI suggested'),
    c.sprint && el('span', { class: 'chip tag sprint', title: 'Show only this sprint', onclick: () => narrow('sprint', c.sprint) }, sprintName(b, c.sprint)),
    c.version && el('span', { class: 'chip tag', title: 'Show only this version', onclick: () => narrow('version', c.version) }, 'v' + c.version),
    c.tags.map((t) => el('span', { class: 'chip tag', title: 'Show only this tag', onclick: () => narrow('tag', t) }, '#' + t)),
  ];
}

// What an agent did on the thread by itself and he has not looked at: the calls it made, the skills it wrote.
const lookAt = (b, id) => callsFor(b, id).length + skillsFor(b, id).length;

// Who built it, how urgent, how big: the small facts at the foot of a card, the way a board has always shown them.
function facts(c) {
  return [
    !c.done && el('span', { class: 'prio p' + c.p, title: c.priority }, ARROWS[c.p]),
    c.size && el('span', { class: 'size', title: c.difficulty }, c.size.toUpperCase()),
    (c.column === 'building' || c.done) && c.thread.by && smallAvatar(c.thread.by),
  ];
}
function smallAvatar(who) {
  const node = avatar(who);
  node.classList.add('who22');
  return node;
}
// The run of this thread, if the page's own runner is building it right now.
const liveOf = (c, b) => b.runner.running.find((run) => run.id === c.id) || null;
// A thread the human stopped while it was being built: it waits in Build until they carry on.
const stoppedOf = (c, b) => c.column === 'build' && b.runner.stopped.includes(c.id);
// Stop the agent on one thread, and no other.
const stopNode = (c, cls, label) => el('button', { class: cls, title: 'Stop the agent on this thread, now. The thread waits in Build until you carry on. Other threads go on being built.',
  onclick: () => post('stop', { id: c.id }, 'Stopped') }, label);
// Carry on with a stopped thread: it is built next, as one dragged into Building is.
const carryOnNode = (c, cls) => el('button', { class: cls, title: 'Build this again. It is taken next, ahead of the rest of Build.',
  onclick: () => post('move', { id: c.id, to: 'building' }, 'Building: ' + c.title) }, '▶ Carry on');
// How long an agent has been at it, the way a person would say it.
function took(since) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm';
  return Math.floor(s / 86400) + 'd';
}
// The line a Building card shows: what the agent is doing now, and for how long. The runner's own output is the freshest.
function liveLine(c, b) {
  if (b && stoppedOf(c, b)) return el('div', { class: 'live', title: 'You stopped the agent that was building this. Nothing builds it until you carry on.' }, el('span', { class: 'now' }, '■ Stopped'));
  if (!c.live) return null;
  const run = b && liveOf(c, b);
  const now = (run && run.lines.at(-1)) || c.live.note || 'starting…';
  return el('div', { class: 'live', title: 'What the agent is doing now, and how long it has been at it' },
    el('span', { class: 'pulse' }), el('span', { class: 'now' }, now), el('span', { class: 'for', 'data-since': c.live.since }, took(c.live.since)));
}
// What a thread waits on, as its card shows it: a small mark at the top, in the colour of who has to act.
// The note under the title says the rest; a ticket says all of it.
function waitMark(c, b) {
  const w = c.waiting;
  if (!w) return null;
  const label = w.kind === 'you' ? 'Needs you' : w.kind === 'hold' ? 'On hold'
    : w.kind === 'thread' ? 'Waiting on ' + (w.on.length === 1 ? w.on[0].id : w.on.length + ' threads') : 'Agent stopped unfinished';
  const said = w.kind === 'stuck' && lastWords(c, b);
  return el('div', { class: 'flag ' + w.kind, title: w.kind === 'stuck' ? 'It ' + w.text + (said ? '. It last said: ' + said : '') : '' }, label);
}
// The last thing an agent that gave up said: on the thread if it wrote it there, or as this page heard it.
function lastWords(c, b) {
  if (c.waiting.said) return c.waiting.said;
  const run = ((b && b.runner && b.runner.recent) || []).find((r) => r.id === c.id && /^unfinished/.test(r.outcome));
  const cut = run ? run.outcome.indexOf(' — ') : -1;
  return cut >= 0 ? run.outcome.slice(cut + 3) : '';
}
// Abort a thread being built: the agent on it stops, and the thread goes straight back to the backlog.
const abortNode = (c, cls) => el('button', { class: cls, title: 'Stop building this, undo what it changed, and move it back to the backlog. Nothing builds it until you move it to Build again.',
  onclick: () => post('abort', { id: c.id }, 'Aborted. Back in the backlog: ' + c.title) }, '↩ Abort');
function moves(c, b) {
  return [
    b && liveOf(c, b) && stopNode(c, 'act', '■ Stop'),
    b && stoppedOf(c, b) && carryOnNode(c, 'act go'),
    c.column === 'building' && abortNode(c, 'act'),
    c.column === 'proposed' && el('button', { class: 'act go', title: 'Move to Build', onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title) }, '▶ Build'),
    c.column === 'build' && el('button', { class: 'act', title: 'Back to the backlog', onclick: () => post('move', { id: c.id, to: 'proposed' }, 'Back in the backlog') }, 'Not yet'),
    c.done && !c.complete && el('button', { class: 'tick', title: 'Mark as complete', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓'),
  ];
}
// Archiving: a thread waiting in the backlog put out of sight, not dropped. One click, and one click back.
const ARCHIVE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.75 6v6.75a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75V6M6.5 9h3"/></svg>';
function archiveNode(c) {
  if (c.column !== 'proposed') return null;
  const node = el('button', { class: 'arch', title: 'Archive: out of sight, not dropped. It is kept under Archived, at the foot of the Backlog view.', 'aria-label': 'Archive',
    onclick: () => post('archive', { id: c.id }, 'Archived: ' + c.title) });
  node.innerHTML = ARCHIVE_ICON;
  return node;
}
function dragOf(node, c, from) {
  node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.id + ' ' + from); node.classList.add('dragging'); busy = true; });
  node.addEventListener('dragend', () => { node.classList.remove('dragging'); unland(); busy = false; });
}

// Dragging over Build, a thin line shows where the card will land: before the first card whose middle is below the pointer.
function landAt(col, y) {
  const cards = [...col.querySelectorAll('.card:not(.dragging)')];
  const below = cards.find((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  const line = document.querySelector('.landing') || el('div', { class: 'landing' });
  const at = below || (cards.length ? cards[cards.length - 1].nextSibling : null);
  if (line.parentNode !== col || line.nextSibling !== at) col.insertBefore(line, at);
}
function unland() {
  const line = document.querySelector('.landing');
  if (line) line.remove();
}
// Where a drop at the landing line puts a thread in Build's line, as the order command takes it; null where it changes nothing.
function spotOf(col, id) {
  const line = col.querySelector('.landing');
  if (!line) return null;
  const all = [...col.querySelectorAll('.card')];
  const others = all.filter((n) => n.dataset.id !== id);
  if (!others.length) return null;
  let below = line.nextSibling;
  while (below && !(below.classList && below.classList.contains('card'))) below = below.nextSibling;
  if (below && below.dataset.id === id) below = all[all.indexOf(below) + 1] || null;
  const mine = all.find((n) => n.dataset.id === id);
  // Dropped just where it already is.
  if (mine && (all[all.indexOf(mine) + 1] || null) === below) return null;
  return below ? { before: below.dataset.id } : { after: others[others.length - 1].dataset.id };
}

function cardNode(c, b) {
  // Any card can be dragged to any column, at any time.
  const node = el('div', { class: 'card' + (c.complete ? ' past' : ''), draggable: 'true', 'data-id': c.id },
    waitMark(c, b),
    el('div', { class: 'title', onclick: () => openThread(c.id) }, c.title),
    el('div', { class: 'chips' }, chipsOf(c, b)),
    c.why && !c.done && el('div', { class: 'why', title: c.why }, c.why),
    c.note && !c.done && el('div', { class: 'note' }, c.note),
    liveLine(c, b),
    c.question && el('div', { class: 'q' }, el('div', {}, '❓ ' + c.question.title),
      c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '',
        onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o))),
    el('div', { class: 'meta' },
      el('span', { class: 'key', title: 'Open the thread', onclick: () => openThread(c.id) }, c.id),
      el('span', { class: 'push' }), facts(c), archiveNode(c), moves(c, b)));
  dragOf(node, c, c.column);
  return node;
}

function rowNode(c, b) {
  const node = el('div', { class: 'row', draggable: !c.done && c.column !== 'building' && 'true', 'data-id': c.id },
    el('div', {}, el('span', { class: 'title', onclick: () => openThread(c.id) }, c.title),
      el('span', { class: 'chips', style: 'display: inline-flex; margin: 0 0 0 8px; vertical-align: middle' }, chipsOf({ ...c, sprint: '', done: false }, b)),
      c.why && !c.done && el('div', { class: 'why', title: c.why }, c.why)),
    el('div', { class: 'right' },
      el('span', { class: 'state ' + c.column }, STATE[c.column]),
      facts(c), el('span', { class: 'key', onclick: () => openThread(c.id) }, c.id), archiveNode(c), moves(c)));
  if (!c.done && c.column !== 'building') dragOf(node, c, 'row');
  return node;
}

// "+ Add": a thread added under a column starts in that column.
function addNode(column, placeholder) {
  if (adding !== column) {
    return el('button', { class: 'add', onclick: () => { adding = column; addDraft = ''; redraw(); } }, '+ Add');
  }
  const close = () => { adding = null; addDraft = ''; redraw(); };
  const save = async () => {
    const words = addDraft.trim();
    if (!words) return;
    adding = null;
    addDraft = '';
    // If it could not be saved, their words go back in the box: nothing typed is ever thrown away.
    if (!(await post('add', { text: words, to: column }, column === 'build' ? 'Added to build' : 'Added to the backlog'))) {
      adding = column;
      addDraft = words;
      redraw();
    }
  };
  const box = el('textarea', { placeholder: placeholder,
    oninput: (e) => { addDraft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    } });
  box.value = addDraft;
  return el('div', { class: 'adding' }, box,
    el('div', { class: 'acts' }, el('button', { class: 'go', onclick: save }, 'Add'), el('button', { onclick: close }, 'Cancel')));
}

// ---- each column can be sorted and filtered by itself; the choice is remembered

const SORTS = [['', 'Sort: as it stands'], ['priority', 'Sort: most urgent'], ['small', 'Sort: smallest'], ['large', 'Sort: largest'], ['new', 'Sort: newest'], ['old', 'Sort: oldest'], ['title', 'Sort: A to Z']];
const BIG = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };
let cols = {};
try { cols = JSON.parse(localStorage.getItem('spool-columns') || '{}') || {}; } catch (e) {}
const colOf = (key) => cols[key] || { sort: '', filter: '' };
function setCol(key, change) {
  cols[key] = { ...colOf(key), ...change };
  try { localStorage.setItem('spool-columns', JSON.stringify(cols)); } catch (e) {}
  redraw();
}
// What a column can be narrowed to depends on what is in it: its tags, sprints, versions and kinds of thread.
function filtersOf(cards, b) {
  const seen = (pick) => [...new Set(cards.flatMap(pick).filter(Boolean))].sort();
  return [
    ['', 'Show: all'],
    cards.some((c) => c.suggested) && ['ai', '✨ AI suggested'],
    cards.some((c) => c.question) && ['ask', '❓ Needs you'],
    cards.some((c) => !c.size) && ['unsized', 'Not sized'],
    ...seen((c) => [c.type !== 'change' && c.type]).map((t) => ['type:' + t, t]),
    ...seen((c) => [c.sprint]).map((id) => ['sprint:' + id, sprintName(b, id)]),
    ...seen((c) => [c.version]).map((v) => ['version:' + v, 'v' + v]),
    ...seen((c) => c.tags).map((t) => ['tag:' + t, '#' + t]),
  ].filter(Boolean);
}
function passes(c, filter) {
  if (!filter) return true;
  if (filter === 'ai') return !!c.suggested;
  if (filter === 'ask') return !!c.question;
  if (filter === 'unsized') return !c.size;
  const [kind, value] = [filter.slice(0, filter.indexOf(':')), filter.slice(filter.indexOf(':') + 1)];
  return kind === 'tag' ? c.tags.includes(value) : kind === 'type' ? c.type === value : kind === 'sprint' ? c.sprint === value : c.version === value;
}
function sorted(cards, sort) {
  const size = (c, missing) => (c.size ? BIG[c.size] : missing);
  const by = {
    priority: (a, z) => a.p - z.p,
    small: (a, z) => size(a, 9) - size(z, 9),
    large: (a, z) => size(z, -1) - size(a, -1),
    new: (a, z) => z.created.localeCompare(a.created),
    old: (a, z) => a.created.localeCompare(z.created),
    title: (a, z) => a.title.localeCompare(z.title),
  }[sort];
  return by ? [...cards].sort(by) : cards;
}
function toolsNode(key, cards, b) {
  const { sort, filter } = colOf(key);
  const options = filtersOf(cards, b);
  // A filter for something that has since left the column would hide everything: let it go.
  const live = options.some(([v]) => v === filter) ? filter : '';
  const pick = (list, value, onpick, label) => {
    const node = el('select', { class: value ? 'set' : '', 'aria-label': label, onchange: (e) => { const v = e.target.value; e.target.blur(); onpick(v); } },
      list.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  return el('div', { class: 'tools' },
    pick(SORTS, sort, (v) => setCol(key, { sort: v }), 'Sort this column'),
    pick(options, live, (v) => setCol(key, { filter: v }), 'Filter this column'));
}

// "Add to Build", for everything the backlog is showing right now. It starts work on all of them,
// so it asks once: the first press arms it, the second does it.
let armed = '';
function addAllNode(where, cards) {
  if (!cards.length) return null;
  const ids = cards.map((c) => c.id);
  const key = where + ':' + ids.join(',');
  const label = cards.length === 1 ? '▶ Add 1 to Build' : '▶ Add all ' + cards.length + ' shown to Build';
  if (armed !== key) {
    return el('button', { class: 'foot addall', title: 'Moves what is shown here, and only that, to Build', onclick: () => { armed = key; redraw(); setTimeout(() => { if (armed === key) { armed = ''; redraw(); } }, 5000); } }, label);
  }
  return el('button', { class: 'foot addall go', onclick: () => { armed = ''; post('move-many', { ids }, cards.length + ' moved to Build'); } },
    'Yes, move ' + cards.length + ' to Build');
}

// ---- the board: four columns

function drawBoard(b) {
  document.getElementById('board').replaceChildren(...COLUMNS.map(([key, name, hint]) => {
    const whole = b.columns[key].filter(shows);
    const tools = toolsNode(key, whole, b);
    const filter = tools.lastChild.value;
    const every = sorted(whole.filter((c) => passes(c, filter)), colOf(key).sort);
    // Done shows what is still for them to check. What they marked complete is history, a click away.
    const past = key === 'done' ? every.filter((c) => c.complete) : [];
    const cards = key === 'done' ? every.filter((c) => !c.complete) : every;
    // Every column takes a card dropped on it; only the backlog and Build take a new thread typed in.
    const drop = key === 'proposed' || key === 'build';
    // Build drawn as it stands is the order it will be built in, so a drop there is a place in that line.
    const line = key === 'build' && !colOf(key).sort;
    return el('section', { class: 'col', 'data-column': key,
      ondragover: (e) => {
        e.preventDefault();
        e.currentTarget.classList.add('over');
        if (line) landAt(e.currentTarget, e.clientY);
      },
      ondragleave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        e.currentTarget.classList.remove('over');
        unland();
      },
      ondrop: (e) => {
        e.currentTarget.classList.remove('over');
        const [id, from] = e.dataTransfer.getData('text/plain').split(' ');
        const spot = line && id ? spotOf(e.currentTarget, id) : null;
        unland();
        if (!id || (from === key && !spot)) return;
        e.preventDefault();
        // The server says what the move did: stopped an agent, undid its work, or queued it to build next.
        // Dropped at a place in Build, it is moved there first if it came from elsewhere, then put in that place.
        if (spot) post('order', { id, ...spot }, '');
        else post('move', { id, to: key }, '');
      } },
      el('h2', {}, DOT[key] + ' ' + name, el('span', { class: 'count' }, filter ? every.length + ' of ' + whole.length : String(cards.length))),
      line && cards.length > 1 && el('div', { class: 'hint' }, 'Built top first. Drag a card up or down to change the order.'),
      whole.length > 1 && tools,
      cards.length ? cards.map((c) => cardNode(c, b)) : el('div', { class: 'empty' }, filter ? 'Nothing here matches.' : key === 'done' ? 'Nothing left to check.' : hint),
      key === 'done' && cards.length > 1 && el('button', { class: 'foot go', onclick: () => post('complete-all', {}, 'All marked as complete') }, '✓ Mark all ' + cards.length + ' as complete'),
      key === 'done' && b.history > 0 && el('button', { class: 'history', onclick: () => { showHistory = !showHistory; redraw(); } },
        (showHistory ? '▾ Hide history' : '▸ History') + ' · ' + b.history + ' complete'),
      key === 'done' && showHistory && past.map((c) => cardNode(c, b)),
      key === 'done' && showHistory && b.history > past.length && !only && !query && el('div', { class: 'empty' }, '+ ' + (b.history - past.length) + ' older'),
      drop && addNode(key, key === 'build' ? 'What should be built?' : 'What do you want added?'),
      key === 'proposed' && cards.length > 0 && el('div', { style: 'margin-top: 8px' }, addAllNode('board', cards)));
  }));
}

// ---- while you were away: the morning brief, above the board's columns

// The rest of what shipped stays folded shut until asked for.
let briefRest = false;
// Folded, the panel is its headline alone, until the set of finished threads in it changes.
const briefSet = (r) => [...r.worthALook, ...r.alsoShipped.flatMap((g) => g.threads)].map((t) => t.id).sort().join(' ');
function briefFolded(r) {
  try { return localStorage.getItem('spool-brief-folded') === briefSet(r); } catch (e) { return false; }
}
function foldBrief(r, fold) {
  try { if (fold) localStorage.setItem('spool-brief-folded', briefSet(r)); else localStorage.removeItem('spool-brief-folded'); } catch (e) {}
  redraw();
}

// When it stopped: so long ago, or on a day.
function briefWhen(at) {
  const said = ago(at);
  return !said || said === 'now' ? '' : /^\d+[mh]$/.test(said) ? ', ' + said + ' ago' : ', on ' + said;
}

function drawBrief(b) {
  const box = document.getElementById('brief');
  const r = b.brief;
  box.hidden = view !== 'board' || !r;
  if (box.hidden) { box.replaceChildren(); return; }
  const folded = briefFolded(r);
  const head = el('button', { class: 'bhead', 'aria-expanded': String(!folded), title: folded ? 'Show the brief' : 'Fold it to this line',
    onclick: () => foldBrief(r, !folded) }, el('span', { class: 'fold' }, folded ? '▸' : '▾'), el('span', {}, r.headline));
  if (folded) { box.replaceChildren(head); return; }
  const n = r.needsYou;
  const open = (id) => () => { if (id) openThread(id); };
  const plural = (k, one) => k + ' ' + one + (k === 1 ? '' : 's');
  const needs = [
    ...n.questions.map((q) => {
      const asked = b.needs.questions.find((x) => x.id === q.id);
      return el('div', { class: 'card', 'data-id': q.id },
        el('div', { class: 'title', onclick: open(asked && asked.threads[0]) }, '❓ ' + q.title),
        q.blocks > 0 && el('div', { class: 'note' }, 'Holds up ' + plural(q.blocks, 'thread')),
        answersNode(q));
    }),
    ...n.plans.map((t) => el('div', { class: 'card', 'data-id': t.id },
      el('div', { class: 'title', onclick: open(t.id) }, '📋 Plan: ' + t.title),
      t.summary && el('div', { class: 'note' }, t.summary),
      el('div', { class: 'why' }, plural(t.parts, 'part') + (t.parts === 1 ? ' waits' : ' wait') + ' for your go-ahead'))),
    ...n.stopped.map((t) => el('div', { class: 'card', 'data-id': t.id },
      el('div', { class: 'title', onclick: open(t.id) }, '↺ ' + t.title),
      el('div', { class: 'why' }, t.why + briefWhen(t.when)),
      t.lastSaid && el('div', { class: 'note' }, 'Last said: “' + t.lastSaid + '”'))),
  ];
  const rest = r.alsoShipped.reduce((k, g) => k + g.threads.length, 0);
  // Approving everything is what the brief's last line says: the finished threads, and the calls agents made.
  const approve = async () => {
    const ok = !r.shipped || await post('complete-all', {}, 'All marked as complete');
    if (ok && r.calls.length) await post('approve-calls', {}, 'All approved');
  };
  box.replaceChildren(...[head,
    needs.length > 0 && [el('h2', {}, 'Needs you', el('span', { class: 'count' }, String(needs.length))), needs],
    r.worthALook.length > 0 && [el('h2', {}, 'Worth a look', el('span', { class: 'count' }, String(r.worthALook.length))),
      r.worthALook.map((t) => el('div', { class: 'card', 'data-id': t.id },
        el('div', { class: 'title', onclick: open(t.id) }, t.title),
        t.summary && el('div', { class: 'note' }, t.summary),
        el('div', { class: 'why' }, t.reasons.join(' · '))))],
    rest > 0 && el('button', { class: 'history', 'aria-expanded': String(briefRest), onclick: () => { briefRest = !briefRest; redraw(); } },
      (briefRest ? '▾ ' : '▸ ') + (r.worthALook.length ? 'Also shipped' : 'Shipped') + ' · ' + rest),
    rest > 0 && briefRest && r.alsoShipped.map((g) => [
      g.sprint && el('div', { class: 'sprint' }, '🏁 ' + g.sprint.title),
      g.threads.map((t) => el('div', { class: 'card', 'data-id': t.id },
        el('div', { class: 'title', onclick: open(t.id) }, t.title),
        t.summary && el('div', { class: 'note' }, t.summary)))]),
    r.approve && (r.shipped > 0 || r.calls.length > 0) && el('button', { class: 'foot go', onclick: approve }, 'All good: approve everything')].flat(3).filter(Boolean));
}

// ---- the backlog: sprints to fill and play, then everything that is in none

function dropInto(node, sprint) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('over');
    const [id] = e.dataTransfer.getData('text/plain').split(' ');
    if (!id) return;
    e.preventDefault();
    post('assign', { id, sprint }, sprint ? 'In the sprint' : 'Back in the backlog');
  });
  return node;
}

function sprintNode(s, b) {
  const rows = everyCard(b).filter((c) => c.sprint === s.id && shows(c));
  const finished = s.status === 'done';
  const group = el('div', { class: 'group' },
    el('div', { class: 'ghead' },
      el('span', { class: 'gname' }, s.name),
      el('span', { class: 'state ' + s.status }, s.status),
      el('span', { class: 'gmeta' }, s.total ? s.done + ' of ' + s.total + ' done' : 'Empty: drag threads here'),
      s.total > 0 && el('span', { class: 'prog' }, el('i', { style: 'width: ' + Math.round((100 * s.done) / s.total) + '%' })),
      el('span', { class: 'push' },
        s.waiting > 0 && el('button', { class: 'go', title: 'Everything in it moves to Build', onclick: () => post('play', { id: s.id }, s.name + ' is running') },
          s.status === 'running' ? '▶ Play ' + s.waiting + ' more' : '▶ Play sprint'),
        !finished && s.status !== 'running' && el('button', { title: 'Remove the sprint. What is in it goes back to the backlog.', onclick: () => post('drop-sprint', { id: s.id }, 'Sprint removed') }, '✕'))),
    aboutNode(s),
    rows.map((c) => rowNode(c, b)));
  return finished ? group : dropInto(group, s.id);
}

// What a sprint is for: its goal, the reason, and when it is done. Click it to write or change it.
let editingSprint = '';
function aboutNode(s) {
  if (editingSprint === s.id) {
    const field = (key, placeholder) => { const box = el('input', { placeholder, 'data-about': key }); box.value = s[key] || ''; return box; };
    const form = el('div', { class: 'aboutform' },
      field('goal', 'Goal: what this sprint is for'), field('why', 'Why: why now'), field('doneWhen', 'Done when: what will be true'));
    const read = () => Object.fromEntries([...form.querySelectorAll('input')].map((box) => [box.dataset.about, box.value]));
    form.append(el('div', { class: 'acts' },
      el('button', { class: 'go', onclick: () => { const about = read(); editingSprint = ''; post('sprint-about', { id: s.id, ...about }, 'Saved'); } }, 'Save'),
      el('button', { onclick: () => { editingSprint = ''; redraw(); } }, 'Cancel')));
    return form;
  }
  const open = () => { editingSprint = s.id; redraw(); };
  if (!s.goal && !s.why && !s.doneWhen) return s.status === 'done' ? null : el('div', { class: 'about', onclick: open }, '+ Say what this sprint is for');
  return el('div', { class: 'about', title: 'Click to change', onclick: s.status === 'done' ? null : open },
    s.goal && el('div', {}, el('b', {}, 'Goal '), s.goal),
    s.why && el('div', {}, el('b', {}, 'Why '), s.why),
    s.doneWhen && el('div', {}, el('b', {}, 'Done when '), s.doneWhen));
}

function drawBacklog(b) {
  const open = b.sprints.filter((s) => s.status !== 'done');
  const finished = b.sprints.filter((s) => s.status === 'done');
  const loose = b.columns.proposed.filter((c) => !c.sprint && shows(c));
  const newSprint = adding === 'sprint'
    ? el('div', { class: 'adding', style: 'max-width: 360px; margin-bottom: 14px' },
        (() => {
          const box = el('input', { placeholder: 'Name the sprint',
            oninput: (e) => { addDraft = e.target.value; },
            onkeydown: (e) => {
              if (e.key === 'Enter' && addDraft.trim()) { const name = addDraft.trim(); adding = null; addDraft = ''; post('sprint', { name }, 'Sprint made'); }
              if (e.key === 'Escape') { e.stopPropagation(); adding = null; addDraft = ''; redraw(); }
            } });
          box.value = addDraft;
          return box;
        })(),
        el('div', { class: 'acts' },
          el('button', { class: 'go', onclick: () => { const name = addDraft.trim(); if (!name) return; adding = null; addDraft = ''; post('sprint', { name }, 'Sprint made'); } }, 'Create'),
          el('button', { onclick: () => { adding = null; addDraft = ''; redraw(); } }, 'Cancel')))
    : el('button', { style: 'margin-bottom: 14px', onclick: () => { adding = 'sprint'; addDraft = 'Sprint ' + (b.sprints.length + 1); redraw(); } }, '+ Create sprint');
  document.getElementById('backlog').replaceChildren(
    ...[waitingNode(b)].filter(Boolean),
    ...open.map((s) => sprintNode(s, b)),
    newSprint,
    dropInto(el('div', { class: 'group' },
      el('div', { class: 'ghead' }, el('span', { class: 'gname' }, 'Backlog'), el('span', { class: 'gmeta' }, loose.length + (loose.length === 1 ? ' thread' : ' threads') + ' in no sprint')),
      loose.length ? loose.map((c) => rowNode(c, b)) : el('div', { class: 'empty' }, 'Everything is in a sprint, or built.'),
      addNode('proposed', 'What do you want added?'),
      loose.length > 0 && el('div', { style: 'margin-top: 8px; max-width: 320px' }, addAllNode('backlog', loose))), ''),
    ...finished.map((s) => sprintNode(s, b)),
    archivedNode(b));
}

// The foot of the backlog: what was archived, folded shut, each with its way back.
function archivedNode(b) {
  if (!b.archived.length) return '';
  const rows = b.archived.filter(shows);
  const row = (c) => el('div', { class: 'row', 'data-id': c.id },
    el('div', {}, el('span', { title: c.title }, c.title), c.why && el('div', { class: 'why', title: c.why }, c.why)),
    el('div', { class: 'right' }, el('span', {}, c.note), el('span', { class: 'key' }, c.id),
      el('button', { class: 'act', title: 'Back to the backlog, just as it was', onclick: () => post('unarchive', { id: c.id }, 'Back in the backlog: ' + c.title) }, '↩ Bring back')));
  return el('div', { class: 'group', id: 'archived' },
    el('button', { class: 'history', 'aria-expanded': String(showArchived), onclick: () => { showArchived = !showArchived; redraw(); } },
      (showArchived ? '▾ Archived' : '▸ Archived') + ' · ' + b.archived.length),
    showArchived && (rows.length ? rows.map(row) : el('div', { class: 'empty' }, 'Nothing archived matches.')));
}

// ---- what waits on him: on the thread it is about, or at the top of the backlog when it is about none

// The calls agents made for a thread and the skills it taught, that he has not looked at yet.
const callsFor = (b, id) => b.needs.calls.filter((x) => x.threads.includes(id));
const skillsFor = (b, id) => b.needs.skills.filter((x) => x.threads.includes(id));
const planWaits = (b, id) => b.needs.plans.some((x) => x.id === id);
// What is about no thread on the board has nowhere else to be shown, so the backlog's strip carries it.
function homeless(b, list) {
  const ids = new Set(everyCard(b).map((c) => c.id));
  return list.filter((x) => !x.threads.some((id) => ids.has(id)));
}

// A box to say something else in, and the button that sends it.
function sayNode(placeholder, label, send) {
  const box = el('input', { placeholder, onkeydown: (e) => { if (e.key === 'Enter' && box.value.trim()) send(box.value.trim()); } });
  return el('span', { class: 'say' }, box, el('button', { onclick: () => { if (box.value.trim()) send(box.value.trim()); } }, label));
}
// A question is answered with one of its options, or in his own words.
function answersNode(q) {
  return el('div', { class: 'acts wrap' },
    q.options.map((o, i) => el('button', { class: q.recommend === i + 1 ? 'rec' : '', title: q.recommend === i + 1 ? 'Recommended' : '',
      onclick: () => post('answer', { id: q.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)),
    sayNode('Or say what you want', 'Answer', (words) => post('answer', { id: q.id, choice: words }, 'Answered')));
}
// A call an agent made is fine by him, or he overrules it in his own words.
function callActs(call) {
  return el('div', { class: 'acts wrap' },
    el('button', { onclick: () => post('approve', { id: call.id }, 'Accepted') }, 'Fine'),
    sayNode('No: say what you want instead', 'Overrule', (words) => post('answer', { id: call.id, choice: words }, 'Overruled')));
}
function skillActs(skill) {
  return el('div', { class: 'acts wrap' },
    el('button', { onclick: () => post('approve', { id: skill.id }, 'Kept') }, 'Keep'),
    el('button', { onclick: () => post('drop-skill', { id: skill.id }, 'Dropped') }, 'Drop'));
}

// A call an agent made, as a post in its thread: what it chose, the question and the why under it.
// Until he has looked at it, Fine and Overrule are right there.
function decidedNode(who, at, ref, text, b, t) {
  const call = b.needs.calls.find((x) => x.id === ref);
  const d = t.questions.find((x) => x.id === ref);
  // The log line is "question → choice". Accepted, the decision still says the same choice; overruled, it says his.
  const cut = text.lastIndexOf(' → ');
  const chose = call ? call.choice : d && text.endsWith(' → ' + d.choice) ? d.choice : cut > 0 ? text.slice(cut + 3) : '';
  const question = call ? call.title : d ? d.title : cut > 0 ? text.slice(0, cut) : text;
  const why = call ? call.why : d ? d.why : '';
  return el('div', { class: 'post', 'data-call': ref }, avatar(who),
    el('div', {}, byline(who, at),
      el('pre', {}, 'Decided: ' + chose),
      el('div', { class: 'note' }, question),
      why && el('div', { class: 'note' }, 'Why: ' + why),
      call ? callActs(call)
        : d && d.status === 'decided' && d.choice !== chose ? el('span', { class: 'badge ask' }, 'You overruled it: ' + d.choice)
        : d && d.status === 'decided' && el('span', { class: 'badge' }, '✓ Fine by you')));
}
// A skill an agent wrote while working on the thread, to keep or drop.
function skillPost(skill) {
  return el('div', { class: 'post' }, avatar(skill.by || 'agent'),
    el('div', {}, byline(skill.by || 'agent', ''),
      el('span', { class: 'badge' }, '📘 Wrote a new skill'),
      el('pre', {}, skill.name),
      skill.about && el('div', { class: 'note' }, skill.about),
      skillActs(skill)));
}

// The strip at the top of the backlog: notes nobody filed, and anything waiting on him that is about
// no thread. It is not there when there is nothing in it.
function waitingNode(b) {
  const n = b.needs;
  const items = [
    ...homeless(b, n.questions).map((q) => el('div', { class: 'need' },
      el('div', { class: 'what' }, '❓ ' + q.title),
      q.why && el('div', { class: 'more' }, q.why),
      answersNode(q))),
    ...homeless(b, n.calls).map((call) => el('div', { class: 'need' },
      el('div', { class: 'what' }, 'Decided: ' + call.choice),
      el('div', { class: 'more' }, call.title),
      call.why && el('div', { class: 'more' }, 'Why: ' + call.why),
      callActs(call))),
    ...homeless(b, n.skills).map((skill) => el('div', { class: 'need' },
      el('div', { class: 'what' }, '📘 New skill: ' + skill.name),
      skill.about && el('div', { class: 'more' }, skill.about),
      skillActs(skill))),
    ...n.notes.map((note) => el('div', { class: 'need' },
      el('pre', {}, note.text),
      el('div', { class: 'acts wrap' },
        el('button', { class: 'go', onclick: () => post('note-thread', { id: note.id, title: note.text }, 'It is a thread in the backlog') }, 'Make it a thread'),
        el('button', { onclick: () => post('note-aside', { id: note.id }, 'Set aside') }, 'Set aside')))),
  ];
  // Many calls are accepted in one go, wherever they are.
  const all = n.calls.length > 1 && el('button', { onclick: () => post('approve-calls', {}, 'All accepted') }, 'All ' + n.calls.length + ' calls fine');
  if (!items.length && !all) return null;
  return el('div', { class: 'group waiting' },
    el('div', { class: 'ghead' }, el('span', { class: 'gname' }, 'Waiting on you'),
      el('span', { class: 'gmeta' }, items.length ? 'Not on any thread yet' : 'Agents made ' + n.calls.length + ' calls on their threads'),
      all && el('span', { class: 'push' }, all)),
    items);
}

// ---- the ticket

const whoIs = (who) => (who === 'human' ? 'You' : who === 'agent' ? 'An agent' : who === 'loop' ? 'The loop' : who || 'Someone');
// An agent that signed with its model's name is shown as who it is: "Claude" and the model beside it.
const speaker = (who) => {
  if (who === 'human') return { name: 'You', model: '', kind: 'you' };
  const claude = /^claude\b[\s-]*(.*)$/i.exec(who || '');
  if (claude) return { name: 'Claude', model: claude[1].trim(), kind: 'claude' };
  if (who === 'agent' || !who) return { name: 'Agent', model: '', kind: 'agent' };
  if (who === 'loop') return { name: 'The loop', model: '', kind: 'agent' };
  if (who === 'page') return { name: 'The page', model: '', kind: 'agent' };
  return { name: who, model: '', kind: 'agent' };
};
// Claude's own mark, from docs/claude_logo.svg. It is Anthropic's trademark, shown only to say which agent did the work.
const CLAUDE = '<svg viewBox="0 0 24 24" fill="#D97757" role="img" aria-label="Claude"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
// The human's identicon for this project, from the board: each spool draws its own.
let YOU = '';
function avatar(who) {
  const s = speaker(who);
  const node = el('div', { class: 'avatar ' + s.kind, title: s.model ? s.name + ' ' + s.model : s.name });
  if (s.kind === 'claude') node.innerHTML = CLAUDE;
  else if (s.kind === 'you' && YOU) node.innerHTML = YOU;
  else node.textContent = s.kind === 'you' ? 'You'.slice(0, 1) : '🤖';
  return node;
}
function byline(who, at) {
  const s = speaker(who);
  return el('div', { class: 'byline' }, el('b', {}, s.name), s.model && el('span', { class: 'model' }, s.model), at && [el('span', { class: 'sep' }, '·'), stamp(at)]);
}
const when = (at) => (at ? at.slice(5, 10).replace('-', '/') + ' ' + at.slice(11, 16) : '');
// When something was said, the way a thread reads it: "now", "4m", "3h", then the day. The exact time is on hover,
// and the clock on the page keeps it current.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const timeOf = (at) => Date.parse(String(at).replace(' ', 'T'));
function ago(at) {
  const then = timeOf(at);
  if (isNaN(then)) return '';
  const s = (Date.now() - then) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  const d = new Date(then);
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? '' : ', ' + d.getFullYear());
}
const stamp = (at) => (isNaN(timeOf(at)) ? null : el('time', { class: 'at', 'data-at': at, title: new Date(timeOf(at)).toLocaleString() }, ago(at)));
// Words in backticks are code: shown as code, and a long path by its last part, whole on hover.
function rich(text) {
  return String(text).split(/\x60([^\x60\n]+)\x60/).map((part, i) => (i % 2
    ? el('code', { title: part }, part.length > 40 ? part.replace(/\S*\/(\S+)/g, '$1') : part)
    : part));
}
// A long run of bookkeeping between two posts is folded to its first and last line, a click from the rest.
const unfolded = new Set();
function folded(id, feed) {
  if (unfolded.has(id)) return feed;
  const out = [];
  for (let i = 0; i < feed.length;) {
    let j = i;
    while (j < feed.length && feed[j].kind === 'event') j++;
    if (j - i > 4) out.push(feed[i], { kind: 'fold', text: (j - i - 2) + ' more' }, feed[j - 1]);
    else out.push(...feed.slice(i, j));
    if (j < feed.length) out.push(feed[j]);
    i = j + 1;
  }
  return out;
}
// While an agent works, it is the newest post in the thread: who, for how long, what it is doing now,
// and its log as it comes. A chat building it has no log here, only the note it last left.
function livePost(c, b) {
  if (c.column !== 'building' || !c.live) return null;
  const run = liveOf(c, b);
  const who = c.thread.by || 'agent';
  const s = speaker(who);
  const face = avatar(who);
  face.append(el('span', { class: 'pulse' }));
  return el('div', { class: 'post livepost' }, face,
    el('div', {},
      el('div', { class: 'byline' }, el('b', {}, s.name), s.model && el('span', { class: 'model' }, s.model), el('span', { class: 'sep' }, '·'),
        el('span', { class: 'at' }, 'working for ', el('span', { 'data-since': c.live.since }, took(c.live.since))),
        c.worktree && el('span', { class: 'at', title: 'Its own git worktree: a checkout apart from yours, that lands on yours when it is done' }, ' · in ' + c.worktree),
        run && stopNode(c, 'act stop', '■ Stop the agent')),
      el('div', { class: 'livenow' }, el('span', { class: 'nowtext' }, (run && run.lines.at(-1)) || c.live.note || 'starting…'), el('span', { class: 'caret' })),
      run && el('div', { class: 'livelog', 'data-keep': 'livelog', 'data-follow': 'true' }, run.lines.join('\n') || 'starting…')));
}

// The open thread is in the address, so a ticket can be linked to and survives a reload.
function openThread(id) { openId = id; history.replaceState(null, '', '#' + id); redraw(); }
function closeThread() { openId = null; history.replaceState(null, '', location.pathname); redraw(); }

// What a thread changed, fetched when asked for and kept: the files, the lines, and the patch itself.
const diffs = new Map();
const showing = new Set();
let undoing = '';
async function showChanges(id) {
  if (showing.has(id)) { showing.delete(id); redraw(); return; }
  showing.add(id);
  if (!diffs.has(id)) {
    try { diffs.set(id, await (await fetch('/api/diff?id=' + id)).json()); } catch (e) { say('The changes could not be read.'); }
  }
  redraw();
}
// The patch the server sends is one text; the files in it are told apart here, the way a pull request lists them.
// Each file keeps its header facts (new, deleted, renamed, binary) and its hunks as rows with both line numbers.
function parsePatch(patch) {
  const files = [];
  const byPath = new Map();
  let f = null, h = null, old = 0, now = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(text);
      const path = m ? m[2] : text.slice(11);
      f = byPath.get(path);
      // One file touched by several commits is one row, its hunks in the order they happened.
      if (!f) { f = { path, from: m ? m[1] : path, state: '', binary: false, hunks: [] }; byPath.set(path, f); files.push(f); }
      else if (f.state === 'deleted') f.state = '';
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (text.startsWith('new file mode')) f.state = f.state || 'new';
      else if (text.startsWith('deleted file mode')) f.state = 'deleted';
      else if (text.startsWith('rename from ')) { f.state = 'renamed'; f.from = text.slice(12); }
      else if (text.startsWith('Binary files') || text.startsWith('GIT binary patch')) f.binary = true;
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(text);
    if (at) { h = { title: text, rows: [] }; f.hunks.push(h); old = +at[1]; now = +at[2]; continue; }
    if (!h || !text) continue;
    const mark = text[0];
    if (mark === '+') h.rows.push({ kind: 'plus', old: '', now: now++, text: text.slice(1) });
    else if (mark === '-') h.rows.push({ kind: 'minus', old: old++, now: '', text: text.slice(1) });
    else if (mark === ' ') h.rows.push({ kind: '', old: old++, now: now++, text: text.slice(1) });
    else h.rows.push({ kind: 'none', old: '', now: '', text });
  }
  for (const g of files) {
    g.added = g.hunks.reduce((n, x) => n + x.rows.filter((r) => r.kind === 'plus').length, 0);
    g.removed = g.hunks.reduce((n, x) => n + x.rows.filter((r) => r.kind === 'minus').length, 0);
  }
  return files;
}

// Which files of a ticket are folded open, and how far each is scrolled sideways: kept across redraws.
const opened = new Map();
const sideways = new Map();
function changeBar(added, removed) {
  const total = added + removed;
  let green = total ? Math.round(5 * added / total) : 0;
  let red = total ? 5 - green : 0;
  if (added && !green) { green = 1; red = 4; }
  if (removed && !red) { red = 1; green = 4; }
  return el('span', { class: 'stat', 'aria-hidden': 'true' },
    [0, 1, 2, 3, 4].map((i) => el('i', { class: i < green ? 'plus' : i < green + red ? 'minus' : '' })));
}
function fileDiff(key, g, cutNote) {
  const table = el('table', { class: 'lines' }, g.hunks.map((h) => el('tbody', {},
    el('tr', { class: 'at' }, el('td', { colspan: 4 }, h.title)),
    h.rows.map((r) => el('tr', { class: r.kind },
      el('td', { class: 'num' }, r.old === '' ? '' : String(r.old)),
      el('td', { class: 'num' }, r.now === '' ? '' : String(r.now)),
      el('td', { class: 'sign' }, r.kind === 'plus' ? '+' : r.kind === 'minus' ? '−' : ''),
      el('td', { class: 'code' }, r.text))))));
  const box = el('div', { class: 'scroll', 'data-keep': 'diff:' + key }, table);
  box.addEventListener('scroll', () => sideways.set(key, box.scrollLeft));
  // A box has no width until it is on the page, so its sideways place is put back once it is.
  const was = sideways.get(key);
  if (was) setTimeout(() => { box.scrollLeft = was; }, 0);
  return el('div', { class: 'filebody' },
    g.binary && !g.hunks.length ? el('div', { class: 'note' }, 'A binary file: there are no lines to show.') : g.hunks.length ? box : el('div', { class: 'note' }, g.state === 'renamed' ? 'Renamed, with no lines changed.' : 'No lines to show.'),
    cutNote);
}
function changesNode(c) {
  if (!c.done || !c.thread.commits.length) return null;
  const d = showing.has(c.id) && diffs.get(c.id);
  const head = el('button', { onclick: () => showChanges(c.id) }, d ? 'Hide the changes' : 'Show what changed');
  if (!d) return el('div', { class: 'changes' }, head);
  if (!d.files.length) return el('div', { class: 'changes' }, head, el('div', { class: 'note' }, 'No changes on record for it in this repository.'));
  const parsed = parsePatch(d.patch || '');
  const counted = new Map(d.files.map((f) => [f.path, f]));
  // The rows: every file in the patch, then any the cut patch never reached.
  const rows = parsed.map((g) => {
    const n = counted.get(g.path);
    return { ...g, added: n ? n.added : g.added, removed: n ? n.removed : g.removed };
  });
  for (const f of d.files) if (!parsed.some((g) => g.path === f.path) && !f.path.includes(' => ')) rows.push({ path: f.path, state: '', binary: false, hunks: [], added: f.added, removed: f.removed, unseen: true });
  const added = d.files.reduce((n, f) => n + f.added, 0);
  const removed = d.files.reduce((n, f) => n + f.removed, 0);
  const small = added + removed < 40;
  const shas = d.commits.map((x) => x.sha).join(' ');
  const cutNote = el('div', { class: 'note cutnote' }, 'The rest of this change is not shown here. To see it: ', el('code', {}, 'git show ' + shas));
  return el('div', { class: 'changes' }, head,
    el('div', { class: 'sum' },
      el('b', {}, d.files.length + (d.files.length === 1 ? ' file' : ' files') + ' changed'), ' ',
      el('span', { class: 'plus' }, '+' + added), ' ', el('span', { class: 'minus' }, '−' + removed)),
    el('div', { class: 'commits' }, d.commits.map((x) => el('div', {}, el('span', { class: 'mono' }, x.sha), ' ' + x.subject))),
    rows.map((g, i) => {
      const key = c.id + '\0' + g.path;
      const open = opened.has(key) ? opened.get(key) : small || i === 0;
      const slash = g.path.lastIndexOf('/');
      const last = i === rows.length - 1;
      const word = g.binary ? 'binary' : g.state === 'new' ? 'new' : g.state === 'deleted' ? 'deleted' : g.state === 'renamed' ? 'renamed from ' + g.from : '';
      const cut = d.cut && last;
      return el('div', { class: 'file' + (open ? ' open' : '') },
        el('div', { class: 'filehead', role: 'button', tabindex: '0', 'aria-expanded': String(open),
          onclick: () => { opened.set(key, !open); redraw(); },
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opened.set(key, !open); redraw(); } } },
          el('span', { class: 'twist' }, open ? '▾' : '▸'),
          el('span', { class: 'path mono' }, slash >= 0 && el('span', { class: 'dir' }, g.path.slice(0, slash + 1)), g.path.slice(slash + 1)),
          word && el('span', { class: 'word' }, word),
          el('span', { class: 'plus' }, '+' + g.added), el('span', { class: 'minus' }, '−' + g.removed),
          changeBar(g.added, g.removed)),
        open && (g.unseen ? cutNote : fileDiff(key, g, cut && cutNote)));
    }));
}
// Undo is the other answer to finished work: take back exactly what this thread changed, and say why.
function undoNode(c) {
  if (!c.done) return null;
  if (undoing !== c.id) return el('button', { style: 'margin-top: 10px', onclick: () => { undoing = c.id; redraw(); } }, '↩ Undo this thread');
  const why = el('input', { placeholder: 'What was wrong with it? In your words' });
  const go = (drop) => { undoing = ''; post('undo', { id: c.id, why: why.value, drop }, drop ? 'Undone and dropped' : 'Undone. It is back to be done again, with your words on it.'); };
  return el('div', { class: 'undo' }, why,
    el('div', { class: 'acts' },
      el('button', { class: 'go', onclick: () => go(false) }, 'Undo, and do it again'),
      el('button', { onclick: () => go(true) }, 'Undo, and drop it'),
      el('button', { onclick: () => { undoing = ''; redraw(); } }, 'Cancel')));
}

// What a thread is, told plainly and in parts: the kind of work, what changes, how it helps Spool,
// when it is done, and why an agent thought of it. A spec with no parts falls back to the human's words.
const KINDS = {
  change: ['🛠', 'A change', 'built, checked, and shipped in small commits'],
  audit: ['🔍', 'An audit', 'a look and a report; each finding is filed as its own thread'],
  plan: ['🗺', 'A plan', 'worked out and split into parts; nothing is built here'],
};
const ABOUT_ICON = { what: '🧵', why: '🌱', done: '🏁', other: '📝' };
function describeNode(c) {
  const t = c.thread;
  const parts = t.about.slice();
  if (!parts.some((p) => p.key === 'what') && t.said.length) parts.unshift({ key: 'what', label: 'What was asked for', text: t.said[0].text });
  const kind = KINDS[c.type] || KINDS.change;
  const sized = c.difficulty ? ' · ' + c.difficulty.toLowerCase() + ' job' : '';
  const part = (icon, label, text, key) => el('div', { class: 'part ' + key },
    el('div', { class: 'icon' }, icon),
    el('div', {}, el('div', { class: 'label' }, label), el('pre', {}, text)));
  return el('details', { class: 'desc', open: true, 'data-keep': 'about' },
    el('summary', {}, '🧶 About this thread'),
    el('div', { class: 'kind' }, kind[0] + ' ' + kind[1] + sized, el('span', {}, ' — ' + kind[2])),
    parts.map((p) => part(ABOUT_ICON[p.key], p.label, p.text, p.key)),
    c.suggested && part('✨', 'Why an agent suggested it', c.suggested, 'idea'));
}

// At the top of a ticket, when the thread cannot move on by itself: what it waits on, and what would move it.
function waitNode(c, b) {
  const w = c.waiting;
  if (!w) return null;
  const link = (t) => el('a', { href: '#' + t.id, onclick: (e) => { e.preventDefault(); openThread(t.id); } }, el('span', { class: 'key' }, t.id), ' ' + t.title);
  const said = w.kind === 'stuck' && lastWords(c, b);
  const parts = {
    you: ['Needs you', [
      el('div', { class: 'what' }, w.text),
      c.question && el('div', {}, c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '',
        onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o))),
      w.on.map(link)]],
    thread: ['Waiting on ' + (w.on.length === 1 ? 'another thread' : w.on.length + ' other threads'), [
      w.on.map(link),
      el('div', { class: 'soft' }, 'It starts by itself once ' + (w.on.length === 1 ? 'that one is' : 'those are') + ' done.')]],
    hold: ['On hold', [
      el('div', { class: 'what' }, w.text),
      el('button', { onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title) }, '▶ Build it now')]],
    stuck: ['The agent stopped without finishing', [
      el('div', { class: 'what' }, 'It ' + w.text + '.' + (said ? ' It last said: “' + said + '”' : '')),
      w.refused.length > 0 && el('div', { class: 'soft' }, 'It was refused: ', w.refused.map((r, i) => [i ? ', ' : '', el('span', { class: 'mono' }, r)])),
      el('div', { class: 'soft' }, 'It waits in Build. Reply below to tell the next agent what to do differently.')]],
  }[w.kind];
  return el('div', { class: 'notice ' + w.kind, role: 'status' }, el('div', { class: 'head' }, parts[0]), parts[1]);
}

// At the top of the ticket of a thread the human stopped: that they did, and the way on.
function stoppedNode(c, b) {
  if (!stoppedOf(c, b)) return null;
  return el('div', { class: 'notice', role: 'status' }, el('div', { class: 'head' }, 'Stopped'),
    el('div', { class: 'what' }, 'You stopped the agent that was building this. Nothing builds it until you carry on.'), carryOnNode(c, 'go'));
}

// A ticket, the way a board has always shown one: the story on the left, its fields on the right.
function threadNode(c, b) {
  const t = c.thread;
  const save = (fields, done) => post('edit', { id: c.id, ...fields }, done);
  const reply = async () => {
    if (!box.value.trim()) return;
    if (await post('note', { id: c.id, text: box.value }, 'Posted to the thread')) drafts.delete(c.id);
  };
  // Enter sends, as in any chat; Shift+Enter is a new line. A word still being composed (an IME) is left to finish.
  const box = el('textarea', { placeholder: 'Post your reply', rows: 2,
    oninput: (e) => { drafts.set(c.id, e.target.value); send.disabled = !e.target.value.trim(); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); reply(); } } });
  box.value = drafts.get(c.id) || '';
  const send = el('button', { class: 'go', onclick: reply, disabled: !box.value.trim() }, 'Reply');
  const lineage = [
    ...t.cameFrom.map((f) => 'Came out of: ' + f.title),
    ...t.parts.map((p) => 'Part: ' + p.title + ' (' + p.state + ')'),
    // A call an agent made is already a post in the conversation.
    ...t.questions.filter((q) => !t.feed.some((p) => p.ref === q.id)).map((q) => 'Asked: ' + q.title + (q.choice ? ' → ' + q.choice : ' → not answered yet')),
  ];

  const title = el('h2', { contenteditable: 'plaintext-only', spellcheck: 'false', title: 'Click to rename',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = c.title; e.target.blur(); e.stopPropagation(); } },
    onblur: (e) => { const now = e.target.textContent.trim(); if (now && now !== c.title) save({ title: now }, 'Renamed'); else e.target.textContent = c.title; } }, c.title);

  const story = el('div', {},
    el('div', { class: 'key' }, (c.n != null ? '#' + c.n + ' · ' : '') + c.id),
    title,
    waitNode(c, b),
    stoppedNode(c, b),
    describeNode(c),

    // The thread itself: a conversation, oldest first. You said, Claude answered, and the moves in between.
    el('div', { class: 'feed' },
      folded(c.id, t.feed).map((p) => {
        if (p.kind === 'fold') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }),
            el('button', { class: 'fold', onclick: () => { unfolded.add(c.id); redraw(); } }, p.text));
        }
        if (p.kind === 'event') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }), el('div', {}, speaker(p.who).name + ' ', rich(p.text), p.at && [el('span', { class: 'sep' }, '·'), stamp(p.at)]));
        }
        if (p.kind === 'decided') return decidedNode(p.who, p.at, p.ref, p.text, b, t);
        const asking = p.kind === 'asked' && c.question && c.question.title === p.text;
        return el('div', { class: 'post' }, avatar(p.who),
          el('div', {}, byline(p.who, p.at),
            p.kind === 'shipped' && el('span', { class: 'badge' }, '✓ Shipped'),
            p.kind === 'asked' && el('span', { class: 'badge ask' }, '❓ Needs a call from you'),
            el('pre', {}, rich(p.text)),
            p.kind === 'shipped' && t.checked && el('div', { class: 'badge', style: 'display: block' }, '✓ Check passed: ' + t.checked),
            p.kind === 'shipped' && t.commits.length > 0 && el('div', { class: 'mono', style: 'margin-top: 6px; color: var(--soft)' }, (t.commits.length === 1 ? 'commit ' : 'commits ') + t.commits.join(' · ')),
            asking && answersNode(c.question)));
      }),
      // A question with no line of its own in the log still has to be answerable here.
      c.question && !t.feed.some((p) => p.kind === 'asked' && p.text === c.question.title) && el('div', { class: 'post' }, avatar(t.by || 'agent'),
        el('div', {}, byline(t.by || 'agent', ''), el('span', { class: 'badge ask' }, '❓ Needs a call from you'), el('pre', {}, c.question.title),
          answersNode(c.question))),
      // So does a call made for it with no line of its own, and a skill it taught.
      callsFor(b, c.id).filter((x) => !t.feed.some((p) => p.ref === x.id)).map((x) => decidedNode(x.by || 'agent', '', x.id, x.title + ' → ' + x.choice, b, t)),
      skillsFor(b, c.id).map(skillPost),
      livePost(c, b),
      !t.feed.length && !c.question && !c.live && el('div', { class: 'empty' }, 'Nothing has been said here yet.')),

    t.report && el('details', { class: 'desc', open: true, 'data-keep': 'report' }, el('summary', {}, c.type === 'plan' ? 'The plan' : 'The report'), el('pre', {}, t.report)),

    lineage.length > 0 && [el('h3', {}, 'Linked'), lineage.map((l) => el('div', { class: 'note' }, l))],

    el('div', { class: 'compose' }, avatar('human'),
      el('div', {}, box,
        el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Enter to send · Shift+Enter for a new line'), send))),
    changesNode(c),
    c.done && el('div', { class: 'finish' }, c.complete
      ? el('div', { class: 'ok' }, '✓ Complete. You approved this change.')
      // A plan's parts wait for his go-ahead, and this is where he gives it.
      : planWaits(b, c.id) ? el('button', { class: 'go', onclick: () => post('approve', { id: c.id }, 'The plan has your go-ahead') }, '✓ Go ahead with the plan')
      : el('button', { class: 'go', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓ Mark as complete'),
      undoNode(c)));

  const field = (label, ...kids) => el('div', { class: 'field' }, el('label', {}, label), kids);
  const choose = (options, value, onchange) => {
    const node = el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  // Which model builds it and how hard it thinks: Fable decides when it starts (or the size suggests)
  // until the human picks, and the human's pick always wins.
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
  const models = [...new Set([...MODELS, c.model].filter(Boolean))];
  const by = c.suggest.by;
  const leave = (what, suggested) => by ? cap(by) + ' decides' : suggested ? 'Suggested: ' + suggested : what;
  const agentPick = c.done || c.column === 'building'
    ? el('div', { class: 'val' }, [cap(c.model) || (by ? cap(by) + ' decides' : cap(c.suggest.model)) || 'Your agent', c.effort || (by ? '' : c.suggest.effort)].filter(Boolean).join(' · '))
    : el('div', { class: 'pick' },
        choose([['', leave('As your agent runs', cap(c.suggest.model))], ...models.map((m) => [m, cap(m)])], c.model,
          (v) => save({ model: v }, v ? 'Model: ' + cap(v) : by ? cap(by) + ' decides the model' : 'Model as its size suggests')),
        choose([['', leave('Default effort', c.suggest.effort)], ...EFFORTS.map((e) => [e, e])], c.effort,
          (v) => save({ effort: v }, v ? 'Effort: ' + v : by ? cap(by) + ' decides the effort' : 'Effort as its size suggests')));
  const movable = c.column === 'proposed' || c.column === 'build';
  const status = movable
    ? choose([['proposed', '🟠 Proposed'], ['build', '🟢 Build']], c.column, (to) => post('move', { id: c.id, to }, to === 'build' ? 'In build' : 'Back to proposed'))
    : c.column === 'building' ? el('div', { class: 'val' }, '🔵 Building' + (t.by ? ', by ' + whoIs(t.by) : '') + ' ', abortNode(c, ''))
    : el('div', { class: 'val' }, c.complete ? '✅ Done · complete' : '✅ Done · for you to check');
  const addTag = el('input', { placeholder: 'Add a tag', list: 'known-tags',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      e.preventDefault();
      save({ tags: [...c.tags, e.target.value.trim()] }, 'Tagged');
    } });
  const version = el('input', { placeholder: 'None', list: 'known-versions',
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    onchange: (e) => { if (e.target.value.trim() !== c.version) save({ version: e.target.value }, e.target.value.trim() ? 'Version set' : 'Version cleared'); } });
  version.value = c.version;

  const side = el('div', { class: 'side' },
    field('Status', status),
    field('Priority', c.done ? el('div', { class: 'val' }, c.priority) : choose(PRIORITIES.map((name, i) => [String(i), name]), String(c.p), (v) => save({ priority: Number(v) }, 'Priority: ' + PRIORITIES[Number(v)]))),
    field('Difficulty', c.done ? el('div', { class: 'val' }, c.difficulty || 'Not sized') : choose([['', 'Not sized'], ...SIZES], c.size, (v) => v && save({ size: v }, 'Difficulty changed'))),
    field('Model', agentPick),
    field('Tags',
      el('div', { class: 'chips', style: 'margin: 0 0 7px' }, c.tags.map((tag) => el('span', { class: 'chip tag' }, '#' + tag,
        el('b', { title: 'Remove', onclick: () => save({ tags: c.tags.filter((x) => x !== tag) }, 'Tag removed') }, '✕')))),
      addTag, el('datalist', { id: 'known-tags' }, b.tags.filter((x) => !c.tags.includes(x)).map((x) => el('option', { value: x })))),
    field('Version', version, el('datalist', { id: 'known-versions' }, b.versions.map((x) => el('option', { value: x })))),
    field('Sprint', choose([['', 'None'], ...b.sprints.filter((x) => x.status !== 'done' || x.id === c.sprint).map((x) => [x.id, x.name])], c.sprint,
      (v) => post('assign', { id: c.id, sprint: v }, v ? 'In the sprint' : 'Back in the backlog'))),
    c.type !== 'change' && field('Type', el('div', { class: 'val' }, c.type)),
    (c.column === 'building' || c.done) && field('Built by', el('div', { class: 'val' }, whoIs(t.by))),
    c.done && field('Check', el('div', { class: 'val' }, t.checked ? '✓ Passed: ' + t.checked : 'None was run')),
    c.suggested && field('Came from', el('div', { class: 'val' }, '✨ AI suggested')),
    field('Created', el('div', { class: 'val' }, c.created.slice(0, 10))),
    field('Updated', el('div', { class: 'val' }, c.updated.slice(0, 16).replace('T', ' '))));

  return [el('button', { class: 'x', onclick: closeThread, title: 'Close' }, '✕'), el('div', { class: 'ticket' }, story, side)];
}

// The open ticket is drawn again only when something in it changed. While an agent works, the
// board changes every second (its log, its seconds), and rebuilding the ticket for that threw the
// reader's place away: the live log jumped to its top under them. Now those parts are updated
// where they stand, and a full redraw puts every box that scrolls (or folds) back as it was.
// Which ticket is on screen, and the board it was drawn from (redraw() clears that, to draw it again).
let drawnId = null;
let drawnFrom = '';
const steady = (b) => JSON.stringify(b, (k, v) => (k === 'seconds' || k === 'lines' ? undefined : v));
function atFoot(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 8; }

function drawThread(b) {
  const pane = document.getElementById('thread');
  const veil = document.getElementById('veil');
  const c = openId && everyCard(b).find((x) => x.id === openId);
  pane.hidden = veil.hidden = !c;
  if (!c) { openId = drawnId = null; return; }
  const from = steady(b);
  const same = drawnId === openId;
  if (same && from === drawnFrom && pane.firstChild) { liveInPlace(pane, c, b); return; }
  drawnId = openId;
  drawnFrom = from;
  const at = pane.scrollTop;
  // Where each kept box was: how far down, whether at its foot, whether open.
  const kept = new Map();
  if (same) for (const node of pane.querySelectorAll('[data-keep]')) kept.set(node.dataset.keep, { top: node.scrollTop, foot: atFoot(node), open: node.open });
  pane.replaceChildren(...threadNode(c, b));
  for (const node of pane.querySelectorAll('[data-keep]')) {
    const was = kept.get(node.dataset.keep);
    if (was && node.tagName === 'DETAILS') node.open = was.open;
    // A box that follows (the live log) starts at its foot, and stays there while the human leaves it there.
    if (node.dataset.follow && (!was || was.foot)) node.scrollTop = node.scrollHeight;
    else if (was) node.scrollTop = was.top;
  }
  pane.scrollTop = same ? at : 0;
}

// What changes from second to second while an agent works, changed in place: the nodes stay, and so does the reader.
function liveInPlace(pane, c, b) {
  const run = liveOf(c, b);
  const now = pane.querySelector('.livenow .nowtext');
  if (now && run && run.lines.length) now.textContent = run.lines.at(-1);
  const log = pane.querySelector('.livelog');
  if (log && run) {
    const text = run.lines.join('\n') || 'starting…';
    if (log.textContent !== text) {
      const foot = atFoot(log);
      const top = log.scrollTop;
      log.textContent = text;
      log.scrollTop = foot ? log.scrollHeight : top;
    }
  }
}

// ---- the page

function draw(b) {
  YOU = b.you || '';
  document.getElementById('project').textContent = b.project;
  // The yarn is the tab's icon, so the title is the project's name alone.
  document.title = b.project;
  document.getElementById('where').textContent = b.version ? 'v' + b.version : '';
  // Two things are still worth a line: a project where the gate is off, because there the board
  // cannot promise that nothing builds by itself; and what the page has to say about itself, when
  // it is rebuilding Spool or could not.
  const rule = document.getElementById('rule');
  const lines = [b.gate ? '' : 'The build gate is off in this project: new threads go straight to Build.', b.notice || ''].filter(Boolean);
  rule.textContent = lines.join(' ');
  rule.hidden = !lines.length;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.view === view);

  // Quick filters: one pill a sprint, and whatever tag or version the board is narrowed to.
  const sprints = b.sprints.filter((s) => s.status !== 'done');
  document.getElementById('quick').replaceChildren(...[
    ...(view === 'board' && sprints.length ? [
      el('button', { class: 'pill' + (only ? '' : ' on'), onclick: () => { only = null; redraw(); } }, 'All'),
      ...sprints.map((s) => el('button', { class: 'pill' + (only && only.kind === 'sprint' && only.value === s.id ? ' on' : ''), onclick: () => narrow('sprint', s.id) }, s.name + ' · ' + s.done + '/' + s.total)),
    ] : []),
    only && only.kind !== 'sprint' && el('button', { class: 'pill on', onclick: () => narrow(only.kind, only.value) }, (only.kind === 'tag' ? '#' : 'v') + only.value + '  ✕'),
  ].filter(Boolean));

  // Who builds what is in Build: this page, headless, or a Claude Code chat running the loop.
  const chat = b.runner.builder === 'chat';
  const builder = document.getElementById('builder');
  builder.hidden = false;
  for (const pick of builder.children) {
    const mine = pick.dataset.builder === b.runner.builder;
    pick.className = mine ? 'on' : '';
    pick.setAttribute('aria-pressed', String(mine));
    pick.title = pick.dataset.builder === 'chat'
      ? 'A Claude Code chat builds what is in Build: one running /spool-loop in this project. This page starts no agents.'
      : 'This page builds what is in Build itself, with no chat open. It runs: ' + b.runner.agent;
    pick.onclick = () => { if (!mine) post('builder', { builder: pick.dataset.builder }, ''); };
  }
  // One button says how the agents are doing. Headless, they are the page's own, and it is their switch.
  // With a chat building, the page cannot switch a chat on: it says whether one is building or listening.
  const runner = document.getElementById('runner');
  const lately = b.runner.recent.length ? ' Last: ' + b.runner.recent[0].title + ' — ' + b.runner.recent[0].outcome : '';
  // How many threads the page's own agents are on right now.
  const running = b.runner.running.length;
  runner.hidden = false;
  if (chat) {
    const building = b.columns.building.length > 0;
    const live = building || b.runner.watching;
    runner.className = 'runner' + (live ? ' on' : '');
    runner.textContent = building ? '● Agents: building' : b.runner.watching ? '● Agents: watching' : 'Agents: off';
    runner.title = building ? 'A thread is being built.' + (running ? ' What this page had started is being built to the end.' : '')
      : b.runner.watching ? 'A Claude Code chat is watching this spool. It builds what you move to Build.'
      : 'No Claude Code chat is watching this spool, so nothing in Build is built. Say /spool-loop in one, in this project.';
    runner.onclick = () => say(live ? runner.title : 'Nobody is building. Say /spool-loop in a Claude Code chat in this project.');
  } else {
    runner.className = 'runner' + (b.runner.on ? ' on' : '');
    runner.textContent = b.runner.on ? (running ? '● Agents: building' + (running > 1 ? ' ' + running : '') : '● Agents: on') : 'Agents: off';
    runner.title = (b.runner.on ? 'This page is building what is in Build. Click to switch it off.' : 'Click to have this page build what is in Build, with no chat open.')
      + ' It runs: ' + b.runner.agent + (b.runner.parallel > 1 ? ', on up to ' + b.runner.parallel + ' threads at once' : '') + '.' + lately;
    runner.onclick = () => post('runner', { on: !b.runner.on }, '');
  }
  document.getElementById('board').hidden = view !== 'board';
  document.getElementById('backlog').hidden = view !== 'backlog';
  drawBrief(b);
  if (view === 'board') drawBoard(b); else drawBacklog(b);
  const box = document.querySelector('.adding textarea, .adding input');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  drawThread(b);
}

// Draw again from what is already here: a view, a filter or a box changed, and nothing on disk did.
function redraw() { drawnFrom = ''; if (current) draw(current); }

// The server is now another build of Spool than the one this page came from: load the page again,
// so what is on screen is what was built. Once for each build, so a page that cannot get onto it
// does not spin. True if the page is going.
function renew(build) {
  try {
    if (sessionStorage.getItem('spool-renewed') === build) return false;
    sessionStorage.setItem('spool-renewed', build);
    sessionStorage.setItem('spool-drafts', JSON.stringify([...drafts]));
  } catch (e) {}
  location.reload();
  return true;
}

// How many looks in a row found no server. A page restarting onto a new build is away for a moment.
let misses = 0;
async function load(now) {
  // Never redraw under someone's typing or choosing; a redraw that was asked for goes ahead.
  const at = document.activeElement;
  if (!now && (busy || (at && at.id !== 'search' && (['TEXTAREA', 'INPUT', 'SELECT'].includes(at.tagName) || at.isContentEditable)))) return;
  try {
    const text = await (await fetch('/api/board')).text();
    misses = 0;
    if (text === last) return;
    const b = JSON.parse(text);
    if (b.build && b.build !== BUILD && renew(b.build)) return;
    last = text;
    current = b;
    draw(current);
  } catch (e) {
    if (++misses >= 3) say('The page lost its server. Run spool page again.');
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view;
    try { localStorage.setItem('spool-view', view); } catch (e) {}
    adding = null;
    redraw();
  });
}
document.getElementById('search').addEventListener('input', (e) => { query = e.target.value.trim(); redraw(); });
if (/^#t-[a-z0-9]+$/.test(location.hash)) openId = location.hash.slice(1);
document.getElementById('veil').addEventListener('click', closeThread);
document.addEventListener('keydown', (e) => {
  const at = document.activeElement;
  const typing = at && (['TEXTAREA', 'INPUT', 'SELECT'].includes(at.tagName) || at.isContentEditable);
  if (e.key === 'Escape' && at && at.id === 'search') { at.value = ''; query = ''; at.blur(); redraw(); return; }
  if (e.key === 'Escape' && openId && !adding && !(at && at.isContentEditable)) closeThread();
  if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('search').focus(); }
});
load();
setInterval(load, 1500);
// The clock: how long an agent has been at it, and how long ago things were said, kept current in place.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = took(node.dataset.since);
  for (const node of document.querySelectorAll('[data-at]')) node.textContent = ago(node.dataset.at);
}, 1000);
</script>
</body>
</html>
`;
