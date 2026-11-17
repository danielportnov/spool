/**
 * What a pass over the backlog marked potentially irrelevant: a drop or an archive a run proposed
 * that the user has not answered, or a thread its worksheet named gone cold. Taking over leaves
 * these (takeover.ts), and stops once nothing else is left; the worksheet (manage.ts) names the
 * cold by the same rule.
 */

import { readJournal } from './journal.ts';
import { type Item, type Spool, isRun, splitBody } from './model.ts';
import { readProposals, unanswered } from './proposals.ts';
import { taskState, tasks } from './schedule.ts';
import type { Workspace } from './store.ts';

/** Proposed, and untouched this many days, is cold. */
export const COLD_DAYS = 30;

const DAY = 86_400_000;

/** The minutes a thread's log was written in, YYYY-MM-DDTHH:MM, each with when. */
function minutesOf(item: Item): { at: number; minute: string }[] {
  const out: { at: number; minute: string }[] = [];
  for (const line of splitBody(item.body).log) {
    const m = /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d(?::\d\d)?)Z [^:]+: /.exec(line);
    if (m) out.push({ at: Date.parse(`${m[1]}T${m[2]}Z`), minute: `${m[1]}T${m[2]!.slice(0, 5)}` });
  }
  return out;
}

/** When someone other than a run last touched a thread: a run's own sizing must not keep a thread warm for ever. */
function touched(t: Item, byRuns: Map<string, Set<string>>): number {
  const minutes = byRuns.get(t.id);
  if (!minutes?.has(t.updated.slice(0, 16))) return Date.parse(t.updated);
  const own = minutesOf(t).filter((n) => !minutes.has(n.minute)).at(-1);
  return Math.max(Date.parse(t.created), own?.at ?? 0);
}

/** The proposed threads gone cold by `now`, untouched for COLD_DAYS or more but by a run's own sizing, and for how many days. */
export function coldDays(ws: Workspace, open: Item[], runs: Item[], journals: Map<string, { entries: { item: string; at: string }[] }>, now = ws.now()): Map<string, number> {
  // Only a run from the last weeks can be what last touched a thread that might still be warm.
  const byRuns = new Map<string, Set<string>>();
  for (const r of runs.filter((r) => now.getTime() - Date.parse(r.created) < (COLD_DAYS + 1) * DAY)) {
    for (const entry of journals.get(r.id)?.entries ?? []) byRuns.set(entry.item, (byRuns.get(entry.item) ?? new Set()).add(entry.at.slice(0, 16)));
  }
  const out = new Map<string, number>();
  for (const t of open.filter((t) => taskState(ws, t) === 'proposed')) {
    const days = Math.floor((now.getTime() - touched(t, byRuns)) / DAY);
    if (days >= COLD_DAYS) out.set(t.id, days);
  }
  return out;
}

/**
 * The threads a pass marked potentially irrelevant, and why: a drop or an archive a run proposed
 * that the user has not answered, or named gone cold on the last pass's worksheet. Touched since
 * that pass, a thread is warm again. An undone run marks nothing.
 */
export function potentiallyIrrelevant(ws: Workspace, spool: Spool): Map<string, string> {
  const runs = tasks(ws, spool).filter(isRun).sort((a, b) => b.created.localeCompare(a.created));
  const journals = new Map(runs.map((r) => [r.id, readJournal(r)]));
  const out = new Map<string, string>();
  for (const r of runs) {
    if (journals.get(r.id)!.undone) continue;
    for (const p of unanswered(readProposals(r))) if (p.verb !== 'build' && !out.has(p.id)) out.set(p.id, `${r.id} proposes to ${p.verb} it`);
  }
  const last = runs[0];
  if (!last) return out;
  const open = tasks(ws, spool).filter((t) => !isRun(t) && t.status === 'proposed');
  for (const [id, days] of coldDays(ws, open, runs, journals, new Date(last.updated))) {
    if (!out.has(id)) out.set(id, `gone cold, untouched for ${days} days when ${last.id} looked`);
  }
  return out;
}
