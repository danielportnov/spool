/**
 * `spool builder`: who builds a project's threads, and how many at once. It writes the same settings
 * the page's Headless | Chat selector reads, so a chat can act on "switch to chat mode" and the
 * page follows within a second (it reads the pick fresh on every board refresh).
 */

import { type Builder, type Ctx, builderOf, parallelOf, saveBuilder, saveUserConfig } from './context.ts';
import { SpoolError } from './model.ts';
import { atOnceIn, sharedFolderWhy } from './slots.ts';

export interface BuilderResult {
  text: string;
  data: { project: string; builder: Builder; atOnce: number };
}

function threads(n: number): string {
  return n === 1 ? '1 thread' : `${n} threads`;
}

/** The line the page and the command say, in the page's own words. `shared` is why its threads would share one folder. */
function sayWho(name: string, builder: Builder, n: number, shared: string): string {
  if (builder === 'chat') return `A chat builds ${name}: say /spool-loop in a Claude Code chat there. The page starts no agents.`;
  const why = shared ? `: ${shared}, so its threads cannot have a worktree each` : ', each in a worktree of its own';
  return `The page builds ${name}, headless, ${threads(n)} at once${n > 1 || shared ? why : ''}. Switch its Agents on to start.`;
}

/**
 * `word` is the pick to set, if any, and `atOnce` the number, as typed. `guard` is the lock: it
 * throws where the project's gate leaves this to the human, and is asked only when something changes.
 */
export function builderCommand(
  ctx: Ctx,
  project: { name: string; root: string },
  word: string | undefined,
  atOnce: string | undefined,
  guard: () => void,
): BuilderResult {
  if (word !== undefined && word !== 'headless' && word !== 'chat') {
    throw new SpoolError(`"${word}" is not a way to build`, 'Say headless (the page starts the agents) or chat (a Claude Code chat runs the loop): spool builder chat');
  }
  let n: number | undefined;
  if (atOnce !== undefined) {
    n = /^\d+$/.test(atOnce) ? Number(atOnce) : 0;
    if (!Number.isSafeInteger(n) || n < 1) throw new SpoolError(`"${atOnce}" is not a number of threads`, 'Give a whole number, 1 or more: spool builder --at-once 3');
  }
  if (word !== undefined || n !== undefined) {
    guard();
    if (word !== undefined) saveBuilder(ctx, project.root, word);
    if (n !== undefined) {
      const count = n;
      saveUserConfig(ctx, (config) => {
        config.parallel = count;
      });
    }
  }
  const builder = builderOf(ctx, project.root);
  // The page's own number, read through the same function the page reads it with, so the two never disagree.
  const now = atOnceIn(ctx, project.root);
  const shared = parallelOf(ctx) > 1 ? sharedFolderWhy(project.root) : '';
  return { text: sayWho(project.name, builder, now, shared), data: { project: project.name, builder, atOnce: now } };
}
