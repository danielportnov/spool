/**
 * The page keeping its own code current.
 *
 * A page serves the code it was started from. `Upkeep` is what gets it onto newer code: it
 * knows which files that code is (`codeStamp`, `buildId`), rebuilds Spool where the page is
 * building Spool's own checkout, and restarts the page once the code on disk is no longer the
 * code it loaded and no agent of its own is at work. The runner asks it, once a tick, whether
 * anything new may be started.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { columnOf } from './board.ts';
import type { Ctx } from './context.ts';
import type { Runner } from './engine.ts';
import { oneLine } from './model.ts';
import { taskState, tasks } from './schedule.ts';
import { endGroup } from './session.ts';
import { Workspace } from './store.ts';

/** Where the code this page runs was loaded from: the package's dist/, or src/ when it is run from source. */
const CODE_FILE = fileURLToPath(import.meta.url);
export const CODE_DIR = path.dirname(CODE_FILE);
export const CODE_EXT = path.extname(CODE_FILE);

/** The code files beside this one, and those in the folders beside it (the page's client is in one), each by its path from here. */
function codeFiles(dir = ''): string[] {
  return fs
    .readdirSync(path.join(CODE_DIR, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? codeFiles(path.join(dir, entry.name)) : entry.name.endsWith(CODE_EXT) ? [path.join(dir, entry.name)] : []))
    .sort();
}

/** The size and time of every code file: cheap to take, and different whenever a build has written. */
function codeStamp(): string {
  try {
    return codeFiles()
      .map((name) => {
        const stat = fs.statSync(path.join(CODE_DIR, name));
        return `${name} ${stat.size} ${stat.mtimeMs}`;
      })
      .join('\n');
  } catch {
    return ''; // A build is moving the files about; the next look sees them.
  }
}

/** A short name for exactly this code. The same files with the same contents always give the same one. */
export function buildId(): string {
  try {
    const hash = createHash('sha256');
    for (const name of codeFiles()) hash.update(`${name}\n`).update(fs.readFileSync(path.join(CODE_DIR, name))).update('\n');
    return hash.digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * Spool building Spool. The page serves the code it was started from. Where that is a checkout
 * of Spool with its sources beside it, and not an installed copy, the code is only as new as the
 * last `npm run build`; and where that checkout is a project this page builds, agents are
 * changing those sources. Only then does the page rebuild, and this is the folder to do it in.
 */
function ownCheckout(ctx: Ctx, project: string | undefined): string | undefined {
  const root = path.dirname(CODE_DIR);
  try {
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts;
    if (typeof scripts?.build !== 'string' || !fs.statSync(path.join(root, 'src')).isDirectory()) return undefined;
    const real = fs.realpathSync(root);
    const ws = Workspace.open(ctx.cwd, ctx.now);
    try {
      const built = project ? [ws.project(project)] : ws.spools;
      return built.some((s) => fs.realpathSync(s.root) === real) ? root : undefined;
    } finally {
      ws.close();
    }
  } catch {
    return undefined; // No package.json, no sources, no spool: nothing of Spool's own to build here.
  }
}

/** How long the code on disk must have been still before it is taken for a finished build. */
const SETTLE_MS = 2000;
/** What the page says while it lets its agents finish before restarting onto new code. */
const DRAINING = 'A new build of Spool is on disk. Nothing new is started until the agents at work now have finished; then this page restarts onto it.';
/** How long new work waits for a restart that is on its way. */
const HOLD_MS = 30_000;
const REBUILD_MINUTES = 10;

/**
 * The page keeping its own code current, so that what is marked done is what the page shows.
 * Two things, looked at once a second:
 *
 *   - When Build and Building have both emptied after work was in them, and this page builds
 *     Spool's own checkout, it runs `npm run build` there. Never sooner: a build made while a
 *     thread is being built bakes in an agent's half-made edits, and a `spool` call made while
 *     the build writes can find half a file.
 *   - When the code on disk is no longer the code this process loaded (that rebuild, anyone
 *     else's, an upgrade, or a thread landing on Spool's own sources), it starts nothing new,
 *     and once no agent of this page's is running it restarts onto it. The
 *     board carries the name of the build that serves it, and an open page that sees another
 *     name reloads itself.
 *
 * A build that failed, or one that does not start, is never restarted onto: the page stays as it
 * is, and says so.
 */
export class Upkeep {
  /** The name of the code this process loaded. */
  readonly build: string;
  /** What the human should know about the page itself, shown on it: it is rebuilding, or a rebuild failed. */
  notice = '';
  /** The code on disk as it was when this process loaded it, or as it was last found to be the same. */
  private loaded: string;
  /** The newest code on disk that is not what was loaded: when it was first seen so, and its name once worked out. */
  private seen = { stamp: '', at: 0, id: '' };
  /** When the code on disk was first found changed, for as long as that is not settled. */
  private changed = 0;
  /** Code on disk that is not to be started: a failed build left it, or it was tried and did not start. */
  private refused = '';
  /** Something has been in Build or Building since the last rebuild. */
  private worked = false;
  /** How many threads the runner had handed out at the last look. */
  private counted = 0;
  private building = false;
  private over = false;
  private ctx: Ctx;
  private project: string | undefined;
  private runner: Runner;
  private own: string | undefined;
  private restart: ((agentsOn: boolean) => void) | undefined;

  constructor(ctx: Ctx, project: string | undefined, runner: Runner, restart?: (agentsOn: boolean) => void) {
    this.ctx = ctx;
    this.project = project;
    this.runner = runner;
    this.build = buildId();
    this.loaded = codeStamp();
    this.own = ownCheckout(ctx, project);
    // With no name for what was loaded, there is nothing to hold the disk against.
    this.restart = this.build && this.loaded ? restart : undefined;
  }

  /** One look. True while nothing new should be started: a rebuild is running, or a restart is on its way. */
  check(): boolean {
    if (this.over) return true;
    try {
      this.rebuildWhenIdle();
      return this.restartWhenNew() || this.building;
    } catch {
      return this.building; // The spool was busy for an instant; the next look is a second away.
    }
  }

  close(): void {
    this.over = true;
  }

  private rebuildWhenIdle(): void {
    if (!this.own || this.building) return;
    // A thread the runner took the moment it landed in Build may be finished before this look: it was work.
    if (this.counted !== this.runner.handedOut) {
      this.counted = this.runner.handedOut;
      this.worked = true;
    }
    // An agent that has said done may still be on its way out: it counts until it has gone.
    let busy = this.runner.runs.size > 0;
    if (!busy) {
      const ws = Workspace.open(this.ctx.cwd, this.ctx.now);
      try {
        busy = tasks(ws, this.project).some((t) => {
          const column = columnOf(taskState(ws, t));
          return column === 'build' || column === 'building';
        });
      } finally {
        ws.close();
      }
    }
    if (busy) {
      this.worked = true;
      return;
    }
    if (!this.worked) return;
    this.worked = false;
    this.rebuild(this.own);
  }

  private rebuild(root: string): void {
    const kept = path.join(os.tmpdir(), `spool-rebuild-${process.pid}.log`);
    let log: number | undefined;
    try {
      log = fs.openSync(kept, 'w');
    } catch {
      log = undefined; // Nowhere to keep what it prints; it runs all the same.
    }
    this.building = true;
    this.notice = 'Build and Building are empty, so Spool is being rebuilt. This page reloads itself if anything changed.';
    const child = spawn('npm run build', {
      shell: true,
      cwd: root,
      // Printing to a file, in a group of its own: a page stopped mid-build must not leave half a build behind.
      stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      detached: process.platform !== 'win32',
      env: this.ctx.env,
    });
    if (log !== undefined) fs.closeSync(log);
    const timer = setTimeout(() => endGroup(child), REBUILD_MINUTES * 60_000);
    let ended = false;
    const end = (failed: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      let said = '';
      try {
        // The last thing the build itself said, past npm's own lines about it.
        const lines = fs.readFileSync(kept, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
        said = lines.filter((line) => !/^(npm |>)/.test(line)).at(-1) ?? lines.at(-1) ?? '';
        fs.rmSync(kept, { force: true });
      } catch {
        // What it printed is lost; how it ended is still known.
      }
      this.building = false;
      if (!failed) {
        this.notice = '';
        return;
      }
      // Whatever a failed build left on disk is not started.
      this.refused = codeStamp();
      this.notice = `Rebuilding Spool ${failed}, so this page is still the build from before${said ? `: ${oneLine(said, 300)}` : '.'}`;
    };
    child.on('error', (error) => end(`could not run (${error.message})`));
    child.on('exit', (code, signal) => end(code === 0 ? '' : signal ? `was stopped (${signal})` : `failed (exit ${code})`));
  }

  /**
   * True while a restart is on its way, so that nothing is started only to be ended by it. With
   * several agents at once, one finishing makes room for the next, and a moment with none at work
   * might never come: so once new code is waiting, nothing new starts, and the page restarts as
   * soon as the last agent has gone.
   */
  private restartWhenNew(): boolean {
    if (!this.restart) return false;
    if (this.notice === DRAINING) this.notice = '';
    const stamp = codeStamp();
    if (!stamp || stamp === this.loaded || stamp === this.refused) {
      this.changed = 0;
      return false;
    }
    const now = Date.now();
    if (stamp !== this.seen.stamp) this.seen = { stamp, at: now, id: '' };
    this.changed ||= now;
    const soon = now - this.changed < HOLD_MS;
    // A build may still be writing: wait until the files have been still for a moment.
    if (this.building || now - this.seen.at < SETTLE_MS) return soon;
    this.seen.id ||= buildId();
    if (!this.seen.id) return soon;
    if (this.seen.id === this.build) {
      // Written again, and the same code: there is nothing to restart for.
      this.loaded = stamp;
      this.changed = 0;
      return false;
    }
    // Never under an agent: a restart would end it. It comes when the last of them has gone, and none is started meanwhile.
    if (this.runner.runs.size) {
      this.notice = DRAINING;
      return true;
    }
    if (!this.starts()) {
      this.refused = stamp;
      this.changed = 0;
      this.notice = 'A new build of Spool is on disk, but it does not start, so this page is still the build from before.';
      return false;
    }
    try {
      this.restart(this.runner.on);
    } catch {
      // It could not be handed over; this page carries on as it is.
      this.refused = stamp;
      this.changed = 0;
      return false;
    }
    this.over = true;
    return true;
  }

  /** Whether the code now on disk starts at all: the whole of it is loaded, in a process of its own. */
  private starts(): boolean {
    const ran = spawnSync(process.execPath, [...process.execArgv, path.join(CODE_DIR, `cli${CODE_EXT}`), '--version'], { stdio: 'ignore', timeout: 30_000 });
    return ran.status === 0;
  }
}
