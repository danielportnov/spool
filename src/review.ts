/**
 * A sprint's review: everything the human needs to judge a sprint as one piece of work, on one page.
 *
 * The human says what a stretch of work is for, presses play and walks away; when he comes back he
 * reviews the sprint, not thread by thread across the board. So this gathers, for one sprint: what
 * it was for, how long it took and how much it touched, each thread with the one line that says
 * what it did, the steps to see it working and the calls its agent made, and what was undone or
 * stopped on the way. It is read from disk and git when asked for, and never kept: the board, which
 * is asked for every second, does not carry it.
 */

import { changedFiles, finishedAt } from './brief.ts';
import { repoRoot } from './git.ts';
import { type Item, oneLine, splitBody } from './model.ts';
import { logOf, sprintAbout, sprintDates } from './sprints.ts';
import { review, sprintTasks, taskState } from './schedule.ts';
import type { Workspace } from './store.ts';

interface Call {
  id: string;
  /** The question the agent faced, and what it chose. */
  title: string;
  choice: string;
  why: string;
  by: string;
  /** assumed: still for him to look at · fine: he accepted it · overruled: he said otherwise · dropped. */
  status: 'assumed' | 'fine' | 'overruled' | 'dropped';
  /** What he said instead, where he overruled it. */
  instead: string;
}

interface Thread {
  id: string;
  title: string;
  /** Its state as the scheduler says it: done, active, ready, proposed and the rest. */
  state: string;
  summary: string;
  steps: string[];
  /** Finished, and marked complete by him. */
  complete: boolean;
  size: string;
  files: number;
  commits: number;
  calls: Call[];
}

export interface SprintReview {
  sprint: { id: string; name: string; status: string; goal: string; why: string; doneWhen: string; serves: string; vision: string; version: string; started: string; reached: string };
  total: number;
  done: number;
  /** From the first thread being started to the last being finished, in ms. */
  took: number;
  /** The files changed by all of its threads together, each counted once. */
  files: number;
  threads: Thread[];
  /** What was taken back or cut short on the way: reverted, dropped, or left unfinished by an agent. */
  undone: { id: string; title: string; what: string; at: string }[];
  /** What "Approve the sprint" would approve: finished threads not yet complete, and calls not yet looked at. */
  toApprove: { threads: string[]; calls: string[] };
}

// What on a thread's log is something taken back or cut short.
const SETBACK = /reverted \d+ commit|^dropped|without finishing|^stopped/;

/** The calls an agent made on a thread, read from its log, each as it stands now. */
function callsOf(ws: Workspace, t: Item): Call[] {
  const out: Call[] = [];
  for (const e of logOf(t)) {
    const made = /^assumed (d-[a-z0-9]+): (.*)$/.exec(e.what);
    const d = made && ws.find(made[1]!);
    if (!d || d.kind !== 'decision' || out.some((c) => c.id === d.id)) continue;
    // The log line is "question → choice", as the agent chose it. Overruled, the decision says his instead.
    const chose = made[2]!.slice(made[2]!.lastIndexOf(' → ') + 3);
    const status = d.status === 'assumed' ? 'assumed' : d.status === 'dropped' ? 'dropped' : d.choice && d.choice !== chose ? 'overruled' : 'fine';
    const reason = splitBody(d.body).main.split('\n')[0] ?? '';
    out.push({
      id: d.id,
      title: d.title,
      choice: chose,
      why: reason.startsWith('For [[') ? '' : oneLine(reason, 240),
      by: d.by ?? '',
      status,
      instead: status === 'overruled' ? (d.choice ?? '') : '',
    });
  }
  return out;
}

/** The review of one sprint, made fresh from what is on disk and in git. */
export function sprintReview(ws: Workspace, id: string): SprintReview {
  const sprint = ws.get(id, 'sprint');
  const inIt = sprintTasks(ws, sprint).sort((a, b) => finishedOrNot(a) - finishedOrNot(b) || a.created.localeCompare(b.created));
  const root = repoRoot(sprint.spool.root);
  const all = new Set<string>();
  const threads = inIt.map((t): Thread => {
    const files = t.status === 'done' ? changedFiles(t, root) : new Set<string>();
    for (const f of files) all.add(f);
    return {
      id: t.id,
      title: t.title,
      state: taskState(ws, t),
      summary: t.summary ?? '',
      steps: t.status === 'done' ? t.steps : [],
      complete: t.status === 'done' && !!t.reviewed,
      size: t.size ?? '',
      files: files.size,
      commits: t.commits.length,
      calls: callsOf(ws, t),
    };
  });
  const finished = inIt.filter((t) => t.status === 'done');
  const starts = finished.map((t) => Date.parse(t.started ?? t.created));
  const ends = finished.map(finishedAt);
  // Dropped threads are out of the sprint's count, but how they came to be dropped is part of its story.
  const story = ws.items.filter((i) => i.kind === 'task' && i.sprint === sprint.id);
  const undone = story
    .flatMap((t) => logOf(t).filter((e) => SETBACK.test(e.what)).map((e) => ({ id: t.id, title: t.title, what: oneLine(e.what, 200), at: e.at })))
    .sort((a, b) => a.at.localeCompare(b.at));
  // The same threads and calls the brief's approve-everything takes, narrowed to this sprint.
  const queue = review(ws, sprint.spool);
  const mine = new Set(inIt.map((t) => t.id));
  const calls = new Set(threads.flatMap((t) => t.calls.map((c) => c.id)));
  return {
    sprint: { id: sprint.id, name: sprint.title, status: sprint.status, ...sprintAbout(sprint), ...sprintDates(sprint) },
    total: inIt.length,
    done: finished.length,
    took: finished.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0,
    files: all.size,
    threads,
    undone,
    toApprove: {
      threads: queue.shipped.filter((t) => mine.has(t.id)).map((t) => t.id),
      calls: queue.assumptions.filter((d) => calls.has(d.id)).map((d) => d.id),
    },
  };
}

/** Finished threads first, in the order they were finished; the rest after them. */
function finishedOrNot(t: Item): number {
  return t.status === 'done' ? finishedAt(t) : Number.MAX_SAFE_INTEGER;
}
