/**
 * What a manager's run proposes, and what the user said to each.
 *
 * A run may not drop what it thinks has shipped, or build, without a leave. What it would do
 * goes on its thread as a numbered proposal: a verb, the thread it is about, and the run's own
 * reason. The user says yes or no to each, on the run's ticket or with `spool manage --answer`,
 * and a yes runs that verb as them, with the run's reason. Questions are not asked here: a
 * question lives on its own thread. This is the one place a run's changes wait for a word.
 *
 * They are kept beside the run's journal, `.spool/runs/<id>/proposals.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, oneLine } from './model.ts';

/**
 * What a proposal can be: the verbs that put a thread out of the way or into work, and the three an
 * overview of the whole project makes: new goals, a sprint drafted, and an order for a running sprint.
 */
export const PROPOSABLE = ['drop', 'archive', 'build', 'goals', 'sprint', 'order'] as const;
export type Verb = (typeof PROPOSABLE)[number];

/** A sprint as an overview drafts it: made, planned and never played, only on the user's yes. */
export interface SprintDraft {
  name: string;
  goal: string;
  why: string;
  doneWhen: string;
  threads: string[];
}

export interface Proposal {
  n: number;
  verb: Verb;
  /** The thread it is about; for an order, the sprint; for goals or a new sprint, nothing. */
  id: string;
  title: string;
  /** The run's reason: what the thread is dropped with, if the user says yes. */
  reason: string;
  /** For goals: the whole page, as it would be kept. */
  goals?: string;
  /** For a sprint: what it would be made with. */
  sprint?: SprintDraft;
  /** For an order: the sprint's threads, first built first. */
  order?: string[];
  /** What the user said, and when. Absent: not answered yet. */
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

const VERBS: Record<Verb, string> = { drop: 'Drop', archive: 'Archive', build: 'Build', goals: 'Set the goals', sprint: 'Draft the sprint', order: 'Order the sprint' };

/** One proposal as a line: the verb, what it is about, and why. */
export function proposalLine(p: Proposal): string {
  const why = p.reason ? `: ${p.reason}` : '';
  if (p.verb === 'goals') return `${VERBS.goals} to “${oneLine((p.goals ?? '').replace(/^#.*$/gm, ' '), 90)}”${why}`;
  if (p.verb === 'sprint') {
    const s = p.sprint!;
    return `${VERBS.sprint} “${oneLine(s.name, 50)}”, ${oneLine(s.goal, 70)}, with ${s.threads.join(', ') || 'no threads yet'}${why}`;
  }
  if (p.verb === 'order') return `${VERBS.order} “${oneLine(p.title, 50)}” as ${(p.order ?? []).join(', ')}${why}`;
  return `${VERBS[p.verb]} ${p.id} “${oneLine(p.title, 60)}”${why}`;
}

/** What two proposals have to share to be the same one: the verb and what it is about. */
export function proposalKey(p: Pick<Proposal, 'verb' | 'id' | 'sprint'>): string {
  if (p.verb === 'goals') return 'goals';
  if (p.verb === 'sprint') return `sprint ${p.sprint!.name.toLowerCase()}`;
  return `${p.verb} ${p.id}`;
}

/** What a proposal from an overview holds beyond its line, for the user to read before a yes: the page, the sprint, the order. */
export function proposalDetail(p: Proposal, titleOf: (id: string) => string | undefined): string | null {
  const named = (id: string) => `${id} ${oneLine(titleOf(id) ?? '', 80)}`.trim();
  if (p.verb === 'goals') return p.goals?.trim() || null;
  if (p.verb === 'sprint' && p.sprint) {
    const s = p.sprint;
    return [`Goal: ${s.goal}`, s.why ? `Why: ${s.why}` : '', s.doneWhen ? `Done when: ${s.doneWhen}` : '', ...s.threads.map((id) => `- ${named(id)}`)].filter(Boolean).join('\n');
  }
  if (p.verb === 'order') return (p.order ?? []).map((id, i) => `${i + 1}. ${named(id)}`).join('\n');
  return null;
}
