/**
 * `spool builder`: who builds a project's threads, and how many at once. It writes the same settings
 * the page's Headless | Chat selector reads, so a chat can act on "switch to chat mode" and the
 * page follows within a second (it reads the pick fresh on every board refresh).
 */

import { type Builder, type Ctx, builderOf, saveBuilder, saveUserConfig, userConfig } from './context.ts';
import { SpoolError } from './model.ts';

/** Agents the page runs at once when nothing is said. */
const ONE = 1;

export interface BuilderResult {
  text: string;
  data: { project: string; builder: Builder; atOnce: number };
}

function atOnceOf(ctx: Ctx): number {
  const n = userConfig(ctx).parallel;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : ONE;
}

function threads(n: number): string {
  return n === 1 ? '1 thread' : `${n} threads`;
}

/** The line the page and the command say, in the page's own words. */
function sayWho(name: string, builder: Builder, n: number): string {
  return builder === 'chat'
    ? `A chat builds ${name}: say /spool-loop in a Claude Code chat there. The page starts no agents.`
    : `The page builds ${name}, headless, ${threads(n)} at once. Switch its Agents on to start.`;
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
  const now = atOnceOf(ctx);
  return { text: sayWho(project.name, builder, now), data: { project: project.name, builder, atOnce: now } };
}
