/** Link a Git undo to the threads whose work it takes back. */
import { git, isReverted, repoRoot, trailerCommits } from './git.ts';
import { journaled } from './journal.ts';
import { type Item, SpoolError, addLog, oneLine } from './model.ts';
import { revertCommits } from './revert.ts';
import { dependents } from './schedule.ts';
import type { Workspace } from './store.ts';
import { landingLock } from './worktree.ts';

function shasFor(root: string, task: Item): string[] {
  return [...new Set([...task.commits, ...trailerCommits(root, task.id)])];
}

function trailers(root: string, sha: string, key: string): string[] {
  const words = git(root, ['show', '-s', `--format=%(trailers:key=${key},valueonly)`, sha]).out;
  return words.split('\n').map((line) => line.trim()).filter(Boolean);
}

function projectQueues(ws: Workspace, root: string) {
  return ws.spools.filter((spool) => repoRoot(spool.root) === root);
}

/** A landing holds this before opening the queue. With the queue held, only try once. */
export function withUndoLock<T>(task: Item, undo: () => T): T {
  const root = repoRoot(task.spool.root);
  let release: (() => void) | undefined;
  try {
    release = root ? landingLock(root, task.id, 0) : undefined;
  } catch (error) {
    if (!(error instanceof SpoolError)) throw error;
    throw new SpoolError(error.message.replace(/, after 0 second\(s\) of waiting$/, ''),
      'Nothing was changed. Run your undo again when the landing finishes.');
  }
  try {
    return undo();
  } finally {
    release?.();
  }
}

/** Calls made for this thread alone, and never confirmed by the human, go with its work. */
function recordUndo(ws: Workspace, task: Item, actor: string, reverted: string[], commit?: string): Item[] {
  const voided = task.needs
    .map((id) => ws.find(id))
    .filter((d): d is Item => !!d && d.kind === 'decision' && d.status === 'assumed' && dependents(ws, d).every((x) => x === task));
  for (const d of voided) {
    d.status = 'dropped';
    addLog(d, actor, `dropped: ${task.id}, the work built on it, was reverted`, ws.now());
    ws.save(d);
  }
  task.needs = task.needs.filter((id) => !voided.some((d) => d.id === id));
  if (reverted.length || !task.revert) {
    task.reverted = reverted;
    task.revert = commit;
  }
  task.commits = [];
  return voided;
}

/** Take back what a thread did, with any requested and proven later blockers. */
export function undoWork(ws: Workspace, task: Item, actor: string, why: string, withLater = false) {
  const later: { task: Item; reverted: string[] }[] = [];
  let reverted: string[] = [];
  let skipped: { sha: string; why: string }[] = [];
  let commit: string | undefined;
  const root = repoRoot(task.spool.root);
  const shas = root ? shasFor(root, task) : [];
  if (root && shas.length) {
    const queues = projectQueues(ws, root);
    const recorded = new Map<string, Item[]>();
    for (const t of ws.items.filter((i) => i.kind === 'task' && queues.includes(i.spool))) {
      for (const sha of t.commits) recorded.set(sha, [...(recorded.get(sha) ?? []), t]);
    }
    const owners = (sha: string) => {
      const tags = trailers(root, sha, 'Spool');
      const named = tags.map((tag) => ws.find(tag)).filter((t): t is Item => !!t && t.kind === 'task' && queues.includes(t.spool));
      return { tags, matches: [...new Set([...(recorded.get(sha) ?? []), ...named])], unknown: tags.some((id) => !named.some((t) => t.id === id)) };
    };
    const added = new Map<string, Item>();
    const result = revertCommits(root, shas, {
      spoolDirs: queues.map((spool) => spool.dir),
      withLater,
      message: (undone) => [
        `Revert "${task.title}"`,
        ...(why ? [why] : []),
        undone.map((sha) => `This reverts commit ${sha}.`).join('\n'),
        [...new Set([task, ...undone.flatMap((sha) => added.get(sha) ?? [])])].map((t) => `Spool-Revert: ${t.id}`).join('\n'),
      ].join('\n\n'),
      conflict: ({ commits }) => {
        const explain: string[] = [];
        const threads = new Set<Item>();
        let safe = !!commits.length;
        for (const sha of commits) {
          const { tags, matches, unknown } = owners(sha);
          if (matches.length === 1 && !unknown) {
            const owner = matches[0]!;
            explain.push(`  ${sha.slice(0, 7)}: ${owner.id} ${oneLine(owner.title, 100)}`);
            if (owner !== task && owner.status === 'done' && (!owner.type || owner.type === 'change') && !owner.worktree && !journaled(owner)) {
              threads.add(owner);
            } else {
              safe = false;
            }
          } else {
            const labels = [...new Set([...tags, ...matches.map((t) => t.id)])];
            explain.push(`  ${sha.slice(0, 7)}: ${labels.length ? `unverified thread ownership (${labels.join(', ')})` : 'no Spool thread on record'}`);
            safe = false;
          }
        }
        if (explain.length) explain.unshift('Later commits in the way:');
        if (!safe) {
          explain.push('Spool could not verify finished later work to undo together.');
          return { explain };
        }
        const add = new Map<string, Item>();
        for (const owner of threads) {
          for (const sha of shasFor(root, owner)) {
            if (isReverted(root, sha)) continue;
            const { matches, unknown } = owners(sha);
            if (unknown || matches.length !== 1 || matches[0] !== owner) {
              explain.push(`Some commits on ${owner.id} do not have verified ownership.`);
              return { explain };
            }
            add.set(sha, owner);
          }
        }
        for (const [sha, owner] of add) added.set(sha, owner);
        return { explain, add: [...add.keys()], hint: `To undo the later threads too: spool revert ${task.id} --with-later` };
      },
    });
    if (!result.ok) throw new SpoolError(`could not revert ${task.id}: ${result.error}`);
    ({ skipped, commit } = result);
    const undone = new Map<Item, string[]>();
    for (const sha of result.reverted) {
      const owner = added.get(sha) ?? task;
      undone.set(owner, [...(undone.get(owner) ?? []), sha]);
    }
    reverted = undone.get(task) ?? [];
    for (const [t, shas] of undone) if (t !== task) later.push({ task: t, reverted: shas });
  }

  const voided = recordUndo(ws, task, actor, reverted, commit);
  for (const row of later) {
    const t = row.task;
    voided.push(...recordUndo(ws, t, actor, row.reverted, commit));
    t.status = 'proposed';
    t.by = undefined;
    t.place = undefined;
    t.summary = undefined;
    t.reviewed = undefined;
    t.priority = Math.min(t.priority ?? 2, 1);
    addLog(t, actor, `reverted ${row.reverted.length} commit(s) with ${task.id} because its undo conflicted with this work${why ? `: ${why}` : ''}`, ws.now());
    ws.save(t);
  }
  return { reverted, skipped, voided, commit, later };
}

/** A shared undo is one commit, so every participating thread must be ready to be restored. */
export function restoreWork(ws: Workspace, task: Item, why: string) {
  const root = repoRoot(task.spool.root);
  if (!root) throw new SpoolError(`${task.id} cannot be put back: this is not a git repository`);
  const sha = task.revert!;
  const queues = projectQueues(ws, root);
  const ids = [...new Set(trailers(root, sha, 'Spool-Revert'))];
  if (ids.length > 1 && !ids.includes(task.id)) {
    throw new SpoolError(`could not put ${task.id} back: its thread is missing from the shared undo. Nothing was changed.`);
  }
  const group = ids.length > 1 ? ids : [task.id];
  const members = group.map((id) => {
    const t = ws.find(id);
    if (!t || t.kind !== 'task' || !queues.includes(t.spool) || t.revert !== sha || t.commits.length ||
      (t.status !== 'open' && t.status !== 'proposed') || (group.length > 1 && (t.worktree || !t.reverted.length))) {
      throw new SpoolError(`could not put ${task.id} back: ${id} has changed since the shared undo. Nothing was changed.`);
    }
    return t;
  });
  const first = members[0]!;
  const result = revertCommits(root, [sha], {
    spoolDirs: queues.map((spool) => spool.dir),
    message: (undone) => [
      `Put back "${first.title}"`,
      ...(why ? [why] : []),
      undone.map((sha) => `This reverts commit ${sha}.`).join('\n'),
      group.map((id) => `Spool-Restore: ${id}`).join('\n'),
    ].join('\n\n'),
  });
  if (!result.ok || !result.reverted.includes(sha)) {
    throw new SpoolError(`could not put ${task.id} back: ${result.error ?? result.skipped[0]?.why ?? 'the revert is missing'}`);
  }
  return { result, members };
}
