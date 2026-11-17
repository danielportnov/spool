/**
 * Lineage that can travel with the repo: a short git note on each commit a thread landed, under
 * refs/notes/spool, saying which thread it was for, who built it on what, and the calls made for it.
 *
 * `.spool/` is private and stays off git, so from a clone the trailers carry ids and nothing more.
 * A note carries the chain in words, built from the same record as `spool why`. It holds only the
 * thread's title, its calls and who built it: never the user's notes, the activity log, summaries,
 * transcripts or anything under `.spool/`. Notes stay on this machine. Pushing them is the user's call.
 */

import { git, repoRoot } from './git.ts';
import { type Lineage, threadLineage } from './lineage.ts';
import type { Item } from './model.ts';
import type { Workspace } from './store.ts';

export const NOTES_REF = 'refs/notes/spool';
export const PUSH_NOTES = `git push origin ${NOTES_REF}`;

type Commit = Lineage['commits'][number];

/** One line, short, and with nothing that points into the private `.spool/` folder. */
function clean(text: string | undefined, max = 160): string {
  const line = (text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/(?:[\w.~-]*\/)*\.spool\/\S*/g, '(private)')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stateOf(lineage: Lineage): string {
  const state = lineage.thread?.state ?? 'unknown';
  if (state === 'done') return lineage.reverts.length ? 'done, put back after it was undone' : 'done';
  return lineage.reverts.length ? `undone, now ${state}` : state;
}

/** What a thread's part of a commit's note says. The first line names the thread, so parts can be told apart. */
export function noteBlock(lineage: Lineage, commit: Commit): string {
  const thread = lineage.thread!;
  const lines = [`Spool ${thread.id}: ${clean(thread.title)}`];
  lines.push(`State: ${[stateOf(lineage), thread.version && `version ${clean(thread.version, 40)}`].filter(Boolean).join(' · ')}`);
  const isUndo = lineage.reverts.some((c) => c.sha === commit.sha);
  if (isUndo) {
    lines.push(commit.restores.includes(thread.id) ? 'This commit put the work back.' : 'This commit undid the work.');
  }
  const who = clean(commit.agent || commit.coauthors[0], 80);
  if (who) lines.push(`Built by: ${[who, clean(commit.model, 60)].filter(Boolean).join(' · ')}`);
  for (const call of lineage.calls) {
    lines.push(`Call ${call.id}: ${clean(call.title)}${call.choice ? ` → ${clean(call.choice, 100)}` : ''} (${call.status})`);
  }
  if (!isUndo) {
    for (const c of lineage.reverts) lines.push(`${c.restores.includes(thread.id) ? 'Put back by' : 'Undone by'} ${c.sha.slice(0, 12)}`);
  }
  return lines.join('\n');
}

function readNote(root: string, sha: string): string | undefined {
  const shown = git(root, ['notes', `--ref=${NOTES_REF}`, 'show', sha]);
  return shown.ok ? shown.raw.replace(/\n+$/, '') : undefined;
}

/** The note with this thread's part put in, or added, and every other thread's part kept. */
export function mergeNote(existing: string | undefined, id: string, block: string): string {
  const blocks = (existing ?? '').split(/\n{2,}/).filter((b) => b.trim());
  const at = blocks.findIndex((b) => b.startsWith(`Spool ${id}:`));
  if (at >= 0) blocks[at] = block;
  else blocks.push(block);
  return blocks.join('\n\n');
}

/**
 * Write the notes for one thread's commits and the commits that undid or put back its work.
 * Returns how many notes changed. Run again with nothing new, it changes none. Never throws:
 * a note is a convenience, and a refusal from git must not stop the work it describes.
 */
export function noteThread(ws: Workspace, task: Item): number {
  try {
    const root = repoRoot(task.spool.root);
    if (!root) return 0;
    const lineage = threadLineage(ws, task, root);
    let written = 0;
    for (const commit of [...lineage.commits, ...lineage.reverts]) {
      const existing = readNote(root, commit.sha);
      const note = mergeNote(existing, task.id, noteBlock(lineage, commit));
      if (note === existing) continue;
      if (git(root, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', '-', commit.sha], Buffer.from(`${note}\n`)).ok) written++;
    }
    return written;
  } catch {
    return 0;
  }
}

/** The threads that have landed something: done, or undone with a commit on record. */
export function landedThreads(ws: Workspace): Item[] {
  return ws.items.filter((i) => i.kind === 'task' && (i.commits.length > 0 || i.reverted.length > 0 || !!i.revert));
}

/** How many commits in this repository carry a Spool note. */
export function noteCount(root: string): number {
  const listed = git(root, ['notes', `--ref=${NOTES_REF}`, 'list']);
  return listed.ok ? listed.out.split('\n').filter(Boolean).length : 0;
}

/** What one thread's notes say, commit by commit, without writing anything. */
export function threadNotes(ws: Workspace, task: Item): { sha: string; note: string }[] {
  const root = repoRoot(task.spool.root);
  if (!root) return [];
  const lineage = threadLineage(ws, task, root);
  return [...lineage.commits, ...lineage.reverts].map((c) => ({ sha: c.sha, note: noteBlock(lineage, c) }));
}
