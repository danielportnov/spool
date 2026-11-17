/** Plan against a private index. Only a complete, conflict-free undo reaches the checkout. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { git, isReverted, real, resolveCommit } from './git.ts';

interface Step {
  sha: string;
  parent: string;
  others: string[];
}

interface Conflict {
  sha: string;
  paths: string[];
  error: string;
  commits: string[];
  ambiguous?: boolean;
}

interface RevertOptions {
  spoolDirs: string[];
  message: (reverted: string[]) => string;
  withLater?: boolean;
  conflict?: (conflict: Conflict) => { explain: string[]; add?: string[]; hint?: string };
}

export interface RevertResult {
  ok: boolean;
  reverted: string[];
  skipped: { sha: string; why: string }[];
  commit?: string;
  error?: string;
}

const list = (out: string): string[] => out.split('\0').filter(Boolean);
const literal = (paths: string[]): string[] => paths.map((p) => `:(top,literal)${p}`);
const diffOptions = [
  '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
  '--src-prefix=a/', '--dst-prefix=b/',
];

function gitBytes(root: string, args: string[], index?: string, input?: Buffer) {
  return spawnSync('git', args, {
    cwd: root,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(index ? { GIT_INDEX_FILE: index } : {}) },
  });
}

function problem(result: ReturnType<typeof gitBytes>): string {
  return result.error?.message ?? result.stderr?.toString('utf8').trim() ?? '';
}

interface Edit {
  from: number;
  until: number;
  replacement: Buffer;
}

function lineOffsets(blob: Buffer): number[] {
  const offsets = [0];
  for (let newline = blob.indexOf(10); newline >= 0; newline = blob.indexOf(10, newline + 1)) offsets.push(newline + 1);
  if (offsets.at(-1) !== blob.length) offsets.push(blob.length);
  return offsets;
}

function edits(root: string, base: string, side: string, contents: Buffer): Edit[] | undefined {
  const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--diff-algorithm=myers',
    '--no-indent-heuristic', '--unified=0', base, side]);
  if (!diff.ok || contents.includes(0)) return undefined;
  const offsets = lineOffsets(contents);
  const changes: Edit[] = [];
  for (const hunk of diff.raw.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const take = Number(hunk[2] ?? 1);
    const give = Number(hunk[4] ?? 1);
    const from = Number(hunk[1]) - (take ? 1 : 0);
    const start = Number(hunk[3]) - (give ? 1 : 0);
    const first = offsets[start];
    const last = offsets[start + give];
    if (from < 0 || first === undefined || last === undefined) return undefined;
    changes.push({ from, until: from + take, replacement: contents.subarray(first, last) });
  }
  return changes.length || base === side ? changes : undefined;
}

/** Git's merge can group neighboring edits. Compose them only when their ranges and anchors agree. */
function disjointEdit(root: string, base: string, ours: string, theirs: string): Buffer | 'ambiguous' | undefined {
  const blobs = git(root, ['cat-file', '--batch-check=%(objectsize)'], Buffer.from(`${base}\n${ours}\n${theirs}\n`));
  if (!blobs.ok || blobs.out.split('\n').some((size) => !/^\d+$/.test(size) || Number(size) > 4 * 1024 * 1024)) return undefined;
  const originals = [base, ours, theirs].map((sha) => gitBytes(root, ['cat-file', 'blob', sha]));
  if (originals.some((blob) => blob.status !== 0)) return undefined;
  const [original, oursText, theirsText] = originals.map((blob) => blob.stdout) as [Buffer, Buffer, Buffer];
  if (original.includes(0)) return undefined;
  const a = edits(root, base, ours, oursText);
  const b = edits(root, base, theirs, theirsText);
  if (!a || !b) return undefined;
  const changes = [...a, ...b].sort((left, right) => left.from - right.from || left.until - right.until);
  const offsets = lineOffsets(original);
  const merged: Buffer[] = [];
  let end = 0;
  let previous: Edit | undefined;
  let ambiguous = false;
  for (const edit of changes) {
    if (previous && previous.from === edit.from && previous.until === edit.until) {
      if (previous.replacement.equals(edit.replacement)) continue;
      return undefined;
    }
    if (edit.from < end) return undefined;
    // A deletion or replacement needs a unique preimage. Give an insertion the
    // neighboring lines as its anchor, where available.
    const inserts = edit.from === edit.until;
    const from = offsets[inserts ? Math.max(0, edit.from - 1) : edit.from];
    const until = offsets[inserts ? Math.min(offsets.length - 1, edit.until + 1) : edit.until];
    if (from === undefined || until === undefined || from === until ||
      original.indexOf(original.subarray(from, until)) !== from ||
      original.indexOf(original.subarray(from, until), from + 1) !== -1) ambiguous = true;
    merged.push(original.subarray(offsets[end], offsets[edit.from]), edit.replacement);
    end = edit.until;
    previous = edit;
  }
  return ambiguous ? 'ambiguous' : Buffer.concat([...merged, original.subarray(offsets[end])]);
}

function resolveDisjoint(root: string, index: string, paths: string[]): boolean {
  const entries = gitBytes(root, ['ls-files', '--unmerged', '-z', '--', ...literal(paths)], index);
  if (entries.status !== 0) return false;
  const stages = new Map<string, string[][]>();
  for (const record of list(entries.stdout.toString('utf8'))) {
    const fields = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
    if (fields) stages.set(fields[4]!, [...(stages.get(fields[4]!) ?? []), fields.slice(1, 4)]);
  }
  let ambiguous = false;
  for (const [file, rows] of stages) {
    const [mode, base] = rows[0]!;
    if (rows.map((row) => row[2]).join('') !== '123' || !/^(?:100644|100755)$/.test(mode!) || rows.some((row) => row[0] !== mode)) continue;
    const output = disjointEdit(root, base!, rows[1]![1]!, rows[2]![1]!);
    if (output === 'ambiguous') ambiguous = true;
    if (!output || output === 'ambiguous') continue;
    const hashed = gitBytes(root, ['hash-object', '-w', '--stdin'], index, output);
    if (hashed.status !== 0) continue;
    gitBytes(root, ['update-index', '--add', '--cacheinfo', mode!, hashed.stdout.toString('utf8').trim(), file], index);
  }
  return ambiguous;
}

/** Undo commits newest first in one commit, without staging the queue or someone's other work. */
export function revertCommits(root: string, shas: string[], { spoolDirs, message, withLater, conflict }: RevertOptions): RevertResult {
  const result: RevertResult = { ok: false, reverted: [], skipped: [] };
  const fail = (error: string): RevertResult => ({ ...result, error });
  const head = resolveCommit(root, 'HEAD');
  const history = git(root, ['rev-list', '--topo-order', '--parents', ...(head ? [head] : [])]);
  const empty = git(root, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0));
  if (!head || !history.ok || !empty.ok) return fail('could not read git history. Nothing was changed.');
  const commits = new Map<string, Step>();
  const order = new Map<string, number>();
  for (const [i, line] of history.out.split('\n').entries()) {
    const [sha, parent = empty.out, ...others] = line.split(' ');
    commits.set(sha!, { sha: sha!, parent, others });
    order.set(sha!, i);
  }
  const newest = (a: Step, b: Step) => order.get(a.sha)! - order.get(b.sha)!;
  const excludes = spoolDirs.map((dir) => path.relative(real(root), real(dir)).split(path.sep).join('/'))
    .filter((dir) => dir && dir !== '..' && !dir.startsWith('../')).map((dir) => `:(top,exclude,literal)${dir}`);
  const everything = ['--', ':(top)', ...excludes];
  const files = new Map<string, string[]>();
  const patched = new Map<string, Buffer>();
  const already = new Map<string, boolean>();
  const selected = new Set(shas);
  let cacheBytes = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-revert-'));
  const index = path.join(directory, 'index');

  const pathsOf = (step: Step): string[] => {
    let paths = files.get(step.sha);
    if (!paths) {
      const changed = git(root, ['diff', '--no-renames', '--name-only', '-z', step.sha, step.parent, ...everything]);
      if (!changed.ok) throw new Error(changed.err || 'git diff failed');
      paths = list(changed.raw);
      files.set(step.sha, paths);
    }
    return paths;
  };
  const patchOf = (step: Step, only?: string[]): Buffer => {
    const key = JSON.stringify([step.sha, only]);
    let patch = patched.get(key);
    if (!patch) {
      const paths = only ? ['--', ...literal(only), ...excludes] : everything;
      const diff = gitBytes(root, ['diff', ...diffOptions, step.sha, step.parent, ...paths]);
      if (diff.status !== 0) throw new Error(problem(diff) || 'git diff failed');
      patch = diff.stdout;
      if (cacheBytes + patch.length <= 16 * 1024 * 1024) {
        patched.set(key, patch);
        cacheBytes += patch.length;
      }
    }
    return patch;
  };
  const trySteps = (plan: Step[], only?: string[]): Omit<Conflict, 'commits'> | undefined => {
    const reset = gitBytes(root, ['read-tree', '--reset', head], index);
    if (reset.status !== 0) throw new Error(problem(reset) || 'git read-tree failed');
    for (const step of plan) {
      const patch = patchOf(step, only);
      if (!patch.length) continue;
      const applied = gitBytes(root, ['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], index, patch);
      if (applied.status !== 0) {
        const conflicted = (): string[] => {
          const diff = gitBytes(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=U'], index);
          if (diff.status !== 0) throw new Error(problem(diff) || 'could not read conflicts');
          return list(diff.stdout.toString('utf8'));
        };
        const paths = conflicted();
        const error = problem(applied);
        if (paths.length && !/^error:|^fatal:/m.test(error)) {
          const ambiguous = resolveDisjoint(root, index, paths);
          const remaining = conflicted();
          if (!remaining.length) continue;
          return { sha: step.sha, paths: remaining, error, ambiguous };
        }
        return { sha: step.sha, paths, error };
      }
    }
    return undefined;
  };

  const firstParentOrder = new Set<string>();
  for (let step = commits.get(head); step; step = commits.get(step.parent)) firstParentOrder.add(step.sha);

  // Reproduce the conflict on just its paths, then find which later commits Git needs
  // to peel off. This also finds deletions, where there's no surviving line to blame.
  const diagnose = (failed: Omit<Conflict, 'commits'>, plan: Step[]): Conflict => {
    const prefix = plan.slice(0, plan.findIndex((step) => step.sha === failed.sha) + 1);
    const paths = failed.paths.length ? failed.paths : pathsOf(commits.get(failed.sha)!).filter((file) => trySteps(prefix, [file]));
    const diagnosis: Conflict = { ...failed, paths, commits: [] };
    if (!paths.length || failed.ambiguous || !firstParentOrder.has(failed.sha)) return diagnosis;

    const history = git(root, ['log', '--first-parent', '--full-history', '--format=%H', `${failed.sha}..${head}`, '--', ...literal(paths)]);
    if (!history.ok) return diagnosis;
    let candidates = history.out.split('\n').filter((sha) => commits.has(sha) && !selected.has(sha)).map((sha) => commits.get(sha)!);
    let ambiguous = false;
    const works = (withSteps: Step[]) => {
      const trial = trySteps([...prefix, ...withSteps].sort(newest), paths);
      if (trial?.ambiguous) ambiguous = true;
      return !trial;
    };
    if (!candidates.length || works([]) || !works(candidates)) return diagnosis;

    // Try removing batches so a long history of unrelated edits in the file stays cheap.
    const prune = (group: Step[]): void => {
      const omit = new Set(group);
      const fewer = candidates.filter((step) => !omit.has(step));
      if (works(fewer)) {
        candidates = fewer;
      } else if (group.length > 1) {
        const middle = Math.floor(group.length / 2);
        prune(group.slice(0, middle));
        prune(group.slice(middle));
      }
    };
    prune([...candidates].reverse());
    return ambiguous ? { ...diagnosis, ambiguous } : { ...diagnosis, commits: candidates.map((step) => step.sha) };
  };

  let patch: Buffer;
  let changedPaths: string[];
  let plan: Step[];
  try {
    for (;;) {
      result.skipped = [];
      plan = [];
      for (const sha of selected) {
        const step = commits.get(sha);
        if (step && !already.has(sha)) already.set(sha, isReverted(root, sha));
        if (!step) result.skipped.push({ sha, why: 'not on this branch' });
        else if (already.get(sha)) result.skipped.push({ sha, why: 'already reverted' });
        else if (step.others.length) result.skipped.push({ sha, why: 'is a merge' });
        else if (pathsOf(step).length) plan.push(step);
        else result.skipped.push({ sha, why: 'only touched the queue' });
      }
      plan.sort(newest);
      const touched = [...new Set(plan.flatMap(pathsOf))];
      if (!touched.length) return { ...result, ok: true };
      const dirty = git(root, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', ...literal(touched)]);
      if (!dirty.ok) return fail(dirty.err || 'git status failed');
      if (dirty.out) return fail(`uncommitted changes in the way:\n${dirty.out}\nCommit or stash them, then revert again.`);
      const failed = trySteps(plan);
      if (!failed) break;
      const diagnosis = conflict ? diagnose(failed, plan) : { ...failed, commits: [] };
      const found = conflict?.(diagnosis);
      const extra = found?.add?.filter((sha) => !selected.has(sha)) ?? [];
      const eligible = extra.length > 0 && extra.every((sha) => {
        const step = commits.get(sha);
        return !!step && !step.others.length && firstParentOrder.has(sha) && order.get(sha)! < order.get(failed.sha)!;
      });
      if (withLater && eligible) {
        for (const sha of extra) selected.add(sha);
        continue;
      }
      const where = diagnosis.paths.length ? `\n${diagnosis.paths.join('\n')}` : ` (${failed.error})`;
      return fail(
        `reverting ${failed.sha.slice(0, 7)} conflicts with later work in:${where}\nNothing was changed.\n` +
        [...(found?.explain ?? []),
          ...(diagnosis.ambiguous ? ['Some changed lines have repeated text, so their overlap cannot be verified.'] : []),
          ...(eligible && found?.hint ? [found.hint] : extra.length ? ['Some of that work could not be safely included.'] : []),
          'Undo it by hand, or queue the undo as a task.'].join('\n'),
      );
    }
    const combined = gitBytes(root, ['diff', '--cached', ...diffOptions, head, ...everything], index);
    if (combined.status !== 0) throw new Error(problem(combined) || 'could not prepare the revert patch');
    patch = combined.stdout;
    const changed = gitBytes(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', head, ...everything], index);
    if (changed.status !== 0) throw new Error(problem(changed) || 'could not read the paths the revert changes');
    changedPaths = list(changed.stdout.toString('utf8'));
  } catch (error) {
    return fail(`${(error as Error).message}\nNothing was changed.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const reverted = plan.map((step) => step.sha);
  if (!patch.length) {
    return selected.size === new Set(shas).size
      ? { ...result, ok: true, reverted }
      : fail('the later work and the original undo would leave no change to record. Nothing was changed.');
  }
  // A commit with paths takes its content from the checkout, so it cannot safely
  // apply a new gitlink without also changing the submodule's own checkout.
  if (/^index [0-9a-f]+\.\.[0-9a-f]+ 160000$|^(?:new file|deleted file|old|new) mode 160000$/m.test(patch.toString('utf8'))) {
    return fail('the undo changes a submodule. Undo it by hand. Nothing was changed.');
  }
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const location = git(root, ['rev-parse', '--git-path', state]);
    if (!location.ok || fs.existsSync(path.resolve(root, location.out))) {
      return fail('another Git operation is in progress. Finish it before reverting. Nothing was changed.');
    }
  }
  if (resolveCommit(root, 'HEAD') !== head) return fail('HEAD moved while planning the revert. Nothing was changed.');
  const applyArgs = ['apply', '--index', '--whitespace=nowarn'];
  const ready = git(root, [...applyArgs, '--check', '-'], patch);
  if (!ready.ok) return fail(`git would not apply the revert: ${ready.err}\nNothing was changed.`);

  const commitMessage = message(reverted);
  const applied = git(root, [...applyArgs, '-'], patch);
  if (!applied.ok) return fail(`git would not apply the revert: ${applied.err}`);
  if (resolveCommit(root, 'HEAD') !== head) {
    return fail('HEAD moved while applying the revert. Check the index and working tree before retrying.');
  }
  const made = git(root, ['commit', '--quiet', '-m', commitMessage, '--', ...literal(changedPaths)]);
  if (!made.ok) {
    const rolledBack = resolveCommit(root, 'HEAD') === head
      && git(root, ['restore', '--source', head, '--staged', '--worktree', '--', ...literal(changedPaths)]).ok;
    return fail(`git would not commit the revert: ${made.err}\n${rolledBack ? 'Nothing was changed.' : 'Check the index and working tree before retrying.'}`);
  }
  return { ...result, ok: true, reverted, commit: resolveCommit(root, 'HEAD') ?? undefined };
}
