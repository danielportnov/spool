/**
 * Saying when a new thread looks like one already there.
 *
 * The same wish gets recorded twice: said again a week later, or in other
 * words by someone else. Each copy is a thread somebody has to read. So when
 * a thread is filed, its words are held up against the open threads, the ones
 * finished lately, and the ones dropped. This only says so: it never blocks
 * the filing and never merges anything. The agent decides.
 *
 * Lexical, like suggest.ts and the capture reply: `tokens` drops common words
 * and crude-stems the rest, no model, the same answer every time. A false
 * alarm on every thread would be worse than nothing, so the bar is high and
 * a thread must share most of its words, not just its subject.
 */

import { type Item, splitBody, tokens } from './model.ts';
import { type Paint, itemLine } from './render.ts';
import type { Workspace } from './store.ts';

/** The thresholds, in one place so they are easy to change. */
export const SIMILAR = {
  /** Words two threads must share. Two is a subject ("jump", "floaty"), three starts to be a wish. */
  minShared: 3,
  /** Of all the words either uses, the share they have in common (Dice). One wish put two ways clears this easily; two threads on one subject do not. */
  minDice: 0.6,
  /** Finished threads count for this long: what was done in the last few weeks may be exactly what is being asked for again. */
  doneDays: 28,
  /** Dropped threads count for longer: a no is worth knowing about. They are only a hint. */
  droppedDays: 90,
  /** Threads named at most. */
  shown: 3,
} as const;

export interface Similar {
  item: Item;
  /** Open threads can take the words; finished ones are a check; dropped ones are a hint. */
  how: 'open' | 'done' | 'dropped';
  /** Dropped threads: why, as the log says it. */
  why?: string;
}

/** A thread's own words: its title and the first line of what was said. The quoted note is left out, since threads cut from one note all carry it. */
function wordsOf(item: Item): Set<string> {
  const line = splitBody(item.body)
    .main.split('\n')
    .find((l) => l.trim() && !l.startsWith('>') && !l.startsWith('#'));
  return tokens(`${item.title} ${line ?? ''}`);
}

function droppedBecause(item: Item): string | undefined {
  for (const line of splitBody(item.body).log.reverse()) {
    const m = /^- \S+ \S+ .*?: dropped(?:: (.*))?$/.exec(line);
    if (m) return m[1]?.trim() || undefined;
  }
  return undefined;
}

/** Threads in the project that say what this new one says. Closest first. */
export function similarTo(ws: Workspace, task: Item): Similar[] {
  const mine = wordsOf(task);
  const now = ws.now().getTime();
  const days = (item: Item) => (now - Date.parse(item.updated)) / 86_400_000;
  const out: { match: Similar; score: number }[] = [];
  for (const other of ws.items) {
    if (other.kind !== 'task' || other.id === task.id) continue;
    // Cut from one note, they are parts of one message and not repeats of each other.
    if (other.from.some((id) => task.from.includes(id))) continue;
    const how = other.status === 'dropped' ? 'dropped' : other.status === 'done' ? 'done' : 'open';
    if (how === 'done' && days(other) > SIMILAR.doneDays) continue;
    if (how === 'dropped' && days(other) > SIMILAR.droppedDays) continue;
    const theirs = wordsOf(other);
    let shared = 0;
    for (const t of mine) if (theirs.has(t)) shared++;
    const score = (2 * shared) / (mine.size + theirs.size || 1);
    if (shared < SIMILAR.minShared || score < SIMILAR.minDice) continue;
    out.push({ match: { item: other, how, ...(how === 'dropped' ? { why: droppedBecause(other) } : {}) }, score });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, SIMILAR.shown)
    .map((m) => m.match);
}

/** What to say when the new thread looks like others: the thread, and what can be done about it. Never more than a nudge. */
export function similarLines(ws: Workspace, task: Item, similar: Similar[], p: Paint): string[] {
  if (!similar.length) return [];
  const note = task.from.find((id) => ws.find(id)?.kind === 'note');
  const out = ['', 'This looks like a thread already there:'];
  for (const m of similar) {
    out.push(`  ${itemLine(ws, m.item, p)}`);
    if (m.how === 'dropped') out.push(p.dim(`    this was dropped before${m.why ? `: ${m.why}` : ''}`));
    if (m.how === 'done') out.push(p.dim('    finished lately: check it does not already cover this'));
  }
  const open = similar.find((m) => m.how === 'open');
  if (open && note) out.push(p.dim(`  To add these words to ${open.item.id} instead: spool file ${note} --into ${open.item.id}, then spool drop ${task.id}`));
  out.push(p.dim('  Or leave it as it is.'));
  return out;
}
