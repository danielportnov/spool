/**
 * Scheduling: what is ready, what is waiting, and on whom.
 *
 * Everything here is derived from the items on disk at the moment of asking.
 * Nothing is cached and nothing is stored, so there is no state to repair.
 */

import { type Item, isSettled } from './model.ts';
import type { Workspace } from './store.ts';

export type TaskState = 'ready' | 'blocked' | 'active' | 'stale' | 'done' | 'dropped';

/** The unsettled items a task is waiting on. Unknown ids do not block; `spool check` flags them. */
export function blockers(ws: Workspace, task: Item): Item[] {
  const out: Item[] = [];
  for (const id of task.needs) {
    const dep = ws.find(id);
    if (dep && !isSettled(dep)) out.push(dep);
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

function byUrgency(a: Item, b: Item): number {
  return (a.priority ?? 2) - (b.priority ?? 2) || a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
}

export function tasks(ws: Workspace, project?: string): Item[] {
  const spool = project ? ws.project(project) : undefined;
  return ws.items.filter((i) => i.kind === 'task' && (!spool || i.spool === spool));
}

/** Tasks a worker could pick up now, most urgent first. */
export function ready(ws: Workspace, project?: string): Item[] {
  return tasks(ws, project)
    .filter((t) => ['ready', 'stale'].includes(taskState(ws, t)))
    .sort(byUrgency);
}

export interface Review {
  /** Open questions, the one holding up the most work first. */
  questions: Item[];
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
  return {
    questions: items
      .filter((i) => i.kind === 'decision' && i.status === 'open')
      .sort((a, b) => weight(b) - weight(a) || a.created.localeCompare(b.created)),
    assumptions: items
      .filter((i) => i.kind === 'decision' && i.status === 'assumed')
      .sort((a, b) => a.created.localeCompare(b.created)),
    shipped: items
      .filter((i) => i.kind === 'task' && i.status === 'done' && !i.reviewed)
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
