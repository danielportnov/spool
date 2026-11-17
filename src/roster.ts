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
 * Each entry also holds the sizes it takes (minSize, maxSize): a claim outside them is refused, and
 * `spool next --claim` and `spool build --takeover` pass those threads over. No size counts as medium.
 * Each agent's usage, its own reading against its own target, is shown with it (usage.ts `usageOf`).
 */

import { type Ctx, parallelOf, saveUserConfig, userConfig } from './context.ts';
import { type Lean, type Pick, type Routing, LEAN_DEFAULT, leanOf, leaning, signer, suggestion } from './agent.ts';
import { type Item, SIZES, type Size, type Spool, SpoolError, oneLine } from './model.ts';
import { taskState, tasks } from './schedule.ts';
import { sharedFolderWhy } from './slots.ts';
import type { Workspace } from './store.ts';
import { type Usage, usageOf } from './usage.ts';
import { watcherList } from './watch.ts';

export interface RosterEntry {
  /** The agent's own name, the words of its `--as` before the model: Claude, Codex. */
  name: string;
  /** How it is started: `chat`, a chat of its own running the loop. Only chat is built so far. */
  kind?: 'chat' | 'headless';
  /** The model it builds on where the thread does not say. */
  model?: string;
  /** How many threads it builds at once. Not set: the user's `parallel`. */
  atOnce?: number;
  /** The smallest size it takes. Not set: extra small. */
  minSize?: Size;
  /** The largest size it takes. Not set: extra large. */
  maxSize?: Size;
  /** Its slider from usage to development: which model, and how hard, each size gets. Not set: balanced. */
  lean?: Lean;
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

/** The sizes an agent takes, smallest and largest: all of them where nothing is set. */
export function sizesOf(entry: RosterEntry): [Size, Size] {
  const ok = (s: unknown): s is Size => SIZES.includes(s as Size);
  const lo = ok(entry.minSize) ? entry.minSize : SIZES[0];
  const hi = ok(entry.maxSize) ? entry.maxSize : SIZES[SIZES.length - 1]!;
  return [lo, hi];
}

/** The sizes as the human says them: "all sizes", "up to M", "XS to M", "L and up", "only M". */
export function sizesText(entry: RosterEntry): string {
  const [lo, hi] = sizesOf(entry);
  const L = (s: Size) => s.toUpperCase();
  if (lo === SIZES[0] && hi === SIZES[SIZES.length - 1]) return 'all sizes';
  if (lo === hi) return `only ${L(lo)}`;
  if (lo === SIZES[0]) return `up to ${L(hi)}`;
  if (hi === SIZES[SIZES.length - 1]) return `${L(lo)} and up`;
  return `${L(lo)} to ${L(hi)}`;
}

/**
 * Whether a thread is one the agent takes. A thread with no size counts as medium, as the size
 * table does for the model it is built on.
 */
export function takesSize(entry: RosterEntry, task: Item): boolean {
  const [lo, hi] = sizesOf(entry);
  const at = SIZES.indexOf(task.size ?? 'm');
  return at >= SIZES.indexOf(lo) && at <= SIZES.indexOf(hi);
}

/** The threads an actor may take, where it is on the roster, in Chat mode: the rest are left for an agent that may. */
export function withinSizes(ctx: Ctx, root: string, actor: string, list: Item[]): Item[] {
  const entry = rosterAgent(rosterOf(ctx, root), actor);
  return entry ? list.filter((t) => takesSize(entry, t)) : list;
}

/** Refuse a thread outside the sizes the agent that claims it takes. */
export function refuseOutsideSizes(ctx: Ctx, task: Item, actor: string): void {
  const entry = rosterAgent(rosterOf(ctx, task.spool.root), actor);
  if (!entry || takesSize(entry, task)) return;
  throw new SpoolError(
    `${task.id} is ${(task.size ?? 'm').toUpperCase()}${task.size ? '' : ' (no size counts as M)'}, and ${entry.name} takes ${sizesText(entry)}`,
    `Leave it for an agent that takes it: spool next. The sizes are the human's to set: spool builder --agent ${entry.name} --sizes xs-xl`,
  );
}

/** Read what `--sizes` or `--max-size` was given: "xs-m", "m" (that size and up, as "up to" is --max-size), "all". */
export function parseSizes(sizes?: string, maxSize?: string): { minSize?: Size | null; maxSize?: Size | null } | undefined {
  const one = (w: string): Size => {
    const s = w.trim().toLowerCase();
    if (!SIZES.includes(s as Size)) throw new SpoolError(`"${w}" is not a size`, `Sizes are ${SIZES.join(', ')}: spool builder --agent Codex --sizes xs-m`);
    return s as Size;
  };
  if (sizes !== undefined && maxSize !== undefined) throw new SpoolError('--sizes and --max-size are two ways to say it: use one');
  if (maxSize !== undefined) return { minSize: null, maxSize: one(maxSize) };
  if (sizes === undefined) return undefined;
  if (sizes.trim().toLowerCase() === 'all') return { minSize: null, maxSize: null };
  const [a, b, ...rest] = sizes.split('-');
  if (rest.length || a === undefined) throw new SpoolError(`"${sizes}" is not a range of sizes`, 'Say xs-m, l-xl, a single size like m, or all');
  const lo = one(a);
  const hi = b === undefined ? lo : one(b);
  if (SIZES.indexOf(lo) > SIZES.indexOf(hi)) throw new SpoolError(`"${sizes}" runs from large to small`, 'Say the smaller size first: xs-m');
  return { minSize: lo, maxSize: hi };
}

/**
 * Set one agent's thread count, its model, or its sizes, adding it to the roster where it is not on it.
 * The first change keeps the whole roster, so the agents that were there by default stay. A size of
 * null clears it: that end is open again.
 */
export function saveAgent(
  ctx: Ctx,
  root: string,
  name: string,
  change: { atOnce?: number; model?: string; minSize?: Size | null; maxSize?: Size | null; lean?: Lean },
): RosterEntry {
  const roster = rosterOf(ctx, root);
  let entry = rosterAgent(roster, name);
  if (!entry) {
    entry = { name: signer(name).agent, kind: 'chat' };
    roster.push(entry);
  }
  if (change.atOnce !== undefined) entry.atOnce = change.atOnce;
  if (change.model !== undefined) entry.model = change.model;
  for (const k of ['minSize', 'maxSize'] as const) {
    const v = change[k];
    if (v === null) delete entry[k];
    else if (v !== undefined) entry[k] = v;
  }
  if (change.lean !== undefined) entry.lean = change.lean;
  saveUserConfig(ctx, (config) => {
    config.roster = { ...(config.roster ?? {}), [root]: roster };
  });
  return entry;
}

/** An agent's lean, as kept: anything but a known word reads as balanced. */
export function leanAt(entry: RosterEntry | undefined): Lean {
  try {
    return leanOf(entry?.lean) ?? LEAN_DEFAULT;
  } catch {
    return LEAN_DEFAULT;
  }
}

/**
 * The size table a thread is picked by when `agent` builds it here: that agent's brand at its
 * lean, under any size the user set by hand. `agent` is a signer ("Claude Opus 5.5") or a roster name.
 */
export function routingFor(ctx: Ctx, root: string, agent: string): Routing {
  const entry = rosterAgent(rosterOf(ctx, root), agent);
  return leaning(userConfig(ctx).models, entry?.name ?? signer(agent).agent, leanAt(entry));
}

/** The agent a headless command is: `codex` is Codex, anything else Claude. */
export function agentOfCommand(command: string): string {
  const program = command.trim().split(/\s+/)[0]?.split('/').at(-1) ?? '';
  return program.toLowerCase() === 'codex' ? 'Codex' : 'Claude';
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
  /** The sizes it takes, smallest and largest, and the same in words. */
  sizes: [Size, Size];
  sizesText: string;
  /** Where its slider sits, usage to development, and what each size is built on there. */
  lean: Lean;
  table: { size: string; model: string; effort: string }[];
  /** Whether a `spool watch` signed as this agent is up for the project. */
  watching: boolean;
  /** When its watch started, while it is watching. */
  since: string;
  /** How it builds: a chat running the loop, or another agent that is watching without being on the roster. */
  how: string;
  /** Whether it is on the roster; a watcher that is not is shown anyway. */
  listed: boolean;
  building: { id: string; title: string }[];
  /** Its own plan's usage: the target it is held to, its last reading, and what that reading reached. */
  usage: Usage;
}

export function rosterView(ctx: Ctx, ws: Workspace, spool: Spool): AgentView[] {
  const shared = sharedFolderWhy(spool.root);
  const up = watcherList(spool.root);
  const watch = (name: string) => up.filter((w) => w.agent.toLowerCase() === name.toLowerCase()).sort((x, y) => x.since.localeCompare(y.since))[0];
  const roster = rosterOf(ctx, spool.root);
  const views: AgentView[] = roster.map((e) => {
    const w = watch(e.name);
    return {
      name: e.name,
      model: e.model ?? w?.model ?? '',
      atOnce: countOf(ctx, spool.root, e, shared),
      sizes: sizesOf(e),
      sizesText: sizesText(e),
      lean: leanAt(e),
      table: tableOf(routingFor(ctx, spool.root, e.name)),
      watching: !!w,
      since: w?.since ?? '',
      how: e.kind === 'headless' ? 'Headless' : 'Chat loop',
      listed: true,
      building: heldBy(ws, spool, e).map((t) => ({ id: t.id, title: oneLine(t.title, 90) })),
      usage: usageOf(ctx, e.name),
    };
  });
  // A watch signed as an agent that is not on the roster: shown anyway, with no count of its own.
  const seen = new Set(roster.map((e) => e.name.toLowerCase()));
  for (const w of up) {
    if (!w.agent || seen.has(w.agent.toLowerCase())) continue;
    seen.add(w.agent.toLowerCase());
    const e: RosterEntry = { name: w.agent, kind: 'chat' };
    views.push({
      name: w.agent,
      model: w.model,
      atOnce: countOf(ctx, spool.root, e, shared),
      sizes: sizesOf(e),
      sizesText: sizesText(e),
      lean: leanAt(e),
      table: tableOf(routingFor(ctx, spool.root, e.name)),
      watching: true,
      since: w.since,
      how: 'Another agent',
      listed: false,
      building: heldBy(ws, spool, e).map((t) => ({ id: t.id, title: oneLine(t.title, 90) })),
      usage: usageOf(ctx, e.name),
    });
  }
  return views;
}

/** What each size is built on by a table, smallest first. */
function tableOf(routing: Routing): AgentView['table'] {
  return SIZES.map((size) => {
    const pick: Pick = suggestion({ size } as never, routing);
    return { size, model: pick.model ?? '', effort: pick.effort ?? '' };
  });
}

/** What each size is built on, in a few words: "xs haiku, s haiku, m sonnet, l opus, xl opus·high". */
export function tableLine(a: AgentView): string {
  return a.table.map((s) => `${s.size} ${s.model}${s.effort && s.effort !== 'medium' ? `·${s.effort}` : ''}`).join(', ');
}

/** The roster in one line: "Claude 3 at once, watching, building t-4kq7 · Codex 2 at once, up to M, leaning usage, not watching". */
export function rosterLine(agents: AgentView[]): string {
  return agents
    .map((a) => {
      const building = a.building.length ? `, building ${a.building.map((b) => b.id).join(', ')}` : '';
      return `${a.name}${a.listed ? '' : ' (not on the roster)'} ${a.atOnce} at once${a.model ? ` on ${a.model}` : ''}, ${a.sizesText === 'all sizes' ? '' : `${a.sizesText}, `}${a.lean !== LEAN_DEFAULT ? `leaning ${a.lean}, ` : ''}${a.watching ? `watching${a.since ? ` since ${new Date(a.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}` : 'not watching'}${building}`;
    })
    .join(' · ');
}
