/**
 * Clean Up: the human asks, from the board, for a pass over the backlog.
 *
 * Pressing Clean Up leaves a request in the project's spool, `.spool/cleanup.json`: who asked,
 * when, and their words if they gave any. Whoever builds the project runs the pass on it. In Chat
 * mode that is the chat running the loop: `spool watch` prints a `cleanup:` line for the request,
 * and the chat runs the pass by the manager's rules. Headless, the page's runner starts an agent
 * on it. Either way the pass opens with `spool manage --start`, which takes the request up: its
 * worksheet says the pass was asked for so, and the request is gone.
 *
 * A pass asked for so proposes every drop and every archive on its thread, its own suggestions
 * too, so the human says yes or no to each: nothing is dropped or archived on the pass's say.
 * Sizing and the order it may still change itself, and one undo takes the pass back.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Spool, timestamp } from './model.ts';

const FILE = 'cleanup.json';

export interface CleanupAsk {
  by: string;
  at: string;
  /** What the human wrote in the field, if anything: the pass reads it first. */
  words: string;
}

const fileOf = (spool: Spool): string => path.join(spool.dir, FILE);

/** The request waiting in a project, if there is one. */
export function cleanupAsked(spool: Spool): CleanupAsk | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileOf(spool), 'utf8')) as Partial<CleanupAsk> | null;
    if (!parsed || typeof parsed.at !== 'string') return undefined;
    return { by: typeof parsed.by === 'string' ? parsed.by : 'human', at: parsed.at, words: typeof parsed.words === 'string' ? parsed.words : '' };
  } catch {
    return undefined;
  }
}

/** Leave a request for a pass. One already waiting is kept as it was asked. */
export function askCleanup(spool: Spool, by: string, words: string, now: Date): CleanupAsk {
  const waiting = cleanupAsked(spool);
  if (waiting) return waiting;
  const ask: CleanupAsk = { by, at: timestamp(now), words: words.replace(/\s+/g, ' ').trim().slice(0, 500) };
  const file = fileOf(spool);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(ask, null, 2)}\n`);
  fs.renameSync(temp, file);
  return ask;
}

/** Take the request up: the pass that answers it has started. */
export function takeCleanup(spool: Spool): CleanupAsk | undefined {
  const ask = cleanupAsked(spool);
  fs.rmSync(fileOf(spool), { force: true });
  return ask;
}

/** The line `spool watch` prints for a request, with what the chat that builds does about it. */
export function cleanupLine(name: string, ask: CleanupAsk): string {
  return `cleanup: ${name} — they pressed Clean Up on the board${ask.words ? `: "${ask.words}"` : ''}. Run the pass by spool prime manager, every drop and archive a proposal, and reply with the run's link`;
}

/** What the worksheet of a pass asked for with Clean Up says first. */
export const CLEANUP_RULE =
  'Asked for with Clean Up on the board. Every drop and every archive goes on this thread as a proposal, your own suggestions too: spool manage --propose <drop|archive> <t-id> -m "<the reason: shipped in <sha>, gone cold, a repeat of <t-id>>". Nothing goes without their yes. Sizes and the order you may change yourself, by the rules.';
