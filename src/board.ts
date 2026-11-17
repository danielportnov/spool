/**
 * The board: a project's spool as the data a face of Spool draws.
 *
 * `board()` reads the whole of it fresh from disk: every open thread as a card in its column
 * (backlog, build, building, done), in the order and with the numbers the loop's list gives
 * them; each card's thread as a conversation; what waits on the human; the sprints; the morning
 * brief; and, where a runner is building, what each of its agents is saying. `diffOf` is what a
 * finished thread changed, for its ticket. It is plain data, sent as JSON: the page draws it,
 * and anything else that shows the spool can draw the same.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pickFor } from './agent.ts';
import { type Brief, morning, waitingOnYou } from './brief.ts';
import type { Builder } from './context.ts';
import { type Live as Running, type Picking, type Runner, stoppedInBuild } from './engine.ts';
import { git, repoRoot } from './git.ts';
import { type Goals, goalsOf } from './goals.ts';
import { type Item, isPlan, isRun, oneLine, reportFile, splitBody, whyOf } from './model.ts';
import { attachLine, picturesOf } from './pictures.ts';
import type { Typing } from './quick.ts';
import { proposalLine, readProposals, unanswered } from './proposals.ts';
import { age, sprintAbout, tableRows } from './render.ts';
import { type Run as StartedWith, runOf } from './run.ts';
import { type Review, blockers, children, dependents, docket, review, sprintOf, sprintTasks, taskState, tasks } from './schedule.ts';
import { sprintDates } from './sprints.ts';
import type { Workspace } from './store.ts';
import type { Upkeep } from './upkeep.ts';
import { DEFAULT_ON, type Notices } from './notices.ts';
import type { Usage } from './usage.ts';
import { watched } from './watch.ts';

export type Column = 'proposed' | 'build' | 'building' | 'done';

export interface Card {
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
  /** The model and effort the human chose for it, if they did. */
  model: string;
  effort: string;
  /**
   * What it is built with where the human does not choose, and why: "by its size", or
   * "stepped up from haiku: its last run was undone".
   */
  suggest: { model: string; effort: string; why: string };
  p: number;
  tags: string[];
  version: string;
  /** The sprint it is in, by id, or none. */
  sprint: string;
  column: Column;
  created: string;
  updated: string;
  /** When it was put out of sight, if it was. */
  archived: string;
  /** Shipped, and whether the human has marked it complete. */
  done: boolean;
  complete: boolean;
  /** Finished: the steps a person follows to see it working, as the agent wrote them. */
  steps: string[];
  thread: Thread;
  question: { id: string; title: string; options: string[]; recommend: number | null } | null;
  /** A manager's run: what it proposes, numbered, each waiting for the human's yes or no on its thread. */
  proposals: { n: number; verb: string; id: string; text: string; answer: 'yes' | 'no' | null }[];
  /** While it is being built: when the agent took it, and the latest thing it said it was doing. */
  live: Live | null;
  /** The folder it is built in, from the project's, where it has a git worktree of its own; empty where it is the project's own folder. */
  worktree: string;
  /** What its agent was started with, where the page started one: the model, the effort, and its session. */
  run: StartedWith | null;
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
  /** The pictures and files kept with it, oldest first, each by the name the page asks `/api/picture` for. */
  pictures: { name: string; as: string | null; kind: 'picture' | 'file'; by: string; at: string; caption: string }[];
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

function needsOf(ws: Workspace, queue: Review): Needs {
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
   * decided: an agent made a call itself · event: bookkeeping · picture: pictures attached, with
   * their caption as the text.
   */
  kind: 'said' | 'post' | 'shipped' | 'asked' | 'decided' | 'event' | 'picture';
  text: string;
  /** The pictures shown under the words, by name. */
  pictures?: string[];
  /** The decision a post is about: the question asked, or the call made. */
  ref?: string;
}

/** The queue's own log lines: what moved where. Anything else an agent logged is something it had to say. */
const BOOKKEEPING = /^(started|builder model: |built on |check passed|moved to build|moved back to proposed|edited: |put on hold|released from hold|approved|picked up after|handed to |agent |session |transcript |reverted|put the work back|reopened|dropped|agreed|filed |placed )/;

function feedOf(ws: Workspace, task: Item, said: Thread['said'], steps: Thread['steps']): Post[] {
  const opening: Post[] = task.suggested ? [{ at: task.created.slice(0, 16).replace('T', ' ') + 'Z', who: task.suggestedBy ?? 'agent', kind: 'post', text: task.suggested }] : [];
  const words: Post[] = said.map((s) => {
    const note = ws.find(s.note);
    const who = note?.by ?? 'human';
    return {
      at: (note?.created ?? task.created).slice(0, 16).replace('T', ' ') + 'Z',
      who,
      kind: who === 'human' ? 'said' : 'post',
      text: s.text,
    };
  });
  const rest: Post[] = steps.map((s) => {
    const attached = attachLine(s.what);
    if (attached) return { at: s.at, who: s.who, kind: 'picture', text: attached.caption, pictures: attached.names };
    if (s.what.startsWith('done: ')) return { at: s.at, who: s.who, kind: 'shipped', text: s.what.slice(6) };
    const asked = /^waiting on d-[a-z0-9]+: (.*)$/.exec(s.what);
    if (asked) return { at: s.at, who: s.who, kind: 'asked', text: asked[1]! };
    const decided = /^assumed (d-[a-z0-9]+): (.*)$/.exec(s.what);
    if (decided) return { at: s.at, who: s.who, kind: 'decided', text: decided[2]!, ref: decided[1]! };
    return { at: s.at, who: s.who, kind: BOOKKEEPING.test(s.what) || s.who === 'human' ? 'event' : 'post', text: s.what };
  });
  // Stable: things said in the same minute keep the order they were written in, words first.
  const story = [...words, ...rest].map((p, i) => ({ p, i })).sort((a, b) => a.p.at.localeCompare(b.p.at) || a.i - b.i).map((x) => x.p);
  story.unshift(...opening);
  // Once it is finished, its before and after are shown together under the result, and not again where they were attached.
  if (story.some((p) => p.kind === 'shipped')) {
    for (const p of story) if (p.pictures) p.pictures = p.pictures.filter((name) => !/-(before|after)\./.test(name));
    return withPictures(story.filter((p) => p.kind !== 'picture' || p.pictures?.length));
  }
  return withPictures(story);
}

/**
 * Pictures sent with words, with no caption of their own, belong under those words: a reply and
 * what was pasted into it are one post. Bookkeeping in between does not part them.
 */
function withPictures(story: Post[]): Post[] {
  const out: Post[] = [];
  let words: Post | undefined;
  for (const p of story) {
    if (p.kind === 'picture' && !p.text && words && words.who === p.who) {
      words.pictures = [...(words.pictures ?? []), ...(p.pictures ?? [])];
      continue;
    }
    out.push(p);
    if (p.kind === 'said' || p.kind === 'post') words = p;
    else if (p.kind !== 'event') words = undefined;
  }
  return out;
}

export interface Board {
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
  /** How many things wait on the human in this project, as the brief and the list of projects count them: the tab shows it. */
  waitsOnYou: number;
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
    running: Running[];
    /** Threads the human stopped while they were being built: the runner leaves them in Build until they carry on. */
    stopped: string[];
    recent: { id: string; title: string; outcome: string }[];
    /** The threads showing "Typing…": a quick reply being written (quick.ts), or an agent the human just spoke to. `who` is empty for the thread's own agent. */
    typing: Typing[];
  };
  /**
   * The human's usage target, and the plan's usage the chat that builds last read: the page shows it
   * in the header in Chat mode, where the chat works up to it. Empty where the page did not say.
   */
  usage: Usage;
  /** What tells the human (notices.ts): the page shows it in its own box, and changes it there. */
  notices: Notices;
  /**
   * The sprints, oldest first: what is in each and how far along it is. `serves` is the goal it is
   * for, `vision` his words for it, `version` the one it became; `started` and `reached` are when
   * play was pressed on it and when its last thread was done, empty until then.
   */
  sprints: {
    id: string;
    name: string;
    status: string;
    goal: string;
    why: string;
    doneWhen: string;
    serves: string;
    vision: string;
    version: string;
    started: string;
    reached: string;
    total: number;
    done: number;
    waiting: number;
  }[];
  /** Where the project is going, from its goals page: null where none are set. */
  goals: Goals | null;
  columns: Record<Column, Card[]>;
  /** Threads put out of sight, newest first: on no column, shown only in the Backlog view's Archived section. */
  archived: Card[];
  also: { assumptions: number; skills: number; inbox: number };
  /** The morning brief, as `spool brief --json` gives it: the terminal board opens on it, and the page marks the Done cards worth a look. Null with nothing shipped and nothing needing him. */
  brief: Brief | null;
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;
/** Finished work is kept for good. The page carries what is still to check, and the most recent of the rest as history. */
const HISTORY_SHOWN = 60;

/** Which column a thread sits in. On hold is the human saying not yet, so it sits with what is not in build. */
export function columnOf(state: string): Column | null {
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
  [/^(why|benefit|benefits|so that)$/i, 'why', 'How it helps'],
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
    pictures: picturesOf(task).map(({ name, as, kind, by, at, caption }) => ({ name, as, kind, by, at, caption })),
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
  // What it gets left to itself: the human's pick is set aside, so the boxes can say what leaving them gives.
  const suggest = pickFor({ ...task, model: undefined, effort: undefined }, routing?.models);
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
    suggest: { model: suggest.model ?? '', effort: suggest.effort ?? '', why: suggest.why },
    p: task.priority ?? 2,
    tags: task.tags,
    version: task.version ?? '',
    sprint: sprintOf(ws, task)?.id ?? '',
    column,
    created: task.created,
    updated: task.updated,
    archived: task.archived ?? '',
    done: task.status === 'done',
    complete: task.status === 'done' && !!task.reviewed,
    steps: task.status === 'done' ? task.steps : [],
    thread,
    question: asked ? { id: asked.id, title: asked.title, options: asked.options, recommend: asked.recommend ?? null } : null,
    proposals: isRun(task) ? readProposals(task).map((x) => ({ n: x.n, verb: x.verb, id: x.id, text: proposalLine(x), answer: x.answer?.said ?? null })) : [],
    live: column === 'building' ? liveNow(task) : null,
    worktree: task.worktree ?? '',
    run: column === 'building' || column === 'done' ? runOf(log) : null,
    waiting: isRun(task) && unanswered(readProposals(task)).length
      ? { kind: 'you', text: `${unanswered(readProposals(task)).length} to answer`, on: [], said: '', refused: [] }
      : task.status === 'done' || task.status === 'dropped' ? null : waitingOf(ws, task, thread.steps, asked),
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

/**
 * The whole board for one project, read fresh from disk. `builder` is who builds this project,
 * where the page knows it better than the runner does: a page showing several projects keeps
 * the human's pick for each one, by its folder. `atOnce` is how many of this project's threads the
 * runner builds at once (slots.ts `atOnceIn`), as the page works it out from the user's settings, and
 * `usage` the human's usage target and the last reading (usage.ts), read from them too, and
 * `notices` what tells the human (notices.ts).
 */
export function board(ws: Workspace, project?: string, runner?: Runner, upkeep?: Upkeep, builder?: Builder, atOnce?: number, usage?: Usage, notices?: Notices): Board {
  const spool = project ? ws.project(project) : ws.home;
  const builds = builder ?? runner?.builder ?? 'headless';
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
  const ours = new Set(all.map((t) => t.id));
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
    needs: needsOf(ws, queue),
    waitsOnYou: waitingOnYou(ws, spool),
    runner: {
      builder: builds,
      // Looked for only where it is shown: with a chat building.
      watching: builds === 'chat' && watched(spool.root),
      on: !!runner?.on,
      agent: runner?.agent ?? '',
      parallel: atOnce ?? runner?.parallel ?? 1,
      // Only this project's: a page started over several projects builds all of them.
      running: (runner?.live() ?? []).filter((run) => ours.has(run.id)),
      // One carried on with that waits for room is no longer stopped. With a chat building, nothing holds a
      // stopped thread back: the chat takes whatever is in Build.
      stopped: builds === 'chat' ? [] : all.filter((t) => stoppedInBuild(t) && !runner?.isNext(t.id)).map((t) => t.id),
      recent: (runner?.recent ?? []).filter((r) => ours.has(r.id)),
      typing: (runner?.typing() ?? []).filter((t) => ours.has(t.id)),
    },
    usage: usage ?? { target: {}, read: null, reached: [] },
    notices: notices ?? { on: [...DEFAULT_ON], default: true, notifier: '' },
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
          ...sprintDates(s),
          total: inIt.length,
          done: inIt.filter((t) => t.status === 'done').length,
          // What pressing play would move: in the sprint, and not yet in build.
          waiting: inIt.filter((t) => t.status === 'proposed' || !!t.hold).length,
        };
      }),
    goals: goalsOf(spool) ?? null,
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
  // A question alone brings up no brief: the page asks it on its thread, and nowhere else.
  const needs = b.needsYou.plans.length + b.needsYou.stopped.length;
  const brief = b.shipped || needs ? b : null;
  briefs.set(spool.root, { key, brief });
  return brief;
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
