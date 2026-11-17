/**
 * The roster: the agents that build a project, each with its own thread count.
 *
 * Several agents can build one project side by side in Chat mode: a Claude Code chat and a Codex
 * chat, each running the loop. Each is one entry here, by the name it signs with (`--as "Claude
 * Opus 5.5"` is Claude, `--as "Codex GPT-6"` is Codex), and builds up to its own number of threads
 * at once. A claim past that number is refused, so one agent never takes the room the human gave
 * another. The roster is kept with the other builder settings, on the user's machine, by the
 * project's folder. With nothing kept, it is Claude and Codex, each at the user's `parallel`.
 *
 * It is where each agent's other settings go as they come: its usage limit, the sizes it takes.
 */

import { type Ctx, parallelOf, saveUserConfig, userConfig } from './context.ts';
import { signer } from './agent.ts';
import { type Item, type Spool, SpoolError, oneLine } from './model.ts';
import { taskState, tasks } from './schedule.ts';
import { sharedFolderWhy } from './slots.ts';
import type { Workspace } from './store.ts';
import { watchers } from './watch.ts';

export interface RosterEntry {
  /** The agent's own name, the words of its `--as` before the model: Claude, Codex. */
  name: string;
  /** How it is started: `chat`, a chat of its own running the loop. Only chat is built so far. */
  kind?: 'chat' | 'headless';
  /** The model it builds on where the thread does not say. */
  model?: string;
  /** How many threads it builds at once. Not set: the user's `parallel`. */
  atOnce?: number;
}

/** The roster a project has before the human says anything: the two agents that build here. */
export const ROSTER_DEFAULT: readonly RosterEntry[] = [
  { name: 'Claude', kind: 'chat' },
  { name: 'Codex', kind: 'chat' },
];

/** The agents that build the project in `root`, in the human's order. */
export function rosterOf(ctx: Ctx, root: string): RosterEntry[] {
  const kept = userConfig(ctx).roster?.[root];
  const list = Array.isArray(kept) ? kept.filter((e) => e && typeof e.name === 'string' && e.name.trim()) : [];
  return (list.length ? list : ROSTER_DEFAULT).map((e) => ({ ...e }));
}

/** The roster entry a signer is, by the agent part of its name: "Claude Opus 5.5" is Claude. */
export function rosterAgent(roster: RosterEntry[], actor: string): RosterEntry | undefined {
  const agent = signer(actor).agent.toLowerCase();
  return roster.find((e) => e.name.toLowerCase() === agent);
}

/** How many threads an agent builds at once here: its own number, the user's, or one where they would share a folder. */
export function countOf(ctx: Ctx, root: string, entry: RosterEntry, shared = sharedFolderWhy(root)): number {
  if (shared) return 1;
  return typeof entry.atOnce === 'number' && Number.isInteger(entry.atOnce) && entry.atOnce >= 1 ? entry.atOnce : parallelOf(ctx);
}

/** The project's threads an agent is building now: claimed by a name that is that agent. */
export function heldBy(ws: Workspace, spool: Spool, entry: RosterEntry): Item[] {
  const name = entry.name.toLowerCase();
  return tasks(ws, spool).filter((t) => taskState(ws, t) === 'active' && !!t.by && signer(t.by).agent.toLowerCase() === name);
}

/**
 * Set one agent's thread count, or its model, adding it to the roster where it is not on it.
 * The first change keeps the whole roster, so the agents that were there by default stay.
 */
export function saveAgent(ctx: Ctx, root: string, name: string, change: { atOnce?: number; model?: string }): RosterEntry {
  const roster = rosterOf(ctx, root);
  let entry = rosterAgent(roster, name);
  if (!entry) {
    entry = { name: signer(name).agent, kind: 'chat' };
    roster.push(entry);
  }
  if (change.atOnce !== undefined) entry.atOnce = change.atOnce;
  if (change.model !== undefined) entry.model = change.model;
  saveUserConfig(ctx, (config) => {
    config.roster = { ...(config.roster ?? {}), [root]: roster };
  });
  return entry;
}

/**
 * Refuse a claim that would put an agent past its count, in Chat mode. A thread it holds already
 * is not counted again. A signer not on the roster is not held to a number.
 */
export function refuseOverCount(ctx: Ctx, ws: Workspace, task: Item, actor: string): void {
  const entry = rosterAgent(rosterOf(ctx, task.spool.root), actor);
  if (!entry) return;
  const held = heldBy(ws, task.spool, entry).filter((t) => t.id !== task.id);
  const n = countOf(ctx, task.spool.root, entry);
  if (held.length < n) return;
  throw new SpoolError(
    `${entry.name} is at its ${n === 1 ? '1 thread' : `${n} threads`}: ${held.map((t) => t.id).join(', ')}`,
    `Land one first. More is the human's to give: spool builder --agent ${entry.name} --at-once ${n + 1}`,
  );
}

/** One agent as the page and the commands show it. */
export interface AgentView {
  name: string;
  model: string;
  atOnce: number;
  /** Whether a `spool watch` signed as this agent is up for the project. */
  watching: boolean;
  building: { id: string; title: string }[];
}

export function rosterView(ctx: Ctx, ws: Workspace, spool: Spool): AgentView[] {
  const shared = sharedFolderWhy(spool.root);
  const up = watchers(spool.root).map((w) => w.toLowerCase());
  return rosterOf(ctx, spool.root).map((e) => ({
    name: e.name,
    model: e.model ?? '',
    atOnce: countOf(ctx, spool.root, e, shared),
    watching: up.includes(e.name.toLowerCase()),
    building: heldBy(ws, spool, e).map((t) => ({ id: t.id, title: oneLine(t.title, 90) })),
  }));
}

/** The roster in one line: "Claude 3 at once, watching, building t-4kq7 · Codex 2 at once, not watching". */
export function rosterLine(agents: AgentView[]): string {
  return agents
    .map((a) => {
      const building = a.building.length ? `, building ${a.building.map((b) => b.id).join(', ')}` : '';
      return `${a.name} ${a.atOnce} at once${a.model ? ` on ${a.model}` : ''}, ${a.watching ? 'watching' : 'not watching'}${building}`;
    })
    .join(' · ');
}
