/**
 * Test harness: a temp directory, a controllable clock, and the CLI run
 * in-process exactly as a shell would run it.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { run, runLater } from '../src/cli.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// No test's page answers a reply with a quick reply of its own (quick.ts): that would start the real
// `claude`, or a stand-in written for something else. A test of the quick reply turns it back on.
process.env.SPOOL_QUICK_REPLY = 'off';

export interface Out {
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  /** Run it as a person at their own terminal would: the lock lets it through. */
  tty?: boolean;
}

export class Sandbox {
  readonly root: string;
  readonly dir: string;
  private clock: { now: number };

  constructor(root?: string, dir?: string, clock?: { now: number }) {
    this.root = root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spool-test-')));
    this.dir = dir ?? this.root;
    this.clock = clock ?? { now: Date.parse('2026-01-01T00:00:00Z') };
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** The same sandbox and clock, standing in a subdirectory. */
  cd(sub: string): Sandbox {
    return new Sandbox(this.root, path.join(this.dir, sub), this.clock);
  }

  advance(hours: number): void {
    this.clock.now += hours * 3_600_000;
  }

  /** Run a command. Each run moves the clock a minute so creation order is unambiguous. */
  exec(args: string[], options: RunOptions = {}): Out {
    const { ctx, said } = this.context(options);
    const before = this.builders();
    const result = said(run(args, ctx));
    if (args[0] === 'init' && !this.freshBuilder) this.restoreBuilders(before);
    return result;
  }

  /**
   * A project set up fresh is built from a chat. Most tests are about the page building, so a sandbox puts
   * the pick back to nothing said (Headless) after `init`; one testing a fresh project turns this on.
   */
  freshBuilder = false;

  private configFile(): string {
    return path.join(this.root, '.home', '.config', 'spool', 'config.json');
  }

  private builders(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.configFile(), 'utf8')).builder ?? {};
    } catch {
      return {};
    }
  }

  private restoreBuilders(before: Record<string, string>): void {
    if (JSON.stringify(this.builders()) === JSON.stringify(before)) return;
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(this.configFile(), 'utf8'));
    } catch {
      /* no file */
    }
    config.builder = before;
    // Nothing else was there: leave no file, as before.
    if (Object.keys(before).length === 0 && Object.keys(config).length === 1) return void fs.rmSync(this.configFile(), { force: true });
    fs.writeFileSync(this.configFile(), `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Run a command that works on, `spool loop`, and wait for it to stop. */
  async execLater(args: string[], options: RunOptions = {}): Promise<Out> {
    const { ctx, said } = this.context(options);
    const before = this.builders();
    const result = said(await runLater(args, ctx));
    if (args[0] === 'init' && !this.freshBuilder) this.restoreBuilders(before);
    return result;
  }

  /** The same, for a command that must succeed; returns its output. */
  async spLater(...args: string[]): Promise<string> {
    const result = await this.execLater(args);
    if (result.code !== 0) throw new Error(`spool ${args.join(' ')} failed (${result.code}): ${result.err || result.out}`);
    return result.out;
  }

  private context(options: RunOptions): { ctx: Parameters<typeof run>[1]; said: (code: number) => Out } {
    this.clock.now += 60_000;
    const out: string[] = [];
    const err: string[] = [];
    const ctx: Parameters<typeof run>[1] = {
      cwd: this.dir,
      env: { HOME: path.join(this.root, '.home'), ...options.env },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      now: () => new Date(this.clock.now),
      stdin: () => options.stdin ?? '',
      lines: (each) => (options.stdin ?? '').split('\n').forEach((line) => each(line)),
      color: false,
      inherit: false,
      tty: options.tty,
    };
    return { ctx, said: (code) => ({ code, out: out.join('\n'), err: err.join('\n') }) };
  }

  /** Run a command that must succeed; returns its output. */
  sp(...args: string[]): string {
    const result = this.exec(args);
    if (result.code !== 0) throw new Error(`spool ${args.join(' ')} failed (${result.code}): ${result.err || result.out}`);
    return result.out;
  }

  /** Run a command that must fail; returns its error text. */
  fails(...args: string[]): string {
    const result = this.exec(args);
    if (result.code === 0) throw new Error(`spool ${args.join(' ')} should have failed: ${result.out}`);
    return result.err;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json(...args: string[]): any {
    return JSON.parse(this.sp(...args, '--json'));
  }

  /** Create an item and return its id. */
  id(...args: string[]): string {
    const data = this.json(...args);
    const item = data.task ?? data.note ?? data.decision ?? data.skill;
    if (!item?.id) throw new Error(`no id in ${JSON.stringify(data)}`);
    return item.id;
  }

  write(file: string, text: string): void {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  read(file: string): string {
    return fs.readFileSync(path.join(this.dir, file), 'utf8');
  }

  exists(file: string): boolean {
    return fs.existsSync(path.join(this.dir, file));
  }

  item(id: string): string {
    return this.read(path.join('.spool', 'items', `${id}.md`));
  }

  git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** Make this directory a git repository that can commit without any global config. */
  gitInit(): void {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.email', 'test@example.com');
    this.git('config', 'user.name', 'Test');
    this.git('config', 'commit.gpgsign', 'false');
  }

  commitAll(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  cleanup(): void {
    // A stand-in agent may still be writing as it is ended: try again for a moment before giving up.
    fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** A sandbox with a spool already in it. */
export function spool(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo');
  return s;
}

/**
 * Wait until a `spool watch` started as a child has taken its first look: it leaves a file named
 * with its pid from then on. On a busy machine that can take seconds, and a change made before
 * it is not news to the watcher.
 */
export async function watchUp(pid: number | undefined): Promise<void> {
  const beat = path.join(os.tmpdir(), `spool-watch-${pid}.json`);
  await until('the watcher has taken its first look', () => fs.existsSync(beat), { every: 25 });
}

/**
 * How long a test waits for something to happen before it calls it broken. Generous, since several
 * suites may share the machine: a wait that polls returns as soon as its condition holds, so the
 * happy path is no slower for it.
 */
export const WAIT_MS = 30_000;

/**
 * Close what the tests in a file opened once they have all ended, however they ended. A test stuck
 * on a wait that never returns is stopped by the run's time limit (in package.json), but a browser
 * or a page it left running would keep its file from ever finishing, and CI would hang until the
 * job was killed. Closing twice is harmless, so a test that closes its own loses nothing; and one
 * browser or page shared by every test in a file stays open until the last.
 */
const leftOpen = new Set<() => Promise<unknown>>();
after(async () => {
  for (const close of leftOpen) await close().catch(() => {});
});
function closeWhenDone(close: () => Promise<unknown>): void {
  leftOpen.add(close);
}

/**
 * Wait until `look` gives something truthy, and return it. A look that throws (a page that is
 * restarting and answers nobody, a file not written yet) is tried again.
 */
export async function until<T>(what: string, look: () => T | Promise<T>, options: { timeout?: number; every?: number } = {}): Promise<Exclude<T, false | undefined | null | 0 | ''>> {
  const timeout = options.timeout ?? WAIT_MS;
  const every = options.every ?? 50;
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const found = await look();
      if (found) return found as Exclude<T, false | undefined | null | 0 | ''>;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= end) break;
    await pause(every);
  }
  throw new Error(`never happened: ${what}${last ? ` (last: ${last instanceof Error ? last.message : String(last)})` : ''}`);
}

/** A fixed wait. Only for checking that something does NOT happen; to wait for something, use `until`. */
export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a child process to have ended. */
export const gone = (child: ChildProcess): Promise<void> =>
  new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', () => r())));

/**
 * A port nobody is listening on, from the system. It is closed again before it is handed out, so
 * something else could take it in between: `startPage` tries once more when that happens.
 */
export async function freePort(): Promise<number> {
  return (await freePorts(1))[0]!;
}

/** Several free ports, all different: they are held open together until each is known. */
export async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as net.AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((r) => server.close(r))));
  return ports;
}

/** A `spool page` started by a test, and up. */
export interface Page {
  child: ChildProcess;
  url: string;
  port: number;
  /** The page's token, for posting to it. Empty if the page did not hand one out. */
  token: string;
  /** Everything the page, and any page that took over from it, has printed so far. */
  out: () => string;
  /** End the page as Ctrl-C would, so it ends its agents too, and wait until it is gone. */
  stop: () => Promise<void>;
}

export interface PageOptions {
  sandbox: Sandbox;
  /** Another copy of the CLI to run, for tests of a page that updates itself. */
  cli?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Start the CLI's `spool page` for a sandbox, on a free port, and resolve once it says where it is.
 * Pass `--port` among the args to name the port yourself (a page restarted where the last one
 * was); otherwise one is picked, and picked again if something took it first.
 */
export async function startPage(on: Sandbox | PageOptions, ...args: string[]): Promise<Page> {
  const options = on instanceof Sandbox ? { sandbox: on } : on;
  if (args.includes('--port')) return launchPage(options, args);
  try {
    return await launchPage(options, [...args, '--port', String(await freePort())]);
  } catch (error) {
    if (!/EADDRINUSE/.test(String(error))) throw error;
    return launchPage(options, [...args, '--port', String(await freePort())]);
  }
}

function launchPage(options: PageOptions, args: string[]): Promise<Page> {
  const s = options.sandbox;
  const child = spawn(process.execPath, [options.cli ?? CLI, 'page', '--no-open', '-C', s.root, ...args], {
    // The sandbox's home, and nothing from the shell the suite runs in that would change what the page does.
    env: {
      ...process.env,
      HOME: `${s.root}/.home`,
      XDG_CONFIG_HOME: undefined,
      CODEX_HOME: undefined,
      SPOOL_ACTOR: undefined,
      SPOOL_AGENT: undefined,
      SPOOL_PAGE_RESUME: undefined,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    const ended = await Promise.race([gone(child).then(() => true), pause(10_000).then(() => false)]);
    if (!ended) {
      child.kill('SIGKILL');
      await gone(child);
    }
  };
  closeWhenDone(stop);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the page did not start: ${out}`));
    }, WAIT_MS);
    const ended = (): void => {
      clearTimeout(timer);
      reject(new Error(`the page ended before it was up: ${out}`));
    };
    child.once('exit', ended);
    const look = async (): Promise<void> => {
      const found = /Spool page: (http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(out);
      if (!found) return;
      child.stdout!.off('data', look);
      child.off('exit', ended);
      clearTimeout(timer);
      const url = found[1]!;
      let token = '';
      try {
        token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())?.[1] ?? '';
      } catch {
        // A page already handing over to another: a test that needs the token reads it itself.
      }
      resolve({ child, url, port: Number(found[2]), token, out: () => out, stop });
    };
    child.stdout!.on('data', look);
  });
}

/**
 * The Chrome on this machine, through playwright-core; it throws where there is none, and the test
 * skips. Every page and context it makes waits twice Playwright's default before it gives up: a
 * browser on a busy machine can take that long to draw what a test waits for.
 *
 * Set SPOOL_WIDE_FONT and every page is drawn in Verdana, about as wide as the DejaVu Sans that
 * Linux, and so CI, draws it in: a Mac then shows what wraps or is cut on Linux.
 */
const WIDE_FONT = `document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = '* { font-family: Verdana, "DejaVu Sans", sans-serif !important; }';
  document.head.append(style);
});`;
export async function openChrome(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  closeWhenDone(() => browser.close());
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const context = await newContext(...a);
    context.setDefaultTimeout(2 * WAIT_MS);
    if (process.env.SPOOL_WIDE_FONT) await context.addInitScript(WIDE_FONT);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => {
    const page = await newPage(...a);
    page.setDefaultTimeout(2 * WAIT_MS);
    if (process.env.SPOOL_WIDE_FONT) await page.addInitScript(WIDE_FONT);
    return page;
  };
  return browser;
}
