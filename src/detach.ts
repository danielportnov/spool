/**
 * A page that runs on its own: `spool page -d`, `--status` and `--stop`.
 *
 * Every page, detached or not, says where it is in one small file on the user's machine, kept by
 * the project's folder: which process holds it, at what address, since when. That is how a second
 * start finds the first instead of taking the next port, and how `--status` and `--stop` find it
 * from any terminal or chat. A page started at the top of a folder of projects builds every one of
 * them, so its record names them all, and a command inside any of them finds that page by looking
 * up the folders above it: one page to a project, wherever it was started. It lives under `~/.config/spool/pages/`, not in the project, since it
 * is about this machine's processes and nothing in it belongs in a commit.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Result } from './commands.ts';
import { builderOf, type Ctx } from './context.ts';
import { SpoolError } from './model.ts';

export interface PageRecord {
  /** The process to signal: the one a terminal or `-d` started, which a restarting page stays under. */
  pid: number;
  url: string;
  /** The project's folder, as `builderOf` keys it. */
  root: string;
  /**
   * Every project the page builds, by its real folder: the one it was started for and, started at
   * the top with no project named, each one below. A command in any of them finds the page by it.
   * Missing from a record an older Spool wrote.
   */
  roots?: string[];
  project?: string;
  since: string;
  /** Agents were on when it started; the page itself says how they are now. */
  run: boolean;
  detached: boolean;
  /**
   * What the page's buttons send with every change. A command on this machine reads it here to
   * press one (`spool agents on`), so the file is the user's alone to read.
   */
  token?: string;
}

function pagesDir(ctx: Ctx): string {
  const base = ctx.env.XDG_CONFIG_HOME || (ctx.env.HOME ? path.join(ctx.env.HOME, '.config') : '');
  if (!base) throw new SpoolError('no home directory to keep the page’s address in');
  return path.join(base, 'spool', 'pages');
}

function fileOf(ctx: Ctx, root: string, ext: string): string {
  return path.join(pagesDir(ctx), `${createHash('sha256').update(root).digest('hex').slice(0, 16)}${ext}`);
}

export function logOf(ctx: Ctx, root: string): string {
  return fileOf(ctx, root, '.log');
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // There, but someone else's to signal: it is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A folder as the disk has it, links followed, so two ways of naming one folder are one. */
export function realOf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The record a living page left for this folder. One left by a page that died without a word is ignored. */
function recordAt(ctx: Ctx, dir: string): PageRecord | undefined {
  try {
    const found = JSON.parse(fs.readFileSync(fileOf(ctx, dir, '.json'), 'utf8')) as PageRecord;
    if (typeof found.pid === 'number' && typeof found.url === 'string' && alive(found.pid)) return found;
  } catch {
    // No record, or not one a page wrote: no page.
  }
  return undefined;
}

/**
 * The page up for this project, if there is one: the one started in its own folder, or else one
 * started in a folder above it that builds it too. The nearest wins, as the nearest spool does.
 */
export function pageUp(ctx: Ctx, root: string): PageRecord | undefined {
  const own = recordAt(ctx, root);
  if (own) return own;
  const real = realOf(root);
  const seen = new Set([root, real]);
  for (const start of [real, path.resolve(root)]) {
    for (let dir = path.dirname(start); !seen.has(dir); dir = path.dirname(dir)) {
      seen.add(dir);
      const found = recordAt(ctx, dir);
      if (found && serves(found, real)) return found;
    }
  }
  return undefined;
}

/** Whether a page started in a folder above builds the project in `real`. */
function serves(record: PageRecord, real: string): boolean {
  // Its own word, where it gave one.
  if (Array.isArray(record.roots)) return record.roots.includes(real);
  // An older page: started with no project named, it builds every project below it.
  return !record.project;
}

export function rememberPage(ctx: Ctx, record: PageRecord): void {
  try {
    const file = fileOf(ctx, record.root, '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written whole and then moved into place, so a reader never sees half of it. Readable by this
    // user only: it holds the page's token, and with it anyone could press the page's buttons. The
    // token keeps other websites out; this keeps other users of the machine out.
    const part = `${file}.${process.pid}`;
    fs.writeFileSync(part, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    // A part left over from a process with the same pid kept the mode it was made with.
    fs.chmodSync(part, 0o600);
    fs.renameSync(part, file);
  } catch {
    // A page that cannot say where it is still works: only --status and --stop will not find it.
  }
}

/** Remove the record, if it is still the one this process wrote: a page started since keeps its own. */
export function forgetPage(ctx: Ctx, root: string, pid: number): void {
  try {
    const file = fileOf(ctx, root, '.json');
    const found = JSON.parse(fs.readFileSync(file, 'utf8')) as PageRecord;
    if (found.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Start the page as a process of its own, away from this terminal, and tell `done` once it is
 * listening: the lines to say, and its record. With no record it is not up, and the lines say why;
 * the code is what the command that asked should end with. The page itself is the ordinary one, so
 * it restarts onto new code as any page does.
 */
export function startDetached(ctx: Ctx, root: string, cli: string, args: string[], done: (code: number, lines: string[], up?: PageRecord) => void): void {
  const log = logOf(ctx, root);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'w');
  const child = spawn(process.execPath, [...process.execArgv, cli, 'page', '--no-open', ...args], {
    cwd: ctx.cwd,
    // Its own session: closing the terminal, or the chat ending, does not reach it.
    detached: true,
    stdio: ['ignore', fd, fd],
    // Said in the environment, since a page that restarts hands that on and nothing else.
    env: { ...ctx.env, SPOOL_PAGE_RESUME: undefined, SPOOL_PAGE_DETACHED: '1' },
  });
  fs.closeSync(fd);
  const said = (): string => {
    try {
      return fs.readFileSync(log, 'utf8').trim();
    } catch {
      return '';
    }
  };
  let over = false;
  const finish = (code: number, lines: string[], up?: PageRecord): void => {
    if (over) return;
    over = true;
    // The page stays up without this process.
    child.unref();
    done(code, lines, up);
  };
  child.on('error', (error) => finish(1, [`spool: the page could not start: ${error.message}`]));
  child.on('exit', (code) => {
    const why = said().replace(/^spool: /, '');
    finish(code === 0 ? 0 : 1, code === 0 ? [why] : [`spool: the page did not start${why ? `: ${why.replace(/^the page could not start: /, '')}` : ''}`]);
  });
  const started = Date.now();
  const look = (): void => {
    if (over) return;
    const up = pageUp(ctx, root);
    if (up && up.pid === child.pid) {
      const lines = [`Spool page: ${up.url}`];
      const run = said().split('\n').find((line) => line.startsWith('Agents are on') || line.startsWith('A chat builds'));
      if (run) lines.push(run);
      lines.push('It runs in the background, with no browser and no terminal to keep open. spool page --stop ends it.');
      return finish(0, lines, up);
    }
    if (Date.now() - started > 15_000) {
      child.kill('SIGTERM');
      return finish(1, [`spool: the page did not start in time. What it said is in ${log}`]);
    }
    setTimeout(look, 50);
  };
  look();
}

/** `spool page -d`: start the page in the background, and come back with its address once it is listening. */
export function detachPage(ctx: Ctx, root: string, cli: string, args: string[]): Result {
  startDetached(ctx, root, cli, args, (code, lines) => {
    for (const line of lines) (code ? ctx.err : ctx.out)(line);
    process.exitCode = code;
    // Out with the words, and gone.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });
  return { text: '' };
}

/** A line saying the page was started in a folder above this project, where it was; none where it is this project's own. */
export function startedAbove(up: PageRecord, root: string): string[] {
  return realOf(up.root) === realOf(root) ? [] : [`It was started in ${up.root}, and builds this project too.`];
}

/** `spool page --status`: whether a page is up for this project, where, since when, and who builds. */
export function pageStatus(ctx: Ctx, root: string): Result {
  const up = pageUp(ctx, root);
  if (!up) return { text: 'No Spool page is up for this project. spool page -d starts one.' };
  const above = startedAbove(up, root);
  const since = new Date(up.since);
  const when = `${since.toLocaleDateString('en-CA')} ${since.toTimeString().slice(0, 5)}`;
  const builds = builderOf(ctx, root) === 'chat' ? 'A chat builds here (Chat).' : 'The page builds here itself (Headless).';
  const head = [`Spool page: ${up.url}`, ...above, `Up since ${when}, ${up.detached ? 'in the background' : 'in a terminal'} (pid ${up.pid}).`];
  // Agents are switched on the page, so the page is asked; the record only knows how they started.
  fetch(new URL('api/board', up.url), { signal: AbortSignal.timeout(3000) })
    .then((res) => res.json() as Promise<{ runner?: { on?: boolean } }>)
    .then((board) => ctx.out([...head, `Agents are ${board.runner?.on ? 'on' : 'off'}. ${builds}`].join('\n')))
    .catch(() => {
      ctx.out([...head, `Agents were ${up.run ? 'on' : 'off'} when it started. ${builds}`, 'It is not answering just now.'].join('\n'));
    });
  return { text: '' };
}

/** `spool page --stop`: end the page as Ctrl-C would, so its agent is ended and its thread put back. */
export function stopPage(ctx: Ctx, root: string): Result {
  const up = pageUp(ctx, root);
  if (!up) return { text: 'No Spool page is up for this project.' };
  const above = startedAbove(up, root);
  try {
    process.kill(up.pid, 'SIGTERM');
  } catch (error) {
    throw new SpoolError(`could not stop the page (pid ${up.pid}): ${(error as Error).message}`);
  }
  const started = Date.now();
  const look = (): void => {
    if (!alive(up.pid)) {
      forgetPage(ctx, up.root, up.pid);
      ctx.out([`Stopped the Spool page at ${up.url}`, ...above].join('\n'));
      return;
    }
    if (Date.now() - started > 10_000) {
      ctx.err(`spool: the page (pid ${up.pid}) has not stopped yet`);
      process.exitCode = 1;
      return;
    }
    setTimeout(look, 50);
  };
  look();
  return { text: '' };
}
