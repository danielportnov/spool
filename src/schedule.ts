/**
 * Scheduling: what is ready, what is waiting, and on whom.
 *
 * Everything here is derived from the items on disk at the moment of asking.
 * Nothing is cached and nothing is stored, so there is no state to repair.
 */

import { type Item, type Spool, isPlan, isSettled } from './model.ts';
import type { Workspace } from './store.ts';

export type TaskState = 'proposed' | 'ready' | 'held' | 'archived' | 'blocked' | 'active' | 'stale' | 'done' | 'dropped';

/** Tasks that came from `item`: the parts of a plan, the findings of an audit. */
export function children(ws: Workspace, item: Item): Item[] {
  return ws.items.filter((i) => i.kind === 'task' && i.from.includes(item.id));
}

/** The plans a task is a part of. */
export function plansOf(ws: Workspace, task: Item): Item[] {
  return task.from.map((id) => ws.find(id)).filter(isPlan);
}

/**
 * The unsettled items a task is waiting on: everything it `needs`, and any plan
 * it is a part of that is still being written. Unknown ids do not block;
 * `spool check` flags them.
 */
export function blockers(ws: Workspace, task: Item): Item[] {
  const out: Item[] = [];
  for (const id of task.needs) {
    const dep = ws.find(id);
    if (dep && !isSettled(dep)) out.push(dep);
  }
  for (const plan of plansOf(ws, task)) {
    if ((plan.status === 'open' || plan.status === 'active') && !out.includes(plan)) out.push(plan);
  }
  return out;
}

/** The tasks put in a sprint, whatever state they are in. */
export function sprintTasks(ws: Workspace, sprint: Item): Item[] {
  // An archived thread stays in its sprint, out of sight: playing the sprint does not move it.
  return ws.items.filter((i) => i.kind === 'task' && i.sprint === sprint.id && i.status !== 'dropped' && !(i.archived && i.status !== 'active' && i.status !== 'done'));
}

/** The sprint a task is in, if it is in one that still exists. */
export function sprintOf(ws: Workspace, task: Item): Item | undefined {
  const sprint = task.sprint ? ws.find(task.sprint) : undefined;
  return sprint && sprint.kind === 'sprint' && sprint.status !== 'dropped' ? sprint : undefined;
}

/** Whether a task is in a sprint the human has pressed play on and that is not finished yet. */
export function inPlayingSprint(ws: Workspace, task: Item): boolean {
  return sprintOf(ws, task)?.status === 'running';
}

/** Tasks that list `item` in their needs. */
export function dependents(ws: Workspace, item: Item): Item[] {
  return ws.items.filter((i) => i.kind === 'task' && i.needs.includes(item.id));
}

function leaseMs(task: Item): number {
  return (task.spool.config.leaseHours ?? 4) * 3_600_000;
}

export function taskState(ws: Workspace, task: Item): TaskState {
  if (task.status === 'done' || task.status === 'dropped') return task.status;
  // Out of sight, not dropped: whatever it was before it waits under that, untouched. One being
  // built is never archived, so a claim always wins.
  if (task.archived && task.status !== 'active') return 'archived';
  // Proposed is the gate: it has not been moved to build, so nothing else about it matters yet.
  if (task.status === 'proposed') return 'proposed';
  if (task.hold) return 'held';
  if (blockers(ws, task).length) return 'blocked';
  if (task.status === 'active') {
    // A claim nobody has touched for a lease is assumed abandoned and offered again.
    return ws.now().getTime() - Date.parse(task.updated) > leaseMs(task) ? 'stale' : 'active';
  }
  return 'ready';
}

/** The derived state of any item, for display and filtering. */
export function stateOf(ws: Workspace, item: Item): string {
  return item.kind === 'task' ? taskState(ws, item) : item.status;
}

/** A project, given by name or as itself. */
export type Scope = string | Spool | undefined;

function scoped(ws: Workspace, project: Scope): Spool | undefined {
  return typeof project === 'string' ? ws.project(project) : project;
}

export function tasks(ws: Workspace, project?: Scope): Item[] {
  const spool = scoped(ws, project);
  return ws.items.filter((i) => i.kind === 'task' && (!spool || i.spool === spool));
}

const EFFORT = { xs: 0, s: 1, m: 2, l: 3, xl: 4 } as const;

/** How much work picking this up is. Writing a plan is quick whatever the size of the thing planned. */
export function effort(task: Item): number {
  return task.type === 'plan' ? EFFORT.s : EFFORT[task.size ?? 'm'];
}

/** Large work: big on its own, or a part of something that needed a plan. */
export function isLarge(ws: Workspace, task: Item): boolean {
  if (plansOf(ws, task).length) return true;
  return task.type !== 'plan' && (task.size === 'l' || task.size === 'xl');
}

/**
 * Tasks a worker could pick up now, in the order they will be picked.
 *
 * A place in line the human gave comes before everything: they dragged it
 * there, so it is what they want next. The rest follow by the usual rule.
 * Priority comes first: it is the human's urgency. Within a priority the
 * smallest goes first, because quick wins are the cheapest progress there is —
 * except that one pick in `largeEvery` goes to large work, so a flood of small
 * things can never starve it. Within the same priority and the same lane, a
 * sprint the human pressed play on goes ahead of everything else: they made it
 * the plan, so its threads are what they mean by next. It sits under the lane
 * so the turn for large work still holds while a sprint is full of small things.
 * Whose turn it is comes from the `started` stamps
 * on the tasks themselves; there is no counter to keep. The list is the whole
 * sequence played forward, so what `status` shows is what `next` will do.
 */
export function ready(ws: Workspace, project?: Scope): Item[] {
  const scope = tasks(ws, project);
  const every = Math.max(1, ws.home.config.largeEvery ?? 4);
  let quickRun = 0;
  for (const t of scope.filter((t) => t.started).sort((a, b) => b.started!.localeCompare(a.started!))) {
    if (isLarge(ws, t)) break;
    quickRun++;
  }
  const pool = scope.filter((t) => ['ready', 'stale'].includes(taskState(ws, t)));
  const large = new Map(pool.map((t) => [t.id, isLarge(ws, t)]));
  const playing = new Map(pool.map((t) => [t.id, inPlayingSprint(ws, t) ? 0 : 1]));
  const order: Item[] = [];
  const placed = pool.filter((t) => t.place !== undefined).sort((a, b) => a.place! - b.place! || a.id.localeCompare(b.id));
  for (const t of placed) {
    pool.splice(pool.indexOf(t), 1);
    order.push(t);
    quickRun = large.get(t.id) ? 0 : quickRun + 1;
  }
  while (pool.length) {
    const largeTurn = quickRun >= every - 1;
    const lane = (t: Item) => (large.get(t.id) === largeTurn ? 0 : 1);
    pool.sort(
      (a, b) =>
        (a.priority ?? 2) - (b.priority ?? 2) ||
        lane(a) - lane(b) ||
        playing.get(a.id)! - playing.get(b.id)! ||
        effort(a) - effort(b) ||
        a.created.localeCompare(b.created) ||
        a.id.localeCompare(b.id),
    );
    const next = pool.shift()!;
    order.push(next);
    quickRun = large.get(next.id) ? 0 : quickRun + 1;
  }
  return order;
}

/** States of the work in the Build column: in build, and not taken yet. */
export const IN_BUILD = ['ready', 'stale', 'blocked'];

/**
 * The line Build is in: the placed work by its place, then the rest by the
 * usual rule, with what is waiting on something after what is ready. Work
 * that is waiting keeps its place, and takes it when it is free.
 */
export function buildLine(ws: Workspace, spool: Spool): Item[] {
  const mine = tasks(ws, spool).filter((t) => IN_BUILD.includes(taskState(ws, t)));
  const usual = [...ready(ws, spool), ...mine.filter((t) => taskState(ws, t) === 'blocked')];
  const placed = mine.filter((t) => t.place !== undefined).sort((a, b) => a.place! - b.place! || a.id.localeCompare(b.id));
  return [...placed, ...usual.filter((t) => t.place === undefined)];
}

export interface Review {
  /** Open questions, the one holding up the most work first. */
  questions: Item[];
  /** Finished plans whose parts are waiting for a go-ahead. */
  plans: Item[];
  /** Calls an agent made and acted on. */
  assumptions: Item[];
  /** Finished work the human has not acknowledged, newest first. */
  shipped: Item[];
  /** Skills agents wrote that the human has not seen. */
  skills: Item[];
  /** Feedback nobody has filed yet. */
  inbox: Item[];
}

/** Everything waiting on the human, most blocking first. */
export function review(ws: Workspace, project?: Scope): Review {
  const spool = scoped(ws, project);
  const items = ws.items.filter((i) => !spool || i.spool === spool);
  const weight = (d: Item): number => {
    const deps = dependents(ws, d).filter((t) => !isSettled(t));
    return deps.length * 10 - Math.min(...deps.map((t) => t.priority ?? 2), 3);
  };
  const gating = (i: Item) =>
    isPlan(i) && i.status === 'done' && !i.reviewed && dependents(ws, i).some((t) => t.status === 'open' || t.status === 'active');
  return {
    questions: items
      .filter((i) => i.kind === 'decision' && i.status === 'open')
      .sort((a, b) => weight(b) - weight(a) || a.created.localeCompare(b.created)),
    plans: items.filter(gating).sort((a, b) => a.created.localeCompare(b.created)),
    assumptions: items
      .filter((i) => i.kind === 'decision' && i.status === 'assumed')
      .sort((a, b) => a.created.localeCompare(b.created)),
    shipped: items
      .filter((i) => i.kind === 'task' && i.status === 'done' && !i.reviewed && !gating(i))
      .sort((a, b) => b.updated.localeCompare(a.updated)),
    skills: items.filter((i) => i.kind === 'skill' && i.status === 'active' && !i.reviewed),
    inbox: items.filter((i) => i.kind === 'note' && i.status === 'new').sort((a, b) => a.created.localeCompare(b.created)),
  };
}

export interface Docket {
  spool: Spool;
  /** Open questions, and plans whose parts wait for a go-ahead: only the human can move these. */
  needsYou: Item[];
  /** Too big to build in one go: plans not yet written, and anything sized xl. */
  breakDown: Item[];
  blocked: Item[];
  active: Item[];
  /** In the order it will be picked. */
  ready: Item[];
  /** Not in build: waiting for the human to move them there. Most urgent first. */
  proposed: Item[];
  /** Ideas agents added by themselves: on hold until the human says yes. */
  suggested: Item[];
  held: Item[];
  done: number;
  /** Waiting on the human without holding anything up. */
  also: { assumptions: number; shipped: number; skills: number; inbox: number };
}

/**
 * Everything open in one project, each task in exactly one place, ordered by
 * who has to move next: the human first, then what needs thought, then what
 * is waiting, then what is simply underway.
 */
export function docket(ws: Workspace, spool: Spool): Docket {
  const queue = review(ws, spool);
  const mine = tasks(ws, spool);
  const big = (t: Item) => t.type === 'plan' || t.size === 'xl';
  const live = mine.filter((t) => !['done', 'dropped', 'held', 'proposed', 'archived'].includes(taskState(ws, t)));
  const rest = live.filter((t) => !big(t));
  const state = (t: Item) => taskState(ws, t);
  return {
    spool,
    needsYou: [...queue.questions, ...queue.plans],
    breakDown: live.filter(big).sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || a.created.localeCompare(b.created)),
    blocked: rest.filter((t) => state(t) === 'blocked'),
    active: rest.filter((t) => state(t) === 'active' || state(t) === 'stale'),
    ready: ready(ws, spool).filter((t) => !big(t) && state(t) === 'ready'),
    proposed: mine
      .filter((t) => state(t) === 'proposed')
      .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || effort(a) - effort(b) || a.created.localeCompare(b.created)),
    suggested: mine.filter((t) => state(t) === 'held' && !!t.suggested),
    held: mine.filter((t) => state(t) === 'held' && !t.suggested),
    done: mine.filter((t) => t.status === 'done').length,
    also: {
      assumptions: queue.assumptions.length,
      shipped: queue.shipped.length,
      skills: queue.skills.length,
      inbox: queue.inbox.length,
    },
  };
}

/** A cycle in `needs`, as a list of ids, or null. */
export function findCycle(ws: Workspace): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const next of ws.find(id)?.needs ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const item of ws.items) {
    const cycle = visit(item.id);
    if (cycle) return cycle;
  }
  return null;
}
