/**
 * Settings: every choice about how a spool runs, in one place.
 *
 * Most of them already have a command of their own (`spool builder`, `spool target`, `spool
 * takeover`, `spool notify`, `spool caveman`), and the page's Settings panel changes those through
 * the same actions as before. The few that had only a line in the config file are set here, with
 * `spool settings <name> <value>`, and the panel uses that command for them. All are kept in the
 * user's config, `~/.config/spool/config.json`, so the page and the commands always agree.
 */

import { type Ctx, QUIET_DEFAULT, type UserConfig, cavemanOf, parallelOf, quietLimits, saveUserConfig, userConfig } from './context.ts';
import { type Spool, SpoolError } from './model.ts';
import { type AgentView, rosterView } from './roster.ts';
import type { Workspace } from './store.ts';

/** One setting the `spool settings` command reads and writes. */
interface Setting {
  name: string;
  /** What it does, in a line. */
  says: string;
  kind: 'switch' | 'minutes';
  read: (ctx: Ctx) => boolean | number;
  write: (config: UserConfig, value: boolean | number) => void;
}

/** Whether the page's Headless pick may be clicked. Off unless set: chat builds, and Headless is greyed. */
export function headlessOffered(ctx: Ctx): boolean {
  return userConfig(ctx).offerHeadless === true;
}

/** Whether the page rebuilds Spool after a thread lands (and, headless, once Build is empty). On unless set off. */
export function rebuildOn(ctx: Ctx): boolean {
  return userConfig(ctx).rebuild !== false;
}

export const SETTINGS: readonly Setting[] = [
  {
    name: 'caveman',
    says: 'The chat that steers or builds answers in the fewest words',
    kind: 'switch',
    read: cavemanOf,
    write: (c, v) => { if (v) c.caveman = true; else delete c.caveman; },
  },
  {
    name: 'quick-reply',
    says: 'Where nobody builds a thread, a small model answers what you write on it within seconds',
    kind: 'switch',
    read: (ctx) => userConfig(ctx).quickReply !== false,
    write: (c, v) => { if (v) delete c.quickReply; else c.quickReply = false; },
  },
  {
    name: 'quiet-minutes',
    says: `Minutes an agent the page started may print nothing before its card says it is quiet: ${QUIET_DEFAULT} unless set, 0 for never`,
    kind: 'minutes',
    read: (ctx) => quietLimits(ctx).quiet / 60_000,
    write: (c, v) => { c.quietMinutes = v as number; },
  },
  {
    name: 'stop-minutes',
    says: 'Minutes of silence after which the page stops that agent and puts its thread back in Build: 0 for never',
    kind: 'minutes',
    read: (ctx) => quietLimits(ctx).stop / 60_000,
    write: (c, v) => { if (v) c.quietStopMinutes = v as number; else delete c.quietStopMinutes; },
  },
  {
    name: 'rebuild',
    says: 'The page rebuilds Spool after each thread lands, and reloads onto it',
    kind: 'switch',
    read: rebuildOn,
    write: (c, v) => { if (v) delete c.rebuild; else c.rebuild = false; },
  },
  {
    name: 'headless',
    says: 'Offer Headless on the page, where the page starts the agents itself with no chat open',
    kind: 'switch',
    read: headlessOffered,
    write: (c, v) => { if (v) c.offerHeadless = true; else delete c.offerHeadless; },
  },
];

/** What the page's Settings panel shows, besides what the board already carries. */
export interface SettingsView {
  caveman: boolean;
  quickReply: boolean;
  quietMinutes: number;
  stopMinutes: number;
  rebuild: boolean;
  headless: boolean;
  /** Threads at once where an agent has no number of its own. */
  parallel: number;
  /** The roster, whoever builds: each agent and its own thread count. */
  agents: AgentView[];
}

export function settingsOf(ctx: Ctx, ws: Workspace, spool: Spool): SettingsView {
  const { quiet, stop } = quietLimits(ctx);
  return {
    caveman: cavemanOf(ctx),
    quickReply: userConfig(ctx).quickReply !== false,
    quietMinutes: quiet / 60_000,
    stopMinutes: stop / 60_000,
    rebuild: rebuildOn(ctx),
    headless: headlessOffered(ctx),
    parallel: parallelOf(ctx),
    agents: rosterView(ctx, ws, spool),
  };
}

function valueOf(setting: Setting, word: string): boolean | number {
  if (setting.kind === 'switch') {
    if (word === 'on' || word === 'off') return word === 'on';
    throw new SpoolError(`${setting.name} is on or off`, `spool settings ${setting.name} on`);
  }
  const n = Number(word);
  if (!/^\d+$/.test(word) || n > 24 * 60) throw new SpoolError(`${setting.name} is a whole number of minutes`, `spool settings ${setting.name} 15`);
  return n;
}

const shown = (setting: Setting, v: boolean | number): string => (setting.kind === 'switch' ? (v ? 'on' : 'off') : `${v} min`);

/** `spool settings`: every setting kept here and what it is; with a name and a value, sets that one. */
export function settingsCommand(ctx: Ctx, args: string[], guard: () => void): { text: string; data: Record<string, boolean | number> } {
  if (args.length === 1 || args.length > 2) throw new SpoolError('a setting and its value', 'spool settings quick-reply off');
  let said = '';
  if (args.length === 2) {
    const setting = SETTINGS.find((s) => s.name === args[0]);
    if (!setting) throw new SpoolError(`"${args[0]}" is not a setting`, `One of: ${SETTINGS.map((s) => s.name).join(', ')}`);
    const value = valueOf(setting, args[1]!);
    if (value !== setting.read(ctx)) {
      guard();
      saveUserConfig(ctx, (config) => setting.write(config, value));
    }
    said = `${setting.name}: ${shown(setting, setting.read(ctx))}. ${setting.says}.`;
  }
  const data: Record<string, boolean | number> = {};
  const lines = SETTINGS.map((s) => {
    const v = s.read(ctx);
    data[s.name] = v;
    return `  ${s.name.padEnd(14)}${shown(s, v).padEnd(8)}${s.says}`;
  });
  const others = 'Also: spool builder (who builds, threads at once), spool target (usage), spool takeover, spool notify. The page has them all under Settings.';
  return { text: said ? said.trimEnd() : `Settings, for every project:\n${lines.join('\n')}\n${others}`, data };
}
