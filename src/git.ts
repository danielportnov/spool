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
  /** What git printed, exactly: for output where a leading space means something. */
  raw: string;
  err: string;
}

export function git(
  cwd: string,
  args: string[],
  input?: Buffer,
  env?: Record<string, string>,
  limits?: { maxBuffer: number; timeout: number },
): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    input,
    maxBuffer: limits?.maxBuffer ?? MAX_BUFFER,
    timeout: limits?.timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  });
  return {
    ok: result.status === 0,
    out: (result.stdout?.toString('utf8') ?? '').trim(),
    raw: result.stdout?.toString('utf8') ?? '',
    err: (result.stderr?.toString('utf8') ?? '').trim() || result.error?.message || '',
  };
}

export function repoRoot(dir: string): string | null {
  const result = git(dir, ['rev-parse', '--show-toplevel']);
  return result.ok && result.out ? result.out : null;
}

/** Git reports real paths; resolve ours the same way so the two can be compared. */
export function real(file: string): string {
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

/** A line at the foot of a commit message: `Spool: t-x7k2`. With `once`, a commit that has the key at all keeps its own. */
export interface Trailer {
  key: string;
  value: string;
  once?: boolean;
}

/** Who wrote a commit, or committed it, and when, as its header has it: "Ann <ann@x.org> 1700000000 +0100". */
const IDENT = /^(.*) <(.*)> (\d+ [+-]\d{4})$/;

/**
 * Put `trailers` at the foot of every commit in `base..HEAD` of the checkout at `dir`, and move
 * its branch to the result. Each commit keeps its tree, its author and its committer, dates and
 * all: only the message gains the lines it lacks. A trailer already there with that value is not
 * added again; where `once` is set for a key, a commit that has that key at all keeps its own.
 * The branch is moved only once every commit is made, so a failure changes nothing.
 */
export function stampCommits(dir: string, base: string, trailers: Trailer[]): { ok: true; changed: number } | { ok: false; error: string } {
  const shas = git(dir, ['rev-list', '--reverse', '--topo-order', `${base}..HEAD`]).out.split('\n').filter(Boolean);
  const wanted = trailers.filter((t) => t.key && t.value.trim());
  if (!shas.length || !wanted.length) return { ok: true, changed: 0 };
  const line = (t: Trailer): string => `${t.key}: ${t.value.replace(/\s+/g, ' ').trim()}`;
  const sign = git(dir, ['config', '--bool', 'commit.gpgsign']).out === 'true' ? ['-S'] : [];
  const old = shas.at(-1)!;
  let parent = base;
  let changed = 0;
  for (const sha of shas) {
    const raw = git(dir, ['cat-file', 'commit', sha]).raw;
    const cut = raw.indexOf('\n\n');
    const head = cut < 0 ? raw : raw.slice(0, cut);
    const message = cut < 0 ? '' : raw.slice(cut + 2);
    const fields = new Map<string, string[]>();
    for (const line of head.split('\n')) {
      const at = line.indexOf(' ');
      if (at > 0 && !line.startsWith(' ')) fields.set(line.slice(0, at), [...(fields.get(line.slice(0, at)) ?? []), line.slice(at + 1)]);
    }
    // Which are there is worked out here: git matches a key by its start, so to it "Spool" is already "Spool-Agent".
    const there = git(dir, ['interpret-trailers', '--parse', '--no-divider'], Buffer.from(message)).out.split('\n').filter(Boolean);
    const has = (t: Trailer): boolean =>
      there.some((l) => (t.once ? l.toLowerCase().startsWith(`${t.key.toLowerCase()}:`) : l.toLowerCase() === line(t).toLowerCase()));
    const flags = wanted.filter((t) => !has(t)).flatMap((t) => ['--trailer', line(t)]);
    const stamped = flags.length
      ? git(dir, ['interpret-trailers', '--no-divider', '--if-exists', 'add', '--if-missing', 'add', ...flags], Buffer.from(message))
      : { ok: true, raw: message, err: '' };
    if (!stamped.ok) return { ok: false, error: `git could not add the trailers to ${sha.slice(0, 7)}: ${stamped.err}` };
    const parents = fields.get('parent') ?? [];
    if (stamped.raw === message && parents.length === 1 && parents[0] === parent) {
      parent = sha;
      continue;
    }
    const author = IDENT.exec(fields.get('author')?.[0] ?? '');
    const committer = IDENT.exec(fields.get('committer')?.[0] ?? '');
    const tree = fields.get('tree')?.[0];
    if (!author || !committer || !tree) return { ok: false, error: `git gave a commit Spool could not read: ${sha.slice(0, 7)}` };
    const made = git(dir, ['commit-tree', ...sign, tree, '-p', parent], Buffer.from(stamped.raw), {
      GIT_AUTHOR_NAME: author[1]!,
      GIT_AUTHOR_EMAIL: author[2]!,
      GIT_AUTHOR_DATE: `@${author[3]!}`,
      GIT_COMMITTER_NAME: committer[1]!,
      GIT_COMMITTER_EMAIL: committer[2]!,
      GIT_COMMITTER_DATE: `@${committer[3]!}`,
    });
    if (!made.ok || !made.out) return { ok: false, error: `git could not remake ${sha.slice(0, 7)}: ${made.err}` };
    parent = made.out;
    changed++;
  }
  if (!changed) return { ok: true, changed };
  const moved = git(dir, ['update-ref', '-m', 'spool: trailers stamped at landing', 'HEAD', parent, old]);
  if (!moved.ok) return { ok: false, error: `git would not move the branch to the stamped commits: ${moved.err}` };
  return { ok: true, changed };
}

/** Has a later commit on this branch already taken `sha` back? */
export function isReverted(root: string, sha: string): boolean {
  // A revert that was itself reverted has put the work back.
  const takers = git(root, ['log', '--format=%H', '-F', `--grep=This reverts commit ${sha}`]).out;
  return takers.split('\n').filter(Boolean).some((taker) => !isReverted(root, taker));
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
  // Untrimmed: a file changed and not staged starts its line with a space, and losing it cut the first name short.
  return result.raw
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
