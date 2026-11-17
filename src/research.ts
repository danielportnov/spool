/**
 * Research: the project's memory of what agents went and found out.
 *
 * A research thread builds nothing. Its agent looks a topic up, with whatever
 * it can reach, and hands in a report that starts with a short summary. The
 * report is kept with the others in `.spool/reports/`, in git with the rest of
 * the spool, and this is what makes it findable afterwards: every worker's
 * context lists what is on record, and a brief names the research that shares
 * its words, so the next agent reads what was learned instead of looking again.
 *
 * Lexical, like similar.ts: shared words, no model, the same answer every time.
 */

import * as fs from 'node:fs';
import { type Item, type Spool, firstLine, oneLine, overlap, reportFile, tokens } from './model.ts';
import type { Workspace } from './store.ts';
import { wordsOf } from './similar.ts';

export const RESEARCH = {
  /** Listed in a worker's context at most, newest first. */
  listed: 8,
  /** Named in a brief at most. */
  shown: 3,
  /** Words a thread must share with research for the brief to name it. A topic is fewer words than a wish. */
  minShared: 2,
} as const;

/** The text of a thread's report, or nothing. */
export function reportText(item: Item): string {
  try {
    return fs.readFileSync(reportFile(item), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Finished research with a report, newest first: in one project, or in all of them. */
export function researchOnRecord(ws: Workspace, spool?: Spool): Item[] {
  return ws.items
    .filter((i) => i.kind === 'task' && i.type === 'research' && i.status === 'done' && (!spool || i.spool === spool))
    .filter((i) => fs.existsSync(reportFile(i)))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

/** The words research is found by: its title and what it found, in short. */
function researchWords(item: Item): Set<string> {
  return tokens(`${item.title} ${item.summary ?? ''}`);
}

/** Research on record that shares enough words with a thread to be worth reading first. */
export function researchFor(ws: Workspace, task: Item): Item[] {
  const mine = wordsOf(task);
  return researchOnRecord(ws)
    .filter((r) => r !== task)
    .map((r) => ({ r, n: overlap(mine, researchWords(r)) }))
    .filter((x) => x.n >= RESEARCH.minShared)
    .sort((a, b) => b.n - a.n)
    .slice(0, RESEARCH.shown)
    .map((x) => x.r);
}

/** One line for a piece of research: what it was about, and what it found. */
export function researchLine(item: Item): string {
  return `${item.id}  ${oneLine(item.title, 70)}${item.summary ? ` — ${oneLine(firstLine(item.summary), 90)}` : ''}`;
}

/** What a worker's context says of the project's research, or nothing when there is none. */
export function researchSection(ws: Workspace): string {
  const all = researchOnRecord(ws);
  if (!all.length) return '';
  const lines = [
    `RESEARCH ON RECORD  ${all.length} — what agents found out before. Read the one your thread touches: spool show <id> --report`,
    ...all.slice(0, RESEARCH.listed).map((r) => `  ${researchLine(r)}`),
  ];
  if (all.length > RESEARCH.listed) lines.push(`  … and ${all.length - RESEARCH.listed} more: spool list --research`);
  return `${lines.join('\n')}\n`;
}
