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
 * human: `build`, `propose`, `capture`, `task`, `file`, `edit`, `answer`, `approve`,
 * `sprint`, `play`, `drop`, `revert`. So the page can do
 * nothing the command line cannot, and every rule the commands enforce holds
 * here too.
 *
 * The server listens on 127.0.0.1 only. Changing anything needs the token it
 * hands to its own page, and a Host header that names this machine, so another
 * website open in the same browser cannot press play on your behalf.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './cli.ts';
import type { Bare, Result } from './commands.ts';
import { type Ctx, userConfig } from './context.ts';
import { DEFAULT_AGENT, PREAMBLE } from './loop.ts';
import { git, repoRoot } from './git.ts';
import { type Item, SpoolError, addLog, oneLine, reportFile, splitBody, timestamp } from './model.ts';
import { prime } from './prime.ts';
import { age, brief, paint, sprintAbout, tableRows } from './render.ts';
import { blockers, children, dependents, docket, ready, review, sprintOf, sprintTasks, taskState, tasks } from './schedule.ts';
import { Workspace } from './store.ts';

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
  suggested: string;
  /** The fields a ticket shows and the human can change. */
  size: string;
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
  thread: Thread;
  question: { id: string; title: string; options: string[]; recommend: number | null } | null;
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
  questions: { id: string; title: string; status: string; choice: string }[];
}

/** One part of a thread's description: what changes, how it helps, when it is done, or anything else written. */
interface About {
  key: 'what' | 'why' | 'done' | 'other';
  label: string;
  text: string;
}

/** What waits on the human besides threads: the decisions the page exists to put in front of them. */
interface Needs {
  questions: { id: string; title: string; options: string[]; recommend: number | null; why: string; holds: string[] }[];
  plans: { id: string; title: string; summary: string; parts: string[] }[];
  calls: { id: string; title: string; choice: string; why: string; by: string; holds: string[] }[];
  skills: { id: string; name: string; about: string }[];
  notes: { id: string; text: string }[];
}

function needsOf(ws: Workspace, spool: Item['spool']): Needs {
  const queue = review(ws, spool);
  // The first line of a decision is the reason given for it, unless it is only the pointer to its thread.
  const why = (d: Item): string => {
    const line = splitBody(d.body).main.split('\n')[0] ?? '';
    return line.startsWith('For [[') ? '' : oneLine(line, 240);
  };
  const holds = (d: Item): string[] => dependents(ws, d).map((t) => oneLine(t.title, 70));
  return {
    questions: queue.questions.map((d) => ({ id: d.id, title: d.title, options: d.options, recommend: d.recommend ?? null, why: why(d), holds: holds(d) })),
    plans: queue.plans.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary ?? '',
      parts: children(ws, t).filter((k) => k.status !== 'dropped').map((k) => oneLine(k.title, 90)),
    })),
    calls: queue.assumptions.map((d) => ({ id: d.id, title: d.title, choice: d.choice ?? '', why: why(d), by: d.by ?? '', holds: holds(d) })),
    skills: queue.skills.map((k) => ({ id: k.id, name: k.title, about: oneLine(splitBody(k.body).main, 200) })),
    notes: queue.inbox.map((n) => ({ id: n.id, text: splitBody(n.body).main })),
  };
}

interface Post {
  at: string;
  who: string;
  /** said: the human's words · post: an agent's note · shipped: it finished · asked: it needs a call · event: bookkeeping. */
  kind: 'said' | 'post' | 'shipped' | 'asked' | 'event';
  text: string;
}

/** The queue's own log lines: what moved where. Anything else an agent logged is something it had to say. */
const BOOKKEEPING = /^(started|check passed|moved to build|moved back to proposed|edited: |put on hold|released from hold|approved|picked up after|handed to |agent |reverted|reopened|dropped|agreed|filed )/;

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
    return { at: s.at, who: s.who, kind: BOOKKEEPING.test(s.what) || s.who === 'human' ? 'event' : 'post', text: s.what };
  });
  // Stable: things said in the same minute keep the order they were written in, words first.
  return [...words, ...rest].map((p, i) => ({ p, i })).sort((a, b) => a.p.at.localeCompare(b.p.at) || a.i - b.i).map((x) => x.p);
}

interface Board {
  project: string;
  version: string;
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
  /** The page's own runner: whether it is building, with what command, and what the agent is saying. */
  runner: { on: boolean; agent: string; current: { id: string; seconds: number; lines: string[] } | null; recent: { id: string; title: string; outcome: string }[] };
  /** The sprints, oldest first: what is in each and how far along it is. */
  sprints: { id: string; name: string; status: string; goal: string; why: string; doneWhen: string; total: number; done: number; waiting: number }[];
  columns: Record<Column, Card[]>;
  also: { assumptions: number; skills: number; inbox: number };
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;
/** Finished work is kept for good. The page carries what is still to check, and the most recent of the rest as history. */
const HISTORY_SHOWN = 60;

/** Which column a thread sits in. On hold is the human saying not yet, so it sits with what is not in build. */
function columnOf(state: string): Column | null {
  if (state === 'proposed' || state === 'held') return 'proposed';
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
    questions: asked.map((d) => ({ id: d.id, title: d.title, status: d.status, choice: d.choice ?? '' })),
  };
}

function card(ws: Workspace, task: Item, n: number | null, note: string, column: Column): Card {
  const { main, log } = splitBody(task.body);
  const asked = blockers(ws, task).find((b) => b.kind === 'decision' && b.status === 'open');
  return {
    id: task.id,
    n,
    title: task.title,
    difficulty: task.size ? DIFFICULTY[task.size] : '',
    priority: URGENCY[task.priority ?? 2] ?? 'Normal',
    urgent: (task.priority ?? 2) <= 1,
    type: task.type ?? 'change',
    note,
    suggested: task.suggested ?? '',
    size: task.size ?? '',
    p: task.priority ?? 2,
    tags: task.tags,
    version: task.version ?? '',
    sprint: sprintOf(ws, task)?.id ?? '',
    column,
    created: task.created,
    updated: task.updated,
    done: task.status === 'done',
    complete: task.status === 'done' && !!task.reviewed,
    thread: threadOf(ws, task, main, log),
    question: asked ? { id: asked.id, title: asked.title, options: asked.options, recommend: asked.recommend ?? null } : null,
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
  if (row.item.suggested) return `Why: ${row.item.suggested}`;
  if (row.mark === '🟠' || (row.mark === '🔴' && row.note.startsWith('Needs you: ') && !row.note.includes('go-ahead'))) return '';
  return `${row.mark} ${row.note}`.replace(/\*\*/g, '').trim();
}

/** The whole board for one project, read fresh from disk. */
export function board(ws: Workspace, project?: string, runner?: Runner): Board {
  const spool = project ? ws.project(project) : ws.home;
  const d = docket(ws, spool);
  const columns: Record<Column, Card[]> = { proposed: [], build: [], building: [], done: [] };
  // The open threads, in the order and with the numbers the loop's list gives them.
  for (const row of tableRows(ws, d)) {
    const column = columnOf(taskState(ws, row.item));
    if (column) columns[column].push(card(ws, row.item, row.n, cardNote(row), column));
  }
  const done = tasks(ws, spool)
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  // What the human has not looked at yet comes first, all of it; what they marked complete is history.
  const shown = [...done.filter((t) => !t.reviewed), ...done.filter((t) => t.reviewed).slice(0, HISTORY_SHOWN)];
  for (const t of shown) {
    columns.done.push(card(ws, t, null, `${age(t.updated, ws.now())} ago${t.summary ? ` · ${oneLine(t.summary, 160)}` : ''}`, 'done'));
  }
  const queue = review(ws, spool);
  const all = tasks(ws, spool);
  return {
    project: spool.name,
    version: projectVersion(spool.root),
    gate: !!spool.config.gate,
    locked: spool.config.gate === 'locked',
    tags: [...new Set(all.flatMap((t) => t.tags))].sort(),
    versions: [...new Set(all.map((t) => t.version ?? '').filter(Boolean))].sort().reverse(),
    history: done.filter((t) => t.reviewed).length,
    needs: needsOf(ws, spool),
    runner: {
      on: !!runner?.on,
      agent: runner?.agent ?? '',
      current: runner?.current ? { id: runner.current.id, seconds: Math.round((Date.now() - runner.current.began) / 1000), lines: runner.current.lines } : null,
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
    also: { assumptions: queue.assumptions.length, skills: queue.skills.length, inbox: queue.inbox.length },
  };
}

// ------------------------------------------------------------------ the page runs the agents

const LIVE_LINES = 60;

/**
 * The runner: with it on, the page builds what is in Build by itself. It takes
 * the next thread, starts the user's agent command on it with the rules and
 * the brief on stdin, shows what the agent prints as it works, and takes the
 * next when it exits. One thread at a time, in the project's own folder.
 *
 * It is the same contract as `spool loop`: a thread the agent finished is
 * done, one it asked a question on waits for the human, and one it walked
 * away from is put back and not tried again until something about it changes.
 * The agent command comes from the user's machine, never from the project.
 */
export class Runner {
  on: boolean;
  readonly agent: string;
  current: { id: string; title: string; child: ChildProcess; lines: string[]; began: number; stopped: boolean } | null = null;
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
    this.timer = setInterval(() => this.tick(), 1000);
  }

  close(): void {
    clearInterval(this.timer);
    this.stop();
  }

  /** Stop the agent that is working. Its thread goes back to Build, and the runner is switched off so it is not picked straight up again. */
  stop(): void {
    if (!this.current) return;
    this.on = false;
    this.current.stopped = true;
    this.end(this.current.child);
  }

  /** End the agent and whatever it started: it runs in a group of its own, so the whole group is told. */
  private end(child: ChildProcess): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  private tick(): void {
    if (!this.on || this.current) return;
    let task: Item | undefined;
    let prompt = '';
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        task = ready(ws, this.project).find((t) => this.gaveUp.get(t.id) !== t.updated);
        if (!task) return;
        task.status = 'active';
        task.by = this.name();
        task.started = timestamp(ws.now());
        addLog(task, 'page', `handed to \`${this.agent}\``, ws.now());
        ws.save(task);
        prompt = `${PREAMBLE}\n${prime(ws, 'worker')}\n\nYOUR TASK\n\n${brief(ws, task, paint(false))}\n`;
      } finally {
        ws.close();
      }
    } catch {
      return; // The store was busy for an instant; the next tick looks again.
    }
    this.start(task, prompt);
  }

  /** What the agent is called on the thread: the program it is, so "claude" shows as Claude. */
  private name(): string {
    return this.ctx.env.SPOOL_ACTOR ?? path.basename(this.agent.trim().split(/\s+/)[0] ?? 'agent');
  }

  private start(task: Item, prompt: string): void {
    const file = path.join(os.tmpdir(), `spool-${task.id}-${process.pid}.md`);
    fs.writeFileSync(file, prompt);
    const child = spawn(this.agent.replaceAll('{prompt_file}', file), {
      shell: true,
      cwd: task.spool.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
      env: { ...this.ctx.env, SPOOL_ACTOR: this.name(), SPOOL_TASK: task.id, SPOOL_PROMPT_FILE: file },
    });
    const run = { id: task.id, title: task.title, child, lines: [] as string[], began: Date.now(), stopped: false };
    this.current = run;
    const hear = (chunk: Buffer): void => {
      // What the agent prints, without the terminal's colour codes, a line at a time.
      for (const line of chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
        if (line.trim()) run.lines.push(line.trimEnd().slice(0, 400));
      }
      if (run.lines.length > LIVE_LINES) run.lines.splice(0, run.lines.length - LIVE_LINES);
    };
    child.stdout!.on('data', hear);
    child.stderr!.on('data', hear);
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
    let over = false;
    const end = (how: string): void => {
      if (over) return;
      over = true;
      fs.rmSync(file, { force: true });
      this.settle(run, how);
    };
    child.on('error', (error) => end(`could not start (${error.message})`));
    child.on('exit', (code, signal) => end(`exited ${code ?? signal}`));
  }

  private settle(run: NonNullable<Runner['current']>, how: string): void {
    let outcome = 'gone';
    try {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now, true);
      try {
        const now = ws.find(run.id);
        if (now?.status === 'done') outcome = 'done';
        else if (now?.status === 'active') {
          // The agent left without finishing or asking. Put the thread back, and do not spin on it.
          now.status = 'open';
          now.by = undefined;
          addLog(now, 'page', run.stopped ? 'stopped from the page; back in build' : `agent ${how} without finishing; back in build`, ws.now());
          ws.save(now);
          this.gaveUp.set(now.id, now.updated);
          outcome = run.stopped ? 'stopped' : `unfinished: the agent ${how}${run.lines.length ? ` — ${run.lines.at(-1)}` : ''}`;
        } else if (now) outcome = `waiting${now.needs.length ? ' on you' : ''}`;
      } finally {
        ws.close();
      }
    } catch {
      outcome = 'unknown: the spool could not be read';
    }
    this.recent.unshift({ id: run.id, title: run.title, outcome });
    this.recent.splice(5);
    if (this.current === run) this.current = null;
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
  if (action === 'move') {
    const to = text(body.to);
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    if (to === 'build') return act(ctx, ['build', id]);
    if (to === 'proposed') return act(ctx, ['propose', id]);
    return { ok: false, text: 'a thread can be moved to build, or back to proposed' };
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

/** Start the page's server. Returns once it is listening. */
export function startPage(
  ctx: Ctx,
  options: { port?: number; project?: string; run?: boolean; agent?: string },
  ready: (started: Started) => void,
): http.Server {
  const token = randomBytes(18).toString('base64url');
  const runner = new Runner(ctx, options.project, options.agent, !!options.run);
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    // Only a browser pointed at this machine: a name another site resolved here is refused.
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'not this machine');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html', PAGE.replace('__TOKEN__', token));
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(board(ws, options.project, runner)));
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
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: runner.on ? 'Agents are on: this page builds what is in Build.' : 'Agents are off.' }));
          }
          if (action === 'stop') {
            runner.stop();
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: 'Stopped. The thread is back in Build, and agents are off.' }));
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
  const listen = (port: number, triesLeft: number): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The usual port is taken, by another project's page perhaps: take the next one.
      if (error.code === 'EADDRINUSE' && triesLeft > 0 && !options.port) listen(port + 1, triesLeft - 1);
      else ctx.err(`spool: the page could not start: ${error.message}`);
    });
    server.listen(port, '127.0.0.1', () => ready({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }));
  };
  listen(options.port ?? 4747, 20);
  server.on('close', () => runner.close());
  return server;
}

/** `spool page`: start the server, say where it is, and open it. The process stays up until it is stopped. */
export function servePage({ ctx, opts }: Bare): Result {
  const port = opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SpoolError('--port must be a port number');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool or no such project.
  const ws = Workspace.open(ctx.cwd, ctx.now);
  try {
    board(ws, project);
  } finally {
    ws.close();
  }
  const run = !!opts.run;
  const agent = typeof opts.agent === 'string' ? opts.agent : undefined;
  const server = startPage(ctx, { port, project, run, agent }, ({ url }) => {
    ctx.out(`Spool page: ${url}`);
    if (run) ctx.out('Agents are on: this page builds what is in Build, with no chat open.');
    ctx.out('Leave this running while you use the page. Ctrl-C stops it.');
    if (!opts['no-open']) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  // Ctrl-C ends the page and the agent it started with it.
  process.once('SIGINT', () => { server.close(); process.exit(0); });
  process.once('SIGTERM', () => { server.close(); process.exit(0); });
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
  .live { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .livelog { max-height: 260px; overflow: auto; background: var(--bg); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
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

  /* what needs you: the decisions that are not threads */
  .badge0 { display: inline-block; margin-left: 6px; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--hot); color: #fff; font-size: 11px; font-weight: 700; text-align: center; }
  #needs { padding: 12px 20px 32px; max-width: 900px; }
  #needs h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); margin: 18px 4px 8px; display: flex; gap: 10px; align-items: center; }
  #needs h2 button { font-size: 12px; padding: 2px 9px; text-transform: none; letter-spacing: 0; }
  .need { background: var(--panel); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; box-shadow: var(--shadow); }
  .need .what { font-weight: 600; overflow-wrap: anywhere; }
  .need .more { color: var(--soft); font-size: 13px; margin-top: 4px; overflow-wrap: anywhere; }
  .need .chose { margin-top: 6px; }
  .need .acts { flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .need .acts input { flex: 1 1 220px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); }
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
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .feed { margin-top: 18px; }
  .post { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 18px; }
  .post::before { content: ''; position: absolute; left: 19px; top: 44px; bottom: 2px; width: 2px; background: var(--line); }
  .post:last-child::before { display: none; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; color: #fff; background: var(--soft); flex: none; }
  .avatar.you { background: var(--ink); color: var(--bg); }
  .avatar.claude { background: #fbf3ea; border: 1px solid #ecd9c6; }
  .avatar svg { width: 26px; height: 26px; }
  .avatar.who22 { width: 22px; height: 22px; font-size: 11px; }
  .avatar.who22 svg { width: 15px; height: 15px; }
  .byline { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .byline b { font-weight: 650; }
  .byline .model { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .byline .at { color: var(--soft); font-size: 13px; }
  .post pre { margin: 3px 0 0; }
  .post .badge { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--go); }
  .post .badge.ask { color: var(--warn); }
  .event { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 14px; font-size: 13px; color: var(--soft); }
  .event::before { content: ''; position: absolute; left: 19px; top: 0; bottom: 0; width: 2px; background: var(--line); }
  .event .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--line); margin: 4px auto 0; position: relative; }
  .compose { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; margin-top: 6px; }
  .compose .acts { margin-top: 8px; justify-content: flex-end; }
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
  .changes .file { display: flex; gap: 10px; font-size: 13px; padding: 2px 0; }
  .changes .file span:first-child { flex: 1; overflow-wrap: anywhere; }
  .plus { color: var(--go); } .minus { color: var(--hot); }
  .diff { margin-top: 10px; max-height: 420px; overflow: auto; background: var(--bg); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre; }
  .diff .at { color: var(--blue); } .diff .head { color: var(--soft); font-weight: 600; }
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
    <button class="tab" data-view="needs">Needs you<span class="badge0" id="needcount" hidden></span></button>
  </div>
  <input class="search" id="search" placeholder="Search threads   /" autocomplete="off">
  <button class="runner" id="runner" hidden></button>
</div>
<div class="rule" id="rule" hidden></div>
<div id="quick"></div>
<main id="board"></main>
<main id="backlog" hidden></main>
<main id="needs" hidden></main>
<div id="veil" hidden></div>
<aside id="thread" hidden></aside>
<div id="said"></div>
<script>
const TOKEN = '__TOKEN__';
const COLUMNS = [
  ['proposed', 'Backlog', 'Nothing here is built. Drag a thread to Build, or press ▶.'],
  ['build', 'Build', 'Agents take these in order, top first.'],
  ['building', 'Building', 'An agent has it now.'],
  ['done', 'Done', 'For you to check.'],
];
const DOT = { proposed: '🟠', build: '🟢', building: '🔵', done: '✅' };
const STATE = { proposed: 'Backlog', build: 'Build', building: 'Building', done: 'Done' };
const SIZES = [['xs', 'Tiny'], ['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Huge']];
const PRIORITIES = ['Urgent', 'High', 'Normal', 'Someday'];
const ARROWS = ['↑↑', '↑', '=', '↓'];

let last = '';
let current = null;
let busy = false;
// Which view is up: the board, or the backlog with its sprints.
let view = 'board';
try { view = ['backlog', 'needs'].includes(localStorage.getItem('spool-view')) ? localStorage.getItem('spool-view') : 'board'; } catch (e) {}
// A link can name the view: /?view=backlog
const asked = /[?&]view=(board|backlog|needs)\b/.exec(location.search);
if (asked) view = asked[1];
// The thread that is open, if one is, and notes begun but not yet added.
let openId = null;
const drafts = new Map();
// Completed threads are history: kept, and out of the way until asked for.
let showHistory = false;
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
    c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : 'For you to check'),
    c.type !== 'change' && el('span', { class: 'chip' }, c.type),
    c.suggested && el('span', { class: 'chip ai', title: c.suggested }, '✨ AI suggested'),
    c.sprint && el('span', { class: 'chip tag sprint', title: 'Show only this sprint', onclick: () => narrow('sprint', c.sprint) }, sprintName(b, c.sprint)),
    c.version && el('span', { class: 'chip tag', title: 'Show only this version', onclick: () => narrow('version', c.version) }, 'v' + c.version),
    c.tags.map((t) => el('span', { class: 'chip tag', title: 'Show only this tag', onclick: () => narrow('tag', t) }, '#' + t)),
  ];
}

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
// The thread the page's own runner is building right now, if it is this one.
const liveOf = (c, b) => (b.runner.current && b.runner.current.id === c.id ? b.runner.current : null);
function moves(c, b) {
  return [
    b && liveOf(c, b) && el('button', { class: 'act', title: 'Stop the agent. The thread goes back to Build.', onclick: () => post('stop', {}, 'Stopped') }, '■ Stop'),
    c.column === 'proposed' && el('button', { class: 'act go', title: 'Move to Build', onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title) }, '▶ Build'),
    c.column === 'build' && el('button', { class: 'act', title: 'Back to the backlog', onclick: () => post('move', { id: c.id, to: 'proposed' }, 'Back in the backlog') }, 'Not yet'),
    c.done && !c.complete && el('button', { class: 'tick', title: 'Mark as complete', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓'),
  ];
}
function dragOf(node, c, from) {
  node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.id + ' ' + from); node.classList.add('dragging'); busy = true; });
  node.addEventListener('dragend', () => { node.classList.remove('dragging'); busy = false; });
}

function cardNode(c, b) {
  const movable = c.column === 'proposed' || c.column === 'build';
  const node = el('div', { class: 'card' + (c.complete ? ' past' : ''), draggable: movable && 'true', 'data-id': c.id },
    el('div', { class: 'title', onclick: () => openThread(c.id) }, c.title),
    el('div', { class: 'chips' }, chipsOf(c, b)),
    c.note && !c.done && el('div', { class: 'note' }, c.note),
    liveOf(c, b) && el('div', { class: 'live', title: 'What the agent is doing now' }, '▸ ' + (liveOf(c, b).lines.at(-1) || 'starting…')),
    c.question && el('div', { class: 'q' }, el('div', {}, '❓ ' + c.question.title),
      c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '',
        onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o))),
    el('div', { class: 'meta' },
      el('span', { class: 'key', title: 'Open the thread', onclick: () => openThread(c.id) }, c.id),
      el('span', { class: 'push' }), facts(c), moves(c, b)));
  if (movable) dragOf(node, c, c.column);
  return node;
}

function rowNode(c, b) {
  const node = el('div', { class: 'row', draggable: !c.done && c.column !== 'building' && 'true', 'data-id': c.id },
    el('div', {}, el('span', { class: 'title', onclick: () => openThread(c.id) }, c.title),
      el('span', { class: 'chips', style: 'display: inline-flex; margin: 0 0 0 8px; vertical-align: middle' }, chipsOf({ ...c, sprint: '', done: false }, b))),
    el('div', { class: 'right' },
      el('span', { class: 'state ' + c.column }, STATE[c.column]),
      facts(c), el('span', { class: 'key', onclick: () => openThread(c.id) }, c.id), moves(c)));
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
    const drop = key === 'proposed' || key === 'build';
    return el('section', { class: 'col', 'data-column': key,
      ondragover: (e) => { if (drop) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.currentTarget.classList.remove('over');
        const [id, from] = e.dataTransfer.getData('text/plain').split(' ');
        if (!drop || !id || from === key) return;
        e.preventDefault();
        post('move', { id, to: key }, key === 'build' ? 'In build' : 'Back in the backlog');
      } },
      el('h2', {}, DOT[key] + ' ' + name, el('span', { class: 'count' }, filter ? every.length + ' of ' + whole.length : String(cards.length))),
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
    ...open.map((s) => sprintNode(s, b)),
    newSprint,
    dropInto(el('div', { class: 'group' },
      el('div', { class: 'ghead' }, el('span', { class: 'gname' }, 'Backlog'), el('span', { class: 'gmeta' }, loose.length + (loose.length === 1 ? ' thread' : ' threads') + ' in no sprint')),
      loose.length ? loose.map((c) => rowNode(c, b)) : el('div', { class: 'empty' }, 'Everything is in a sprint, or built.'),
      addNode('proposed', 'What do you want added?'),
      loose.length > 0 && el('div', { style: 'margin-top: 8px; max-width: 320px' }, addAllNode('backlog', loose))), ''),
    ...finished.map((s) => sprintNode(s, b)));
}

// ---- what needs you: questions, plans, the calls agents made, new skills, unfiled notes

const needCount = (b) => b.needs.questions.length + b.needs.plans.length + b.needs.calls.length + b.needs.skills.length + b.needs.notes.length;

// A box to say something else in, and the button that sends it.
function sayNode(placeholder, label, send) {
  const box = el('input', { placeholder, onkeydown: (e) => { if (e.key === 'Enter' && box.value.trim()) send(box.value.trim()); } });
  return [box, el('button', { onclick: () => { if (box.value.trim()) send(box.value.trim()); } }, label)];
}

function drawNeeds(b) {
  const n = b.needs;
  const holds = (list) => list.length > 0 && el('div', { class: 'more' }, 'Holding up: ' + list.join(' · '));
  const section = (title, items, extra) => items.length > 0 && [el('h2', {}, title + ' · ' + items.length, extra), items];
  document.getElementById('needs').replaceChildren(...[
    needCount(b) === 0 && el('div', { class: 'empty' }, 'Nothing needs you. Agents have what they need.'),

    section('❓ Questions', n.questions.map((q) => el('div', { class: 'need' },
      el('div', { class: 'what' }, q.title),
      q.why && el('div', { class: 'more' }, q.why),
      holds(q.holds),
      el('div', { class: 'acts' },
        q.options.map((o, i) => el('button', { class: q.recommend === i + 1 ? 'rec' : '', title: q.recommend === i + 1 ? 'Recommended' : '',
          onclick: () => post('answer', { id: q.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)),
        sayNode('Or say what you want', 'Answer', (words) => post('answer', { id: q.id, choice: words }, 'Answered')))))),

    section('🗺 Plans waiting for your go-ahead', n.plans.map((plan) => el('div', { class: 'need' },
      el('div', { class: 'what' }, plan.title),
      plan.summary && el('div', { class: 'more' }, plan.summary),
      plan.parts.length > 0 && el('ul', {}, plan.parts.map((part) => el('li', {}, part))),
      el('div', { class: 'acts' },
        el('button', { class: 'go', onclick: () => post('approve', { id: plan.id }, 'The plan has your go-ahead') }, 'Go ahead'),
        el('button', { onclick: () => openThread(plan.id) }, 'Read the plan'))))),

    section('🧾 Calls agents made', n.calls.map((call) => el('div', { class: 'need' },
      el('div', { class: 'what' }, call.title),
      el('div', { class: 'chose' }, '→ ' + call.choice),
      call.why && el('div', { class: 'more' }, call.why),
      holds(call.holds),
      el('div', { class: 'acts' },
        el('button', { onclick: () => post('approve', { id: call.id }, 'Accepted') }, 'Fine'),
        sayNode('No: say what you want instead', 'Overrule', (words) => post('answer', { id: call.id, choice: words }, 'Overruled. The rework is in the backlog.'))))),
      n.calls.length > 1 && el('button', { onclick: () => post('approve-calls', {}, 'All accepted') }, 'All fine')),

    section('📘 New skills agents wrote', n.skills.map((skill) => el('div', { class: 'need' },
      el('div', { class: 'what' }, skill.name),
      skill.about && el('div', { class: 'more' }, skill.about),
      el('div', { class: 'acts' },
        el('button', { onclick: () => post('approve', { id: skill.id }, 'Kept') }, 'Keep'),
        el('button', { onclick: () => post('drop-skill', { id: skill.id }, 'Dropped') }, 'Drop'))))),

    section('✎ Notes nobody filed', n.notes.map((note) => el('div', { class: 'need' },
      el('pre', {}, note.text),
      el('div', { class: 'acts' },
        el('button', { class: 'go', onclick: () => post('note-thread', { id: note.id, title: note.text }, 'It is a thread in the backlog') }, 'Make it a thread'),
        el('button', { onclick: () => post('note-aside', { id: note.id }, 'Set aside') }, 'Set aside'))))),
  ].flat(3).filter(Boolean));
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
  return { name: who, model: '', kind: 'agent' };
};
// Claude's own mark, from docs/claude_logo.svg. It is Anthropic's trademark, shown only to say which agent did the work.
const CLAUDE = '<svg viewBox="0 0 24 24" fill="#D97757" role="img" aria-label="Claude"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
function avatar(who) {
  const s = speaker(who);
  const node = el('div', { class: 'avatar ' + s.kind, title: s.model ? s.name + ' ' + s.model : s.name });
  if (s.kind === 'claude') node.innerHTML = CLAUDE;
  else node.textContent = s.kind === 'you' ? 'You'.slice(0, 1) : '🤖';
  return node;
}
function byline(who, at) {
  const s = speaker(who);
  return el('div', { class: 'byline' }, el('b', {}, s.name), s.model && el('span', { class: 'model' }, s.model), el('span', { class: 'at' }, when(at)));
}
const when = (at) => (at ? at.slice(5, 10).replace('-', '/') + ' ' + at.slice(11, 16) : '');

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
function changesNode(c) {
  if (!c.done || !c.thread.commits.length) return null;
  const d = showing.has(c.id) && diffs.get(c.id);
  const line = (text) => el('div', { class: text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') ? 'head' : text.startsWith('@@') ? 'at' : text.startsWith('+') ? 'plus' : text.startsWith('-') ? 'minus' : '' }, text || ' ');
  return el('div', { class: 'changes' },
    el('button', { onclick: () => showChanges(c.id) }, d ? 'Hide the changes' : 'Show what changed'),
    d && d.files.map((f) => el('div', { class: 'file' }, el('span', { class: 'mono' }, f.path), el('span', { class: 'plus' }, '+' + f.added), el('span', { class: 'minus' }, '−' + f.removed))),
    d && !d.files.length && el('div', { class: 'note' }, 'No changes on record for it in this repository.'),
    d && d.patch && el('div', { class: 'diff' }, d.patch.split('\n').map(line)),
    d && d.cut && el('div', { class: 'note' }, 'The rest is too long to show here.'));
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
  return el('details', { class: 'desc', open: true },
    el('summary', {}, '🧶 About this thread'),
    el('div', { class: 'kind' }, kind[0] + ' ' + kind[1] + sized, el('span', {}, ' — ' + kind[2])),
    parts.map((p) => part(ABOUT_ICON[p.key], p.label, p.text, p.key)),
    c.suggested && part('✨', 'Why an agent suggested it', c.suggested, 'idea'));
}

// A ticket, the way a board has always shown one: the story on the left, its fields on the right.
function threadNode(c, b) {
  const t = c.thread;
  const save = (fields, done) => post('edit', { id: c.id, ...fields }, done);
  const box = el('textarea', { placeholder: 'Post your reply', oninput: (e) => drafts.set(c.id, e.target.value) });
  box.value = drafts.get(c.id) || '';
  const lineage = [
    ...t.cameFrom.map((f) => 'Came out of: ' + f.title),
    ...t.parts.map((p) => 'Part: ' + p.title + ' (' + p.state + ')'),
    ...t.questions.map((q) => 'Asked: ' + q.title + (q.choice ? ' → ' + q.choice : ' → not answered yet')),
  ];

  const title = el('h2', { contenteditable: 'plaintext-only', spellcheck: 'false', title: 'Click to rename',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = c.title; e.target.blur(); e.stopPropagation(); } },
    onblur: (e) => { const now = e.target.textContent.trim(); if (now && now !== c.title) save({ title: now }, 'Renamed'); else e.target.textContent = c.title; } }, c.title);

  const story = el('div', {},
    el('div', { class: 'key' }, (c.n != null ? '#' + c.n + ' · ' : '') + c.id),
    title,
    describeNode(c),

    // The thread itself: a conversation, oldest first. You said, Claude answered, and the moves in between.
    el('div', { class: 'feed' },
      t.feed.map((p) => {
        if (p.kind === 'event') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }), el('div', {}, speaker(p.who).name + ' ' + p.text + ' · ' + when(p.at)));
        }
        const asking = p.kind === 'asked' && c.question && c.question.title === p.text;
        return el('div', { class: 'post' }, avatar(p.who),
          el('div', {}, byline(p.who, p.at),
            p.kind === 'shipped' && el('span', { class: 'badge' }, '✓ Shipped'),
            p.kind === 'asked' && el('span', { class: 'badge ask' }, '❓ Needs a call from you'),
            el('pre', {}, p.text),
            p.kind === 'shipped' && t.checked && el('div', { class: 'badge', style: 'display: block' }, '✓ Check passed: ' + t.checked),
            p.kind === 'shipped' && t.commits.length > 0 && el('div', { class: 'mono', style: 'margin-top: 6px; color: var(--soft)' }, (t.commits.length === 1 ? 'commit ' : 'commits ') + t.commits.join(' · ')),
            asking && el('div', {}, c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '', style: 'margin: 8px 6px 0 0',
              onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)))));
      }),
      // A question with no line of its own in the log still has to be answerable here.
      c.question && !t.feed.some((p) => p.kind === 'asked' && p.text === c.question.title) && el('div', { class: 'post' }, avatar(t.by || 'agent'),
        el('div', {}, byline(t.by || 'agent', ''), el('span', { class: 'badge ask' }, '❓ Needs a call from you'), el('pre', {}, c.question.title),
          el('div', {}, c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '', style: 'margin: 8px 6px 0 0',
            onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)))))),

    liveOf(c, b) && [el('h3', {}, 'Live · ' + liveOf(c, b).seconds + 's'), el('div', { class: 'livelog' }, liveOf(c, b).lines.join('\n') || 'starting…'),
      el('button', { style: 'margin-top: 8px', onclick: () => post('stop', {}, 'Stopped') }, '■ Stop the agent')],
    t.report && el('details', { class: 'desc', open: true }, el('summary', {}, c.type === 'plan' ? 'The plan' : 'The report'), el('pre', {}, t.report)),

    lineage.length > 0 && [el('h3', {}, 'Linked'), lineage.map((l) => el('div', { class: 'note' }, l))],

    el('div', { class: 'compose' }, avatar('human'),
      el('div', {}, box,
        el('div', { class: 'acts' }, el('button', { class: 'go', onclick: async () => {
          if (!box.value.trim()) return;
          if (await post('note', { id: c.id, text: box.value }, 'Posted to the thread')) drafts.delete(c.id);
        } }, 'Reply')))),
    changesNode(c),
    c.done && el('div', { class: 'finish' }, c.complete
      ? el('div', { class: 'ok' }, '✓ Complete. You approved this change.')
      : el('button', { class: 'go', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓ Mark as complete'),
      undoNode(c)));

  const field = (label, ...kids) => el('div', { class: 'field' }, el('label', {}, label), kids);
  const choose = (options, value, onchange) => {
    const node = el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  const movable = c.column === 'proposed' || c.column === 'build';
  const status = movable
    ? choose([['proposed', '🟠 Proposed'], ['build', '🟢 Build']], c.column, (to) => post('move', { id: c.id, to }, to === 'build' ? 'In build' : 'Back to proposed'))
    : el('div', { class: 'val' }, c.column === 'building' ? '🔵 Building' + (t.by ? ', by ' + whoIs(t.by) : '') : c.complete ? '✅ Done · complete' : '✅ Done · for you to check');
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

function drawThread(b) {
  const pane = document.getElementById('thread');
  const veil = document.getElementById('veil');
  const c = openId && everyCard(b).find((x) => x.id === openId);
  pane.hidden = veil.hidden = !c;
  if (!c) { openId = null; return; }
  const at = pane.scrollTop;
  pane.replaceChildren(...threadNode(c, b));
  pane.scrollTop = at;
}

// ---- the page

function draw(b) {
  document.getElementById('project').textContent = b.project;
  // The yarn is the tab's icon, so the title is the project's name alone.
  document.title = b.project;
  document.getElementById('where').textContent = b.version ? 'v' + b.version : '';
  // One thing is still worth a line: a project where the gate is off, because there the board
  // cannot promise that nothing builds by itself.
  const rule = document.getElementById('rule');
  rule.textContent = b.gate ? '' : 'The build gate is off in this project: new threads go straight to Build.';
  rule.hidden = b.gate;
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

  // The page's own runner: one switch. On, the page builds what is in Build with no chat open.
  const runner = document.getElementById('runner');
  runner.hidden = false;
  runner.className = 'runner' + (b.runner.on ? ' on' : '');
  runner.textContent = b.runner.on ? (b.runner.current ? '● Agents: building' : '● Agents: on') : 'Agents: off';
  runner.title = (b.runner.on ? 'This page is building what is in Build. Click to switch it off.' : 'Click to have this page build what is in Build, with no chat open.') + ' It runs: ' + b.runner.agent
    + (b.runner.recent.length ? '. Last: ' + b.runner.recent[0].title + ' — ' + b.runner.recent[0].outcome : '');
  runner.onclick = () => post('runner', { on: !b.runner.on }, '');
  const waiting = needCount(b);
  const badge = document.getElementById('needcount');
  badge.textContent = String(waiting);
  badge.hidden = waiting === 0;
  document.getElementById('board').hidden = view !== 'board';
  document.getElementById('backlog').hidden = view !== 'backlog';
  document.getElementById('needs').hidden = view !== 'needs';
  if (view === 'board') drawBoard(b); else if (view === 'backlog') drawBacklog(b); else drawNeeds(b);
  const box = document.querySelector('.adding textarea, .adding input');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  drawThread(b);
}

// Draw again from what is already here: a view, a filter or a box changed, and nothing on disk did.
function redraw() { if (current) draw(current); }

async function load(now) {
  // Never redraw under someone's typing or choosing; a redraw that was asked for goes ahead.
  const at = document.activeElement;
  if (!now && (busy || (at && at.id !== 'search' && (['TEXTAREA', 'INPUT', 'SELECT'].includes(at.tagName) || at.isContentEditable)))) return;
  try {
    const text = await (await fetch('/api/board')).text();
    if (text === last) return;
    last = text;
    current = JSON.parse(text);
    draw(current);
  } catch (e) {
    say('The page lost its server. Run spool page again.');
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
</script>
</body>
</html>
`;
