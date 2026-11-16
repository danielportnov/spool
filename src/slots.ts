/**
 * How many threads of a project can be built at once, and so where each is built.
 *
 * A thread the page builds gets a git worktree of its own (worktree.ts), so several can go side
 * by side. A project that cannot have worktrees, because it is not a git repository or nothing of
 * it is committed yet, is built in its own folder, and there two agents would trample each other's
 * edits: one thread at a time, whatever the user's `parallel` says.
 */

import { type Ctx, parallelOf } from './context.ts';
import { git, resolveCommit } from './git.ts';

/**
 * Why the threads of the project in `root` cannot each have a worktree, in words for its log: it
 * is not a git repository, or nothing of it is committed to cut one from. Empty where they can.
 */
export function sharedFolderWhy(root: string): string {
  const found = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (!found.ok || !found.out) return 'it is not a git repository';
  const [repo, prefix = ''] = found.out.split('\n');
  if (!resolveCommit(repo!, 'HEAD')) return 'nothing is committed in its repository yet';
  // A project that is a folder of a larger repository needs that folder in the commit a worktree is cut from.
  const inside = prefix.replace(/\/+$/, '');
  if (inside && !git(repo!, ['cat-file', '-e', `HEAD:${inside}`]).ok) return 'none of it is committed yet';
  return '';
}

/** How many of this project's threads are built at once: the user's number, or one where they would share its folder. */
export function atOnceIn(ctx: Ctx, root: string): number {
  return sharedFolderWhy(root) ? 1 : parallelOf(ctx);
}
