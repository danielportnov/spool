/**
 * `spool builder`: who builds a project's threads, and how many at once. It writes the same settings
 * the page's Headless | Chat selector reads, so a chat can act on "switch to chat mode" and the
 * page follows within a second (it reads the pick fresh on every board refresh).
 */

import { type Builder, type Ctx, builderOf, parallelOf, saveBuilder, saveUserConfig } from './context.ts';
import { SpoolError } from './model.ts';
import { atOnceIn, sharedFolderWhy } from './slots.ts';
import { figuresText, targetOf } from './usage.ts';

export interface BuilderResult {
  text: string;
  data: { project: string; builder: Builder; atOnce: number };
}

function threads(n: number): string {
  return n === 1 ? '1 thread' : `${n} threads`;
}

/**
 * The line the page and the command say, in the page's own words. `shared` is why its threads would
 * share one folder; `target` is the human's usage target in words, empty where there is none.
 */
function sayWho(name: string, builder: Builder, n: number, shared: string, target: string): string {
  const why = shared ? `: ${shared}, so its threads cannot have a worktree each` : ', each in a worktree of its own';
  const atOnce = `${threads(n)} at once${n > 1 || shared ? why : ''}`;
  // The loop reads its number here, and its target: a chat builds as many at once as the page would, and up to the human's line.
  const upTo = target ? ` It works up to the usage target, ${target}: spool usage says when to stop.` : '';
  if (builder === 'chat') return `A chat builds ${name}: say /spool-loop in a Claude Code chat there. The page starts no agents. The chat builds ${atOnce}.${upTo}`;
  return `The page builds ${name}, headless, ${atOnce}. Switch its Agents on to start.`;
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
  // Saying what is already so changes nothing, and is nobody's to refuse: a chat starting the loop
  // where Chat is already picked gets its answer, whatever the gate.
  const changes = (word !== undefined && word !== builderOf(ctx, project.root)) || (n !== undefined && n !== parallelOf(ctx));
  if (changes) {
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
  return { text: sayWho(project.name, builder, now, shared, figuresText(targetOf(ctx))), data: { project: project.name, builder, atOnce: now } };
}
