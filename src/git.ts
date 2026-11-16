/**
 * Git: the undo button.
 *
 * Agents end each commit message with a `Spool: <task-id>` trailer. That one
 * line ties work to the task that asked for it, survives rebases (unlike a
 * recorded hash), and lets `spool revert` take back everything a task did.
 *
 * Reverting is built to be used on a live repository — one where the queue
 * has uncommitted changes and an agent may be halfway through something else:
 *
 *   - It reverses only the files the task's commits changed, and only those
 *     files have to be clean.
 *   - It never reads or writes the spool directory. The queue is a record of
 *     what happened; undoing the code does not rewrite the record.
 *   - It is all or nothing. If any commit cannot be peeled off cleanly, every
 *     file is put back as it was and nothing is committed.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BUFFER = 1024 * 1024 * 1024;

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(cwd: string, args: string[], input?: Buffer): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    input,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return {
    ok: result.status === 0,
    out: (result.stdout?.toString('utf8') ?? '').trim(),
    err: (result.stderr?.toString('utf8') ?? '').trim(),
  };
}

export function repoRoot(dir: string): string | null {
  const result = git(dir, ['rev-parse', '--show-toplevel']);
  return result.ok && result.out ? result.out : null;
}

/** Git reports real paths; resolve ours the same way so the two can be compared. */
function real(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

export function resolveCommit(root: string, ref: string): string | null {
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.ok && result.out ? result.out : null;
}

/** Commits on the current branch whose message carries the trailer for `id`, newest first. */
export function trailerCommits(root: string, id: string): string[] {
  const result = git(root, ['log', '--format=%H', '-E', `--grep=^Spool: ${id}[[:space:]]*$`]);
  return result.ok && result.out ? result.out.split('\n') : [];
}

/** Has a later commit on this branch already taken `sha` back? */
export function isReverted(root: string, sha: string): boolean {
  return !!git(root, ['log', '-1', '--format=%H', '-F', `--grep=This reverts commit ${sha}`]).out;
}

/** The pathspec for everything in the repository but the spool directory. */
function outside(root: string, spoolDir: string): string[] {
  const keep = path.relative(real(root), real(spoolDir)).split(path.sep).join('/');
  return ['--', ':(top)', ...(keep && !keep.startsWith('..') ? [`:(top,exclude)${keep}`] : [])];
}

/** Files with uncommitted changes, tracked or new, outside the spool directory. */
export function dirtyPaths(root: string, spoolDir: string): string[] | null {
  const result = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', ...outside(root, spoolDir)]);
  if (!result.ok) return null;
  return result.out
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

/**
 * Throw away the uncommitted changes to `paths`: a file HEAD has goes back to
 * how HEAD has it, a file HEAD does not have is deleted.
 */
export function discardPaths(root: string, paths: string[]): void {
  if (!paths.length) return;
  const literal = ['--', ...paths.map((p) => `:(top,literal)${p}`)];
  const probe = git(root, ['cat-file', '--batch-check'], Buffer.from(paths.map((p) => `HEAD:${p}\n`).join('')));
  const inHead = probe.out.split('\n').map((line) => !line.endsWith(' missing'));
  const existed = paths.filter((_, i) => inHead[i]);
  const created = paths.filter((_, i) => !inHead[i]);
  git(root, ['reset', '-q', ...literal]);
  if (existed.length) git(root, ['checkout', 'HEAD', '--', ...existed.map((p) => `:(top,literal)${p}`)]);
  for (const p of created) fs.rmSync(path.join(root, p), { force: true });
}

export interface RevertResult {
  ok: boolean;
  /** Commits undone by the new revert commit, newest first. */
  reverted: string[];
  /** Commits left alone, with the reason. */
  skipped: { sha: string; why: string }[];
  error?: string;
}

/**
 * Undo `shas` in one new commit, leaving the spool directory out of it.
 * `message` is given the commits that were actually reverted.
 */
export function revertCommits(
  root: string,
  shas: string[],
  spoolDir: string,
  message: (reverted: string[]) => string,
): RevertResult {
  const result: RevertResult = { ok: false, reverted: [], skipped: [] };
  const keep = path.relative(real(root), real(spoolDir)).split(path.sep).join('/');
  const outsideQueue = ['--', ':(top)', ...(keep && !keep.startsWith('..') ? [`:(top,exclude)${keep}`] : [])];
  const literal = (paths: string[]) => ['--', ...paths.map((p) => `:(top,literal)${p}`)];
  const list = (out: string) => out.split('\0').filter(Boolean);

  // History order, newest first, is the only safe order to peel commits off in.
  const history = git(root, ['rev-list', '--topo-order', 'HEAD']);
  const position = new Map((history.out ? history.out.split('\n') : []).map((sha, i) => [sha, i]));
  const plan: { sha: string; parent: string; paths: string[] }[] = [];
  for (const sha of new Set(shas)) {
    if (!position.has(sha)) result.skipped.push({ sha, why: 'not on this branch' });
    else if (isReverted(root, sha)) result.skipped.push({ sha, why: 'already reverted' });
    else {
      const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]).out.split(' ').slice(1);
      if (parents.length > 1) {
        result.skipped.push({ sha, why: 'is a merge' });
        continue;
      }
      const parent = parents[0] ?? EMPTY_TREE;
      const paths = list(git(root, ['diff', '--no-renames', '--name-only', '-z', sha, parent, ...outsideQueue]).out);
      if (paths.length) plan.push({ sha, parent, paths });
      else result.skipped.push({ sha, why: 'only touched the queue' });
    }
  }
  plan.sort((a, b) => position.get(a.sha)! - position.get(b.sha)!);
  const touched = [...new Set(plan.flatMap((step) => step.paths))];
  if (!touched.length) return { ...result, ok: true };

  const dirty = git(root, ['status', '--porcelain', ...literal(touched)]);
  if (!dirty.ok) return { ...result, error: dirty.err || 'git status failed' };
  if (dirty.out) {
    return { ...result, error: `uncommitted changes in the way:\n${dirty.out}\nCommit or stash them, then revert again.` };
  }

  const putBack = (): void => {
    const probe = git(root, ['cat-file', '--batch-check'], Buffer.from(touched.map((p) => `HEAD:${p}\n`).join('')));
    const inHead = probe.out.split('\n').map((line) => !line.endsWith(' missing'));
    const existed = touched.filter((_, i) => inHead[i]);
    const created = touched.filter((_, i) => !inHead[i]);
    if (existed.length) git(root, ['checkout', 'HEAD', ...literal(existed)]);
    if (created.length) {
      git(root, ['reset', '-q', ...literal(created)]);
      for (const p of created) fs.rmSync(path.join(root, p), { force: true });
    }
  };

  for (const step of plan) {
    // The reverse of the commit, as a patch, minus anything it did to the queue.
    const patch = spawnSync(
      'git',
      [
        'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
        '--src-prefix=a/', '--dst-prefix=b/', step.sha, step.parent, ...outsideQueue,
      ],
      { cwd: root, maxBuffer: MAX_BUFFER },
    );
    const applied =
      patch.status === 0 ? git(root, ['apply', '--3way', '--index', '--whitespace=nowarn', '-'], patch.stdout) : null;
    if (!applied?.ok) {
      const conflicts = list(git(root, ['diff', '--name-only', '-z', '--diff-filter=U']).out);
      putBack();
      const where = conflicts.length ? `\n${conflicts.join('\n')}` : ` (${applied?.err || 'git diff failed'})`;
      return {
        ...result,
        reverted: [],
        error:
          `reverting ${step.sha.slice(0, 7)} conflicts with later work in:${where}\n` +
          'Nothing was changed. Undo it by hand, or queue the undo as a task.',
      };
    }
    result.reverted.push(step.sha);
  }

  if (git(root, ['diff', '--cached', '--quiet', ...literal(touched)]).ok) {
    // The commits cancel out against what is there now; there is nothing to record.
    return { ...result, ok: true };
  }
  const made = git(root, ['commit', '--quiet', '-m', message(result.reverted), ...literal(touched)]);
  if (!made.ok) {
    putBack();
    return { ...result, reverted: [], error: `git would not commit the revert: ${made.err}\nNothing was changed.` };
  }
  return { ...result, ok: true };
}
