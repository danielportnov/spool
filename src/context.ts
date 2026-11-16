/**
 * The outside world, passed in.
 *
 * Commands never touch `process` directly: the working directory, environment,
 * clock and output all arrive through a `Ctx`. That makes every command a
 * function the tests can call in-process against a temp directory.
 *
 * It is also where the line is drawn on running other programs. A repository's
 * `.spool/config.json` is data and is never executed. The two things Spool can
 * launch — a notifier and an agent — come only from the user's own machine:
 * an environment variable, or `~/.config/spool/config.json`. Cloning someone's
 * repo and running `spool` in it cannot run their code.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Item } from './model.ts';

export interface Ctx {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
  /** Piped input, read on demand for `--body -`. */
  stdin: () => string;
  /**
   * Piped input as it arrives, a line at a time. For `spool mcp`, the one command that holds a
   * conversation instead of running once: this returns at once, and the lines come later.
   */
  lines: (each: (line: string) => void) => void;
  color: boolean;
  /** Let a launched agent write straight to the terminal instead of being captured. */
  inherit: boolean;
  /** A person is at the keyboard: the command was typed into a real terminal, not run by a program. */
  tty?: boolean;
  /** How many columns wide the terminal is, where that is known. */
  columns?: number;
  /** The command comes from the Spool page, on a click the human made there. */
  human?: boolean;
}

export interface UserConfig {
  /** Shell command run when something needs the human. See `notify`. */
  notify?: string;
  /** Shell command `spool loop` starts for each task; the prompt arrives on stdin. */
  agent?: string;
  /**
   * Which model and effort each size of thread gets, where the thread does not say:
   * `{ "xs": { "model": "haiku", "effort": "low" }, … }` over the built-in table, or
   * `false` to leave the agent command exactly as it is, with no step up either. See agent.ts.
   */
  models?: false | Partial<Record<'xs' | 's' | 'm' | 'l' | 'xl', { model?: string; effort?: string }>>;
  /**
   * For each project, by the path of its folder: the command that must pass before a change there
   * can be finished. It is kept here, on the user's machine, and not in the project, because it is
   * run: a repository must never be able to name a program for Spool to start.
   */
  checks?: Record<string, string>;
  /**
   * For each project, by the path of its folder: who builds what is in Build. `"chat"` is a
   * Claude Code chat running the loop, and the page starts no agent of its own there. A project
   * not named here is built headless, by the page starting the agent command. Set on the page.
   */
  builder?: Record<string, string>;
  /**
   * How many agents the page runs at once, for every project: 3 unless set. Each works in a git
   * worktree of its own; a project that cannot have one is built one thread at a time whatever
   * this says, since two agents in one folder trample each other's edits. See slots.ts.
   */
  parallel?: number;
  /**
   * How much of their Claude plan the human wants used while a chat builds, in percent of each
   * limit: `{ "weekly": 80, "fiveHour": 90 }`. The plan is the account's, so one target holds in
   * every project. A chat building in Chat mode works up to it. Set on the page. See usage.ts.
   */
  usageTarget?: { weekly?: number; fiveHour?: number };
}

/** Threads built at once when nothing is said: each has a worktree of its own, and three is plenty. */
export const PARALLEL_DEFAULT = 3;

/** How many agents the page runs at once: a whole number, and one at least. */
export function parallelOf(ctx: Ctx): number {
  const asked = userConfig(ctx).parallel;
  return typeof asked === 'number' && Number.isInteger(asked) && asked >= 1 ? asked : PARALLEL_DEFAULT;
}

/** Who builds a project's threads: the page, starting the agent command itself, or a chat running the loop. */
export type Builder = 'headless' | 'chat';

export function builderOf(ctx: Ctx, root: string): Builder {
  return userConfig(ctx).builder?.[root] === 'chat' ? 'chat' : 'headless';
}

export function saveBuilder(ctx: Ctx, root: string, builder: Builder): void {
  saveUserConfig(ctx, (config) => {
    const all = { ...(config.builder ?? {}) };
    // Headless is what a project is with nothing said, so nothing is kept for it.
    if (builder === 'chat') all[root] = 'chat';
    else delete all[root];
    config.builder = all;
  });
}

/** The folder of Spool's own files on this machine, `~/.config/spool`: empty where there is no home. */
export function configDir(ctx: Ctx): string {
  const base = ctx.env.XDG_CONFIG_HOME || (ctx.env.HOME ? path.join(ctx.env.HOME, '.config') : '');
  return base ? path.join(base, 'spool') : '';
}

function userConfigFile(ctx: Ctx): string {
  const dir = configDir(ctx);
  return dir ? path.join(dir, 'config.json') : '';
}

/** Change the user's own settings, leaving everything else in the file as it was. */
export function saveUserConfig(ctx: Ctx, change: (config: UserConfig) => void): string {
  const file = userConfigFile(ctx);
  if (!file) throw new Error('no home directory to keep settings in');
  const config = userConfig(ctx);
  change(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

export function userConfig(ctx: Ctx): UserConfig {
  const base = ctx.env.XDG_CONFIG_HOME || (ctx.env.HOME ? path.join(ctx.env.HOME, '.config') : '');
  if (!base) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(base, 'spool', 'config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as UserConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Tell the human something needs them. Runs the user's notifier with the
 * details in SPOOL_* variables; a missing or failing notifier is never an error.
 */
export function notify(ctx: Ctx, event: 'ask' | 'plan' | 'idle' | 'permission', title: string, item?: Item): boolean {
  const command = ctx.env.SPOOL_NOTIFY ?? userConfig(ctx).notify;
  if (!command) return false;
  spawnSync(command, {
    shell: true,
    stdio: 'ignore',
    timeout: 15_000,
    cwd: ctx.cwd,
    env: {
      ...ctx.env,
      SPOOL_EVENT: event,
      SPOOL_TITLE: title,
      SPOOL_ID: item?.id ?? '',
      SPOOL_PROJECT: item?.spool.name ?? '',
    },
  });
  return true;
}
