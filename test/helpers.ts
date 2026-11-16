/**
 * Test harness: a temp directory, a controllable clock, and the CLI run
 * in-process exactly as a shell would run it.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

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
    this.clock.now += 60_000;
    const out: string[] = [];
    const err: string[] = [];
    const code = run(args, {
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
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
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
  for (let i = 0; i < 600 && !fs.existsSync(beat); i++) await new Promise((r) => setTimeout(r, 25));
  if (!fs.existsSync(beat)) throw new Error('the watcher did not start');
}
