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
  color: boolean;
  /** Let a launched agent write straight to the terminal instead of being captured. */
  inherit: boolean;
}

export interface UserConfig {
  /** Shell command run when something needs the human. See `notify`. */
  notify?: string;
  /** Shell command `spool loop` starts for each task; the prompt arrives on stdin. */
  agent?: string;
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
export function notify(ctx: Ctx, event: 'ask' | 'plan' | 'idle', title: string, item?: Item): boolean {
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
