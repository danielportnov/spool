/**
 * Every project the page can show: the spool it was started in and every spool below it.
 *
 * A folder of projects (a studio of apps and tools, each with its own `.spool/`) is one page:
 * the board carries a short list of the projects, with what each holds, so the page can offer
 * them in a switcher and draw a home view of them all. It is plain data read fresh from disk,
 * as the board is. `named` is how the server turns a name the page sent into a project: only a
 * name on the workspace's own list is taken, never a path.
 */

import { liveNow } from './board.ts';
import { type Brief, morning, waitingOnYou } from './brief.ts';
import { type Item, type Spool, oneLine } from './model.ts';
import { review, sprintTasks, taskState, tasks } from './schedule.ts';
import type { Workspace } from './store.ts';

/** One project, as a line in the switcher and a row of the home view. */
export interface Project {
  name: string;
  /** Its folder from the top of the workspace: empty for the top itself. */
  folder: string;
  /** `needs` is what waits on the human, as the brief counts it (`waitingOnYou`). */
  counts: { backlog: number; build: number; building: number; check: number; needs: number };
  /** Whether the runner of this page builds its threads. Where it does not, its own page or a chat does. */
  built: boolean;
  /** What is being built right now, with the last thing its agent said. */
  building: { id: string; title: string; said: string }[];
  /** The plans waiting on the human's go-ahead, a line each. A question is not here: the page asks it on its thread alone. */
  needs: { id: string; title: string }[];
  /** The sprint being played, if one is, and how far along it is. */
  sprint: { id: string; name: string; done: number; total: number } | null;
}

/** The project the page names, by its exact name on the workspace's own list. Nothing else is taken. */
export function named(ws: Workspace, name: unknown): Spool | undefined {
  return typeof name === 'string' ? ws.spools.find((s) => s.name === name) : undefined;
}

/** The last thing an agent said on a thread being built: what this page's agent printed, or else the note it left on the thread. */
function lastSaid(task: Item, lines: string[] | undefined): string {
  const heard = lines?.filter((l) => l.trim()).at(-1);
  return heard ? oneLine(heard, 160) : liveNow(task).note;
}

/**
 * The workspace's projects, the top one first and the rest by name, as `ws.spools` has them.
 * `builds` says which this page's runner builds; `heard` is what each of its agents has said.
 */
export function projectsOf(ws: Workspace, builds: (spool: Spool) => boolean, heard: (id: string) => string[] | undefined): Project[] {
  return ws.spools.map((spool) => {
    const mine = tasks(ws, spool);
    const state = new Map(mine.map((t) => [t.id, taskState(ws, t)]));
    const count = (...states: string[]) => mine.filter((t) => states.includes(state.get(t.id)!)).length;
    const queue = review(ws, spool);
    const needs = queue.plans.map((i) => ({ id: i.id, title: oneLine(i.title, 110) }));
    const playing = ws.items
      .filter((i) => i.kind === 'sprint' && i.spool === spool && i.status === 'running')
      .sort((a, b) => b.updated.localeCompare(a.updated))[0];
    const inSprint = playing ? sprintTasks(ws, playing) : [];
    return {
      name: spool.name,
      folder: spool.home ? '' : spool.name,
      counts: {
        backlog: count('proposed', 'held'),
        build: count('ready', 'stale', 'blocked'),
        building: count('active'),
        check: mine.filter((t) => t.status === 'done' && !t.reviewed).length,
        needs: waitingOnYou(ws, spool),
      },
      built: builds(spool),
      building: mine.filter((t) => state.get(t.id) === 'active').map((t) => ({ id: t.id, title: oneLine(t.title, 110), said: lastSaid(t, heard(t.id)) })),
      needs,
      sprint: playing ? { id: playing.id, name: playing.title, done: inSprint.filter((t) => t.status === 'done').length, total: inSprint.length } : null,
    };
  });
}

/**
 * The brief across every project, for the home view: one `morning()` over the whole workspace,
 * which names each item's project. Kept for as long as nothing it reads has changed, the way the
 * board keeps one project's brief: a thread being built is left out of the stamps but for its state.
 */
let kept: { key: string; brief: Brief | null } | undefined;

export function briefAcross(ws: Workspace): Brief | null {
  const key = ws.home.root + ' ' + ws.items
    .map((i) => {
      const state = i.kind === 'task' ? taskState(ws, i) : i.status;
      return `${i.id}:${state}:${i.reviewed ?? ''}:${state === 'active' ? '' : i.updated}`;
    })
    .join(' ');
  if (kept?.key === key) return kept.brief;
  const b = morning(ws);
  // A question alone brings up no brief: the page asks it on its thread, and nowhere else.
  const needs = b.needsYou.plans.length + b.needsYou.stopped.length + b.needsYou.proposals.length;
  kept = { key, brief: b.shipped || needs ? b : null };
  return kept.brief;
}
