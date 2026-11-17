/**
 * A worktree per thread, so several can be built at once.
 *
 * One checkout is one agent's desk. Two agents in it edit each other's files,
 * and each one's check runs on the other's half-made change. So a thread can
 * be given a git worktree of its own, on a branch of its own, `spool/<id>`,
 * cut from the checkout's HEAD. Its agent works and commits only there.
 *
 * `spool done` lands it: the branch is rebased onto wherever the checkout has
 * got to, the project's check runs on that, in the worktree, and the
 * checkout's branch is fast-forwarded to it. Threads land one at a time, so
 * each is checked on top of the ones before it and the history stays a
 * straight line: each thread's commits, in the order the threads finished.
 *
 * The worktree is kept inside the spool, at `.spool/worktrees/<id>`. That is
 * inside the project folder an agent is allowed to work in, out of git's
 * sight, and never walked when Spool looks for projects. Where the queue is
 * kept in git a worktree carries a copy of it; `findHome` in store.ts sends
 * every command run inside a worktree to the one real queue.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Trailer, git, real, resolveCommit, stampCommits } from './git.ts';
import { type Item, SpoolError } from './model.ts';
import { WORKTREES_DIR } from './store.ts';

/**
 * Folders git does not track that a check cannot run without. A new worktree has none of them, so
 * each is linked in from the checkout. Kept short on purpose: a link is shared, not a copy.
 */
const LINKED = ['node_modules'];

/** How long a thread waits for another to finish landing before it says it is still waiting. */
const LAND_WAIT_MS = 5 * 60_000;
/** A landing lock older than any check may run was left by something that died holding it. */
const LAND_STALE_MS = 45 * 60_000;

const posix = (p: string): string => p.split(path.sep).join('/');
const list = (out: string): string[] => out.split('\0').filter(Boolean);

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The branch a thread's worktree is on. */
export function branchOf(id: string): string {
  return `spool/${id}`;
}

/** The top of a thread's worktree, whether or not it has one: a whole checkout of the repository. */
export function worktreeDir(task: Item): string {
  return path.join(task.spool.dir, WORKTREES_DIR, task.id);
}

/**
 * The folder to work a thread in: its project's folder inside its own worktree, or the project
 * itself where it has none. This is where its agent is started, and where its check runs.
 */
export function workDir(task: Item): string {
  return task.worktree ? path.resolve(task.spool.root, task.worktree) : task.spool.root;
}

interface Place {
  /** The top of the checkout that holds the project. */
  repo: string;
  /** The project's folder inside it; empty where the project is the repository. */
  prefix: string;
  /** The top of the thread's worktree. */
  dir: string;
  /** The project's folder inside the worktree. */
  work: string;
  branch: string;
}

function locate(task: Item): Place | null {
  const found = git(task.spool.root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (!found.ok || !found.out) return null;
  const [repo, prefix = ''] = found.out.split('\n');
  const dir = worktreeDir(task);
  const inside = prefix.replace(/\/+$/, '');
  return { repo: repo!, prefix: inside, dir, work: path.join(dir, inside), branch: task.branch ?? branchOf(task.id) };
}

function isWorktree(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top.ok && real(top.out) === real(dir);
}

/** Where git keeps what every worktree of a repository shares. */
function commonDir(repo: string): string {
  return path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).out || '.git');
}

/** Files in a working tree that differ from its HEAD or are new to it: all of them, or those among `paths`. */
function uncommitted(dir: string, paths?: string[]): string[] {
  const only = paths ? ['--', ...paths.map((p) => `:(top,literal)${p}`)] : [];
  const ask = (args: string[]): string[] => list(git(dir, [...args, ...only]).out);
  return [
    ...new Set([
      ...ask(['diff', '--name-only', '-z', '--no-renames', 'HEAD']),
      ...ask(['diff', '--name-only', '-z', '--no-renames', '--cached', 'HEAD']),
      ...ask(['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ];
}

function shown(files: string[], most = 12): string {
  return [...files.slice(0, most), ...(files.length > most ? [`… and ${files.length - most} more`] : [])].join('\n  ');
}

/** The checkout's folders a worktree may link to, by their path from the top of the repository. */
function linkable(at: Place): string[] {
  // The project's own folder, and the top of the repository where that is another folder: Node looks in both.
  return [...new Set(['', at.prefix])].flatMap((folder) => LINKED.map((name) => path.posix.join(folder, name)));
}

/** Link the untracked folders a check needs into the worktree. Returns what was linked. */
function link(at: Place): string[] {
  const linked: string[] = [];
  for (const rel of linkable(at)) {
    const from = path.join(at.repo, rel);
    const to = path.join(at.dir, rel);
    // Only a folder git ignores: one it tracks is in the worktree already, and one it would add is the project's to decide.
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory() || !git(at.repo, ['check-ignore', '-q', rel]).ok) continue;
    if (fs.lstatSync(to, { throwIfNoEntry: false }) || !fs.existsSync(path.dirname(to))) continue;
    try {
      fs.symlinkSync(from, to, 'junction');
    } catch {
      continue; // No links here: the check finds out, and says so in its own words.
    }
    // A rule like "node_modules/" ignores the folder and not a link to it. Unignored, the link would
    // show as new work, and `git add -A` would commit it.
    if (!git(at.dir, ['check-ignore', '-q', rel]).ok) exclude(at.repo, `/${rel}`);
    linked.push(rel);
  }
  return linked;
}

/** Have git ignore a path in every worktree of the repository, without touching a tracked file. */
function exclude(repo: string, pattern: string): void {
  const file = path.join(commonDir(repo), 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No such file yet.
  }
  if (text.split('\n').includes(pattern)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const note = "# Spool: a thread's worktree links to this folder, and the link is ignored as the folder is.";
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${note}\n${pattern}\n`);
}

/** The hooks git runs, each of which a thread's worktree must still run from the project's own hooks. */
const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'post-rewrite', 'pre-auto-gc', 'reference-transaction',
];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Make `git push` fail in a thread's worktree, with a line saying why. Git shares one hooks folder
 * between a repository's worktrees, so the hook cannot go there without also binding the user's own
 * checkout. Instead the worktree alone gets `core.hooksPath` (git's per-worktree config), pointing at
 * a folder kept in the worktree's own admin folder, which goes when the worktree does. That folder
 * holds the refusing `pre-push`, and a forwarder for every other hook that runs the project's own
 * hook of that name, so a worktree is checked by the same hooks its checkout is. The checkout's
 * config gains only `extensions.worktreeConfig`, which changes nothing for it. A worktree the user
 * makes by hand is not touched. Best effort: where git cannot, the policy still says it.
 */
function guardPush(at: Place): void {
  if (process.platform === 'win32') return; // Shell hooks: git for Windows runs them, but a path with a drive letter is not worth the risk here.
  const common = commonDir(at.repo);
  const original = path.resolve(at.repo, git(at.repo, ['rev-parse', '--git-path', 'hooks']).out || path.join(common, 'hooks'));
  const admin = path.resolve(at.dir, git(at.dir, ['rev-parse', '--git-dir']).out);
  const hooks = path.join(admin, 'spool-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const write = (name: string, body: string): void => fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write(
    'pre-push',
    [
      'echo "spool: git push is refused here. Agents never push: this is a Spool thread worktree, and publishing is for the user to do." >&2',
      'echo "spool: if the work needs to go out, finish the thread (spool done) or put it to them (spool ask --human publish)." >&2',
      'exit 1',
    ].join('\n'),
  );
  for (const name of HOOKS) write(name, `h=${shq(path.join(original, name))}\n[ -x "$h" ] || exit 0\nexec "$h" "$@"`);
  if (!git(at.repo, ['config', 'extensions.worktreeConfig', 'true']).ok) return;
  git(at.dir, ['config', '--worktree', 'core.hooksPath', hooks]);
}

export interface Opened {
  /** The top of the worktree: a whole checkout of the repository. */
  dir: string;
  /** The folder to work the thread in: the project's own folder inside the worktree. */
  work: string;
  branch: string;
  /** False where the thread already had its worktree, and it was reused. */
  made: boolean;
  /** Folders git does not track that were linked in from the checkout, by their path in the worktree. */
  linked: string[];
}

/**
 * Give a thread a worktree of its own, on the branch `spool/<id>` cut from the checkout's HEAD, or
 * find the one it has. The worktree and branch are put on the item; saving it is the caller's.
 * Refuses, changing nothing, where the project is not in a git repository.
 */
export function openWorktree(task: Item): Opened {
  const at = locate(task);
  if (!at) {
    throw new SpoolError(`${task.spool.name} is not a git repository, so ${task.id} cannot have a worktree`, `Start it where the project is: spool start ${task.id}`);
  }
  let made = false;
  if (!isWorktree(at.dir)) {
    if (!resolveCommit(at.repo, 'HEAD')) {
      throw new SpoolError(`nothing is committed in ${task.spool.name} yet, so there is nothing to cut a worktree from`, `Make a first commit, or start it where the project is: spool start ${task.id}`);
    }
    if (fs.existsSync(at.dir)) {
      throw new SpoolError(`${at.dir} is in the way, and is not a git worktree`, 'Move it or remove it, then start the thread again');
    }
    const home = path.dirname(at.dir);
    fs.mkdirSync(home, { recursive: true });
    const ignore = path.join(home, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# The git worktrees of threads being built, each a checkout of its own. Kept on this machine only.\n*\n');
    // A worktree whose folder was deleted by hand is still on git's books; its branch, and the work on it, are kept.
    git(at.repo, ['worktree', 'prune']);
    const kept = resolveCommit(at.repo, `refs/heads/${at.branch}`);
    const added = git(at.repo, kept ? ['worktree', 'add', at.dir, at.branch] : ['worktree', 'add', '-b', at.branch, at.dir, 'HEAD']);
    if (!added.ok) throw new SpoolError(`git would not make a worktree for ${task.id}: ${added.err}`);
    if (!fs.existsSync(at.work)) {
      // The repository is committed, but none of this project is: the worktree has no folder to work it in.
      git(at.repo, ['worktree', 'remove', '--force', at.dir]);
      if (!kept) git(at.repo, ['branch', '-D', at.branch]);
      throw new SpoolError(`nothing of ${task.spool.name} is committed yet, so a worktree would not hold it`, `Commit the project first, or start it where the project is: spool start ${task.id}`);
    }
    made = true;
  }
  if (made) guardPush(at);
  const linked = link(at);
  task.worktree = posix(path.relative(task.spool.root, at.work));
  task.branch = at.branch;
  return { dir: at.dir, work: at.work, branch: at.branch, made, linked };
}

export interface Closed {
  branch: string;
  /** Commits on the branch that had not landed, and where it pointed: they went with it. */
  lost?: { commits: number; tip: string };
  /** What could not be removed, and why. */
  problem?: string;
}

/**
 * Take a thread's worktree and branch away, with whatever was in them. Work that had landed is on
 * the checkout's branch and stays; work that had not is gone. The item is cleared of both; saving
 * it is the caller's. Null where the thread has no worktree.
 */
export function closeWorktree(task: Item): Closed | null {
  if (!task.worktree && !task.branch) return null;
  const dir = worktreeDir(task);
  // The top of the worktree and the project's folder in it: the two places a link may have been put.
  const folders = [dir, ...(task.worktree ? [workDir(task)] : [])].filter((f) => f === dir || f.startsWith(dir + path.sep));
  const branch = task.branch ?? branchOf(task.id);
  task.worktree = undefined;
  task.branch = undefined;
  const out: Closed = { branch };
  // Whatever goes wrong here is said, not thrown: by now it is the thread's own record that matters.
  try {
    // The links first: removing a worktree must never reach through one into the checkout's own folder.
    for (const to of [...new Set(folders)].flatMap((folder) => LINKED.map((name) => path.join(folder, name)))) {
      if (fs.lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(to);
    }
    const repo = locate(task)?.repo;
    if (repo && fs.existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
    if (!repo) return out;
    git(repo, ['worktree', 'prune']);
    const tip = resolveCommit(repo, `refs/heads/${branch}`);
    if (tip) {
      const ahead = Number(git(repo, ['rev-list', '--count', `HEAD..${tip}`]).out) || 0;
      if (ahead) out.lost = { commits: ahead, tip };
      const gone = git(repo, ['branch', '-D', branch]);
      if (!gone.ok) out.problem = `the branch ${branch} could not be deleted (${gone.err})`;
    }
  } catch (error) {
    out.problem = `${dir} could not be removed (${(error as Error).message})`;
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One thread lands at a time. This is a lock of its own, kept with the repository: the store's lock
 * is held for an instant and every command needs it, while a landing holds this one for as long as
 * the project's check runs. A second thread waits for it, then says it is still waiting.
 * Returns what lets go of it.
 */
export function landingLock(repo: string, id: string, waitMs = LAND_WAIT_MS, staleMs = LAND_STALE_MS): () => void {
  const file = path.join(commonDir(repo), 'spool-landing.lock');
  const mine = `${process.pid} ${id}\n`;
  const deadline = Date.now() + waitMs;
  // While this waits it leaves a note beside the lock, so `spool status` and the board can say who waits behind whom.
  const waiting = path.join(commonDir(repo), `${WAITING}${process.pid}-${id}`);
  const stopWaiting = (): void => fs.rmSync(waiting, { force: true });
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      stopWaiting();
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = '';
    try {
      const [pid, who = ''] = fs.readFileSync(file, 'utf8').trim().split(' ');
      holder = who;
      // Whoever held it is gone without letting go: a crash, or a check that was killed.
      if ((pid && !alive(Number(pid))) || Date.now() - fs.statSync(file).mtimeMs > staleMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch {
      continue; // Let go of between the two looks.
    }
    if (waitMs > 0 && !fs.existsSync(waiting)) {
      try {
        fs.writeFileSync(waiting, `${Date.now()}\n`);
      } catch {
        // A note nobody can read costs nothing but the sentence on the board.
      }
    }
    if (Date.now() >= deadline) {
      stopWaiting();
      const waited = waitMs >= 60_000 ? `${Math.round(waitMs / 60_000)} minute(s)` : `${Math.ceil(waitMs / 1000)} second(s)`;
      throw new SpoolError(
        `${holder || 'another thread'} is still landing, after ${waited} of waiting`,
        `Nothing of ${id} was changed. Its check may be a slow one: run spool done ${id} again in a while.`,
      );
    }
    sleep(100);
  }
}

const WAITING = 'spool-landing-wait-';

export interface LandingState {
  /** The thread landing now, and for how many seconds its landing has held the lock. */
  landing: { id: string; seconds: number };
  /** The threads waiting behind it, the longest first, and for how many seconds each has. */
  waiting: { id: string; seconds: number }[];
}

/** Who holds the landing lock and who waits behind it, or undefined when nothing is landing. */
export function landingState(repo: string): LandingState | undefined {
  try {
    const dir = commonDir(repo);
    const file = path.join(dir, 'spool-landing.lock');
    const [pid, id = ''] = fs.readFileSync(file, 'utf8').trim().split(' ');
    if (!pid || !alive(Number(pid))) return undefined;
    const now = Date.now();
    const seconds = (since: number): number => Math.max(0, Math.round((now - since) / 1000));
    const waiting: { id: string; seconds: number }[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(WAITING)) continue;
      const [who, ...rest] = name.slice(WAITING.length).split('-');
      if (!who || !alive(Number(who))) {
        fs.rmSync(path.join(dir, name), { force: true });
        continue;
      }
      const since = Number(fs.readFileSync(path.join(dir, name), 'utf8').trim());
      waiting.push({ id: rest.join('-'), seconds: Number.isFinite(since) ? seconds(since) : 0 });
    }
    waiting.sort((a, b) => b.seconds - a.seconds);
    return { landing: { id, seconds: seconds(fs.statSync(file).mtimeMs) }, waiting };
  } catch {
    return undefined;
  }
}

export function landingWords(state: LandingState | undefined): string | undefined {
  if (!state) return undefined;
  const how = (s: number): string => (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);
  const behind = state.waiting.map((w) => `${w.id} has waited ${how(w.seconds)}`);
  return `${state.landing.id} is landing (${how(state.landing.seconds)} so far)${behind.length ? `; ${behind.join(', ')} behind it` : ''}.`;
}

export interface Landing<T = unknown> {
  /** The thread's commits, now on the checkout's branch, oldest first. */
  commits: string[];
  /** What they landed on: the checkout's branch, or its commit where it is on none. */
  onto: string;
  /** What the check gave back. */
  checked: T;
  /** Lets the next thread land. Call it once this one is recorded done and its worktree is gone. */
  release: () => void;
}

/**
 * The lines `spool done` puts at the foot of each commit it lands, so git itself says which
 * thread it was for, who built it and on what: `Spool: <id>`, `Spool-Agent: <name>` and, where
 * Spool knows what ran, `Spool-Model: <model>`. A commit that already says one keeps its own: a
 * hand-written `Spool:` naming another thread is kept beside this one, never replaced.
 */
export function landingTrailers(id: string, agent?: string, model?: string): Trailer[] {
  return [
    { key: 'Spool', value: id },
    ...(agent ? [{ key: 'Spool-Agent', value: agent, once: true }] : []),
    ...(model ? [{ key: 'Spool-Model', value: model, once: true }] : []),
  ];
}

/**
 * Land a thread's work on the checkout: rebase its branch onto the checkout's HEAD, stamp each of
 * its commits with `trailers`, run `check` in the worktree on the result, and fast-forward the
 * checkout's branch to it. The commits are the thread's own until then, on no branch but its, so
 * rewriting their messages is safe. `check` is given the folder to run in and refuses the landing
 * by throwing.
 *
 * Every refusal leaves the checkout where it was and the worktree with all its commits. On
 * success the landing lock is still held, so the thread can be recorded done and its worktree
 * removed before the next thread lands: the caller lets go with `release`.
 */
export function land<T>(task: Item, check: (cwd: string) => T, trailers: Trailer[] = [], waitMs = LAND_WAIT_MS, staleMs = LAND_STALE_MS): Landing<T> {
  const at = locate(task);
  if (!at || !isWorktree(at.dir)) {
    throw new SpoolError(
      `the worktree of ${task.id} is gone: ${worktreeDir(task)}`,
      `Get it back, with the branch it was on: spool start ${task.id} --worktree. Then run spool done again.`,
    );
  }
  const on = git(at.dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out;
  if (on !== at.branch) {
    throw new SpoolError(
      `the worktree of ${task.id} is on ${on || 'no branch'}, not on ${at.branch}`,
      `Its work lands from ${at.branch}. Put your commits on it (cd ${at.dir} && git switch ${at.branch}), then run spool done again.`,
    );
  }
  // Work that is not committed would not land, and would be lost when the worktree goes.
  const loose = uncommitted(at.dir);
  if (loose.length) {
    throw new SpoolError(
      `${task.id} has changes in its worktree that are not committed:\n  ${shown(loose)}`,
      `Commit them there (cd ${at.work}) with the trailer "Spool: ${task.id}", or throw them away. Then run spool done again.`,
    );
  }

  const release = landingLock(at.repo, task.id, waitMs, staleMs);
  try {
    const onto = resolveCommit(at.repo, 'HEAD');
    if (!onto) throw new SpoolError(`nothing is committed in ${at.repo}, so there is nothing to land on`);
    const name = git(at.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).out || onto.slice(0, 7);

    const rebased = git(at.dir, ['rebase', onto]);
    if (!rebased.ok) {
      const conflicts = list(git(at.dir, ['diff', '--name-only', '-z', '--diff-filter=U']).out);
      git(at.dir, ['rebase', '--abort']);
      throw new SpoolError(
        conflicts.length
          ? `${task.id} conflicts with what has landed on ${name} since it began, in:\n  ${shown(conflicts)}`
          : `git could not rebase ${at.branch} onto ${name}: ${rebased.err}`,
        `Nothing was landed, and the worktree is as it was. Rebase it there: cd ${at.dir} && git rebase ${name}\n` +
          '  Resolve each conflict, git add it, git rebase --continue. Then run spool done again.',
      );
    }
    // Stamped before the check, so what is checked is what lands. Run again after a refusal, nothing is doubled.
    const stamped = stampCommits(at.dir, onto, trailers);
    if (!stamped.ok) throw new SpoolError(stamped.error, 'Nothing was landed. Run spool done again.');
    const commits = git(at.dir, ['rev-list', '--reverse', `${onto}..HEAD`]).out.split('\n').filter(Boolean);

    // Looked at before the check, which may be a long one: the fast-forward would be refused over these.
    const changed = list(git(at.dir, ['diff', '--name-only', '-z', '--no-renames', onto, 'HEAD']).out);
    const inTheWay = changed.length ? uncommitted(at.repo, changed) : [];
    if (inTheWay.length) {
      throw new SpoolError(
        `the checkout has uncommitted changes to files ${task.id} changed:\n  ${shown(inTheWay)}`,
        `Nothing was landed. Those changes are not this thread's: leave them, and put it to the user (spool ask --for ${task.id}).\n` +
          '  Once they are committed or gone, run spool done again.',
      );
    }

    const checked = check(at.work);

    if (resolveCommit(at.repo, 'HEAD') !== onto) {
      throw new SpoolError(`${name} moved on while the check ran`, 'Nothing was landed. Run spool done again: it rebases onto where the checkout is now.');
    }
    const merged = git(at.repo, ['merge', '--ff-only', at.branch]);
    if (!merged.ok) {
      throw new SpoolError(
        `git would not fast-forward ${name} to ${at.branch}: ${merged.err}`,
        'Nothing was landed. If the checkout\'s own uncommitted changes are in the way, they are the user\'s: put it to them with spool ask.',
      );
    }
    return { commits, onto: name, checked, release };
  } catch (error) {
    release();
    throw error;
  }
}
