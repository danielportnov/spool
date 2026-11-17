/**
 * What a manager's run proposes, and what the human said to each.
 *
 * A run may not drop what it thinks has shipped, or build, without a leave. What it would do
 * goes on its thread as a numbered proposal: a verb, the thread it is about, and the run's own
 * reason. The human says yes or no to each, on the run's ticket or with `spool manage --answer`,
 * and a yes runs that verb as them, with the run's reason. Questions are not asked here: a
 * question lives on its own thread. This is the one place a run's changes wait for a word.
 *
 * They are kept beside the run's journal, `.spool/runs/<id>/proposals.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, oneLine } from './model.ts';

/** What a proposal can be: the verbs that put a thread out of the way or into work, and nothing wider. */
export const PROPOSABLE = ['drop', 'archive', 'build'] as const;
export type Verb = (typeof PROPOSABLE)[number];

export interface Proposal {
  n: number;
  verb: Verb;
  /** The thread it is about. */
  id: string;
  title: string;
  /** The run's reason: what the thread is dropped with, if the human says yes. */
  reason: string;
  /** What the human said, and when. Absent: not answered yet. */
  answer?: { by: string; at: string; said: 'yes' | 'no' };
}

function fileOf(run: Item): string {
  return path.join(run.spool.dir, 'runs', run.id, 'proposals.json');
}

export function readProposals(run: Item): Proposal[] {
  try {
    const all = JSON.parse(fs.readFileSync(fileOf(run), 'utf8')) as Proposal[];
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

export function writeProposals(run: Item, all: Proposal[]): void {
  fs.mkdirSync(path.dirname(fileOf(run)), { recursive: true });
  fs.writeFileSync(fileOf(run), `${JSON.stringify(all, null, 2)}\n`);
}

/** Those still waiting for a word. */
export const unanswered = (all: Proposal[]): Proposal[] => all.filter((p) => !p.answer);

const VERBS: Record<Verb, string> = { drop: 'Drop', archive: 'Archive', build: 'Build' };

/** One proposal as a line: the verb, the thread, and why. */
export function proposalLine(p: Proposal): string {
  return `${VERBS[p.verb]} ${p.id} “${oneLine(p.title, 60)}”${p.reason ? `: ${p.reason}` : ''}`;
}
