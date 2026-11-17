/**
 * `spool builder`: who builds a project's threads, and how many at once. It writes the same settings
 * the page's Headless | Chat selector reads, so a chat can act on "switch to chat mode" and the
 * page follows within a second (it reads the pick fresh on every board refresh).
 */

import { type Builder, type Ctx, builderOf, parallelOf, saveBuilder, saveUserConfig } from './context.ts';
import { SpoolError } from './model.ts';
import { modelOf } from './agent.ts';
import { type AgentView, countOf, parseSizes, rosterAgent, rosterLine, rosterOf, rosterView, saveAgent } from './roster.ts';
import { atOnceIn, sharedFolderWhy } from './slots.ts';
import type { Workspace } from './store.ts';
import { takeOverOf } from './takeover.ts';
import { figuresText, targetOf } from './usage.ts';

export interface BuilderResult {
  text: string;
  data: { project: string; builder: Builder; atOnce: number; agents: AgentView[] };
}

function threads(n: number): string {
  return n === 1 ? '1 thread' : `${n} threads`;
}

/**
 * The line the page and the command say, in the page's own words. `shared` is why its threads would
 * share one folder; `target` is the human's usage target in words, empty where there is none.
 */
function sayWho(name: string, builder: Builder, n: number, shared: string, target: string, takeOver: boolean, agents: AgentView[]): string {
  const why = shared ? `: ${shared}, so its threads cannot have a worktree each` : ', each in a worktree of its own';
  const atOnce = `${threads(n)} at once${n > 1 || shared ? why : ''}`;
  // The loop reads its number here, and its target: a chat builds as many at once as the page would, and up to the human's line.
  const upTo = target ? ` It works up to the usage target, ${target}: spool usage says when to stop.` : '';
  const takes = takeOver ? ' It takes over the backlog: with Build empty and the usage under the target, spool build --takeover moves the next thread to Build.' : '';
  // Each agent on the roster builds up to its own count; the line under it names them, and what each is on.
  const who = `\nAgents: ${rosterLine(agents)}. Set one: spool builder --agent <name> --at-once <n> [--sizes xs-m]`;
  if (builder === 'chat') return `A chat builds ${name}: say /spool-loop in a Claude Code chat there. The page starts no agents. The chat builds ${atOnce}.${upTo}${takes}${who}`;
  return `The page builds ${name}, headless, ${atOnce}. Switch its Agents on to start.`;
}

/** What `spool builder` was told to set. All as typed; each undefined where it was not given. */
export interface BuilderAsk {
  word?: string;
  atOnce?: string;
  /** The roster agent the count and the model are for: added where it is not on the roster. */
  agent?: string;
  model?: string;
  /** The sizes the agent takes: "xs-m", one size, or "all". */
  sizes?: string;
  /** The largest size it takes, the smallest open. */
  maxSize?: string;
}

function count(typed: string): number {
  const n = /^\d+$/.test(typed) ? Number(typed) : 0;
  if (!Number.isSafeInteger(n) || n < 1) throw new SpoolError(`"${typed}" is not a number of threads`, 'Give a whole number, 1 or more: spool builder --at-once 3');
  return n;
}

/**
 * `guard` is the lock: it throws where the project's gate leaves this to the human, and is asked
 * only when something changes. `actor` is who asks: an agent on the roster is told its own count.
 */
export function builderCommand(
  ctx: Ctx,
  ws: Workspace,
  project: { name: string; root: string },
  ask: BuilderAsk,
  actor: string,
  guard: () => void,
): BuilderResult {
  const { word } = ask;
  if (word !== undefined && word !== 'headless' && word !== 'chat') {
    throw new SpoolError(`"${word}" is not a way to build`, 'Say headless (the page starts the agents) or chat (a Claude Code chat runs the loop): spool builder chat');
  }
  const n = ask.atOnce === undefined ? undefined : count(ask.atOnce);
  if (ask.model !== undefined && !ask.agent) throw new SpoolError('--model goes with --agent', 'spool builder --agent Codex --model gpt-6');
  const model = modelOf(ask.model) || undefined;
  const range = parseSizes(ask.sizes, ask.maxSize);
  if (range && !ask.agent) throw new SpoolError('--sizes goes with --agent', 'spool builder --agent Codex --sizes xs-m');
  const agent = ask.agent?.trim();
  if (ask.agent !== undefined && !agent) throw new SpoolError('which agent?', 'spool builder --agent Codex --at-once 2');
  // Saying what is already so changes nothing, and is nobody's to refuse: a chat starting the loop
  // where Chat is already picked gets its answer, whatever the gate.
  const entry = agent ? rosterAgent(rosterOf(ctx, project.root), agent) : undefined;
  const changes =
    (word !== undefined && word !== builderOf(ctx, project.root)) ||
    (agent
      ? !entry || (n !== undefined && n !== entry.atOnce) || (model !== undefined && model !== entry.model) || (range !== undefined && ((range.minSize ?? undefined) !== entry.minSize || (range.maxSize ?? undefined) !== entry.maxSize))
      : n !== undefined && n !== parallelOf(ctx));
  if (changes) {
    guard();
    if (word !== undefined) saveBuilder(ctx, project.root, word);
    if (agent) saveAgent(ctx, project.root, agent, { atOnce: n, model, ...range });
    else if (n !== undefined) {
      const at = n;
      saveUserConfig(ctx, (config) => {
        config.parallel = at;
      });
    }
  }
  const builder = builderOf(ctx, project.root);
  const spool = ws.spools.find((s) => s.root === project.root) ?? ws.home;
  const agents = rosterView(ctx, ws, spool);
  // The page's own number, read through the same function the page reads it with, so the two never
  // disagree. An agent on the roster asking in Chat mode is told its own.
  const mine = builder === 'chat' ? rosterAgent(rosterOf(ctx, project.root), actor) : undefined;
  const now = mine ? countOf(ctx, project.root, mine) : atOnceIn(ctx, project.root);
  const shared = (mine ? now : parallelOf(ctx)) > 1 || parallelOf(ctx) > 1 ? sharedFolderWhy(project.root) : '';
  return {
    text: sayWho(project.name, builder, now, shared, figuresText(targetOf(ctx)), takeOverOf(ctx, project.root), agents),
    data: { project: project.name, builder, atOnce: now, agents },
  };
}
