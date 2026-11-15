/**
 * Scheduling: what is ready, what is waiting, and on whom.
 *
 * Everything here is derived from the items on disk at the moment of asking.
 * Nothing is cached and nothing is stored, so there is no state to repair.
 */

import { type Item, isPlan, isSettled } from './model.ts';
import type { Workspace } from './store.ts';

export type TaskState = 'ready' | 'held' | 'blocked' | 'active' | 'stale' | 'done' | 'dropped';

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

/** Tasks that list `item` in their needs. */
export function dependents(ws: Workspace, item: Item): Item[] {
  return ws.items.filter((i) => i.kind === 'task' && i.needs.includes(item.id));
}

function leaseMs(task: Item): number {
  return (task.spool.config.leaseHours ?? 4) * 3_600_000;
}

export function taskState(ws: Workspace, task: Item): TaskState {
  if (task.status === 'done' || task.status === 'dropped') return task.status;
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

export function tasks(ws: Workspace, project?: string): Item[] {
  const spool = project ? ws.project(project) : undefined;
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
 * Priority comes first: it is the human's urgency. Within a priority the
 * smallest goes first, because quick wins are the cheapest progress there is —
 * except that one pick in `largeEvery` goes to large work, so a flood of small
 * things can never starve it. Whose turn it is comes from the `started` stamps
 * on the tasks themselves; there is no counter to keep. The list is the whole
 * sequence played forward, so what `status` shows is what `next` will do.
 */
export function ready(ws: Workspace, project?: string): Item[] {
  const scope = tasks(ws, project);
  const every = Math.max(1, ws.home.config.largeEvery ?? 4);
  let quickRun = 0;
  for (const t of scope.filter((t) => t.started).sort((a, b) => b.started!.localeCompare(a.started!))) {
    if (isLarge(ws, t)) break;
    quickRun++;
  }
  const pool = scope.filter((t) => ['ready', 'stale'].includes(taskState(ws, t)));
  const large = new Map(pool.map((t) => [t.id, isLarge(ws, t)]));
  const order: Item[] = [];
  while (pool.length) {
    const largeTurn = quickRun >= every - 1;
    const lane = (t: Item) => (large.get(t.id) === largeTurn ? 0 : 1);
    pool.sort(
      (a, b) =>
        (a.priority ?? 2) - (b.priority ?? 2) ||
        lane(a) - lane(b) ||
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
export function review(ws: Workspace, project?: string): Review {
  const spool = project ? ws.project(project) : undefined;
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
