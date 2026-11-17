/**
 * The store: plain files, no database, no daemon.
 *
 * A spool is a `.spool/` directory inside a project. A workspace is the spool
 * you are standing in plus every spool nested below it — run from a folder of
 * projects and you see all of them; run from inside one and you see just that
 * one. Nothing has to be registered; a nested project is found by walking.
 *
 * Writes are atomic (temp file + rename) and serialised by a lock file per
 * spool, so several agents and a recorder can work the same queue at once.
 * The queue is ignored by git unless a project chooses to share it; shared,
 * history is git's job, and every item is a small file that diffs cleanly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomInt } from 'node:crypto';
import { parseFrontmatter } from './frontmatter.ts';
import { type QueueWriter, writeQueue } from './queue-journal.ts';
import {
  type Config,
  type Item,
  type Kind,
  KINDS,
  type Spool,
  SpoolError,
  deserialize,
  serialize,
  timestamp,
} from './model.ts';

export const SPOOL_DIR = '.spool';
/** Inside a spool: the git worktrees of the threads being built in one of their own. See worktree.ts. */
export const WORKTREES_DIR = 'worktrees';
export const DEFAULT_SKILLS_DIR = '.claude/skills';
const SKILL_DIRS = [DEFAULT_SKILLS_DIR, '.agents/skills'];

/** Directories that never contain projects and are expensive to walk. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
  'venv',
  'coverage',
  '__pycache__',
  'Library',
  'Pods',
  'DerivedData',
  'Temp',
  'obj',
]);

/** No 0/1/i/l/o/u: ids survive being read aloud and typed back. */
const ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 8_000;

/** A SKILL.md found on disk, whether or not Spool wrote it. */
export interface SkillFile {
  name: string;
  description: string;
  /** Absolute path of the skill's directory. */
  dir: string;
  /** The directory relative to the owning project. */
  rel: string;
  /** The nearest project at or above the skill. */
  spool: Spool;
}

export interface Problem {
  file: string;
  message: string;
}

/** Told of every item written while a run is on, so the run can be undone as one. See journal.ts. */
export interface Recorder {
  /** Before an item's file is written, while what was there is still there to keep. */
  keep(item: Item, file: string): void;
  /** After it is written, with the text that was. */
  wrote(item: Item, file: string, text: string): void;
}

/**
 * The project a folder inside a thread's worktree belongs to, or null anywhere else.
 *
 * A worktree is kept inside the spool it belongs to, at `<root>/.spool/worktrees/<id>`. Where the
 * queue is kept in git, the worktree holds a copy of it, as it was when the worktree was cut. That
 * copy must never be read or written: there is one queue, and it is the project's.
 */
export function worktreeOwner(from: string): string | null {
  let owner: string | null = null;
  let dir = path.resolve(from);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return owner;
    if (path.basename(parent) === WORKTREES_DIR && path.basename(path.dirname(parent)) === SPOOL_DIR) {
      const root = path.dirname(path.dirname(parent));
      if (fs.existsSync(path.join(root, SPOOL_DIR, 'config.json'))) owner = root;
    }
    dir = parent;
  }
}

export function findHome(from: string): string | null {
  // From inside a thread's worktree, the spool is the one the worktree belongs to.
  let dir = worktreeOwner(from) ?? path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, SPOOL_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A folder below `from`, given the way a person would say it: a path, or just
 * its name, spoken loosely ("sky hop" for games/sky_hop). An exact path
 * wins; otherwise the name must match exactly one folder within a few levels.
 */
export function findFolder(from: string, ref: string, maxDepth = 4): string {
  const exact = path.resolve(from, ref);
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return exact;
  const norm = (text: string) => text.toLowerCase().replace(/[\s_.-]+/g, '');
  const want = norm(ref.replace(/[\\/]+$/, ''));
  if (!want) throw new SpoolError('which folder?');
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      // "sky hop" names the folder; "games/sky hop" names it by its path from here.
      // A project often holds a folder of its own name (an Xcode or Unity project, a package). The outer one is meant.
      if (norm(entry.name) === want || norm(toPosix(path.relative(from, child)).replaceAll('/', '')) === want.replaceAll('/', '')) found.push(child);
      else if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk(from, 1);
  const shown = (dirs: string[]) => dirs.map((d) => toPosix(path.relative(from, d))).join(', ');
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new SpoolError(`"${ref}" matches several folders: ${shown(found)}`, 'Say which, by its path');
  throw new SpoolError(`no folder "${ref}" here`, 'Give a path, or the name of a folder within this one');
}

export function readConfig(root: string): Config {
  const file = path.join(root, SPOOL_DIR, 'config.json');
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') return { version: 1, ...(parsed as object) } as Config;
  } catch (error) {
    throw new SpoolError(`cannot read ${file}: ${(error as Error).message}`);
  }
  throw new SpoolError(`${file} must hold a JSON object`);
}

// ------------------------------------------------------------ switched off

/** What is said where a spool is switched off (`spool disable`), to a person or an agent. */
export function offError(name: string): SpoolError {
  return new SpoolError(
    `Spool is off in ${name}`,
    "Nothing here goes through it: work as you would without Spool. spool enable turns it back on, on the human's word.",
  );
}

/** Whether the spool at `root` is switched off. One whose config cannot be read is not: opening it says what is wrong. */
export function isOff(root: string): boolean {
  try {
    return !!readConfig(root).disabled;
  } catch {
    return false;
  }
}

/** Refuse to work the spool this folder is in, if it is switched off. */
export function refuseIfOff(cwd: string): void {
  const root = findHome(cwd);
  if (root && isOff(root)) throw offError(readConfig(root).name || path.basename(root));
}

/** Every spool in a folder and below it, the folder's own first and the rest by path: what `--all` switches. */
export function spoolsUnder(from: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (fs.existsSync(path.join(dir, SPOOL_DIR, 'config.json'))) found.push(dir);
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Hidden folders are never walked, so a thread's worktree (inside .spool/) is not taken for a project.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(path.resolve(from), 0);
  return found;
}

/** The configured skills directory, refused if it would escape the project. */
export function skillsDir(spool: Spool): string {
  const rel = spool.config.skillsDir ?? DEFAULT_SKILLS_DIR;
  const abs = path.resolve(spool.root, rel);
  if (abs !== spool.root && !abs.startsWith(spool.root + path.sep)) {
    throw new SpoolError(`skillsDir "${rel}" points outside the project`, `Fix it in ${path.join(spool.dir, 'config.json')}`);
  }
  return abs;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take the same project lock for setup writes that do not open a workspace. */
export function withSpoolLock<T>(dir: string, action: () => T): T {
  const release = lockSpool(dir);
  try {
    return action();
  } finally {
    release();
  }
}

function lockSpool(dir: string): () => void {
  const file = path.join(dir, '.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Someone else is writing. A lock older than any command should take was left by a crash.
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) throw new SpoolError(`another spool command is holding ${file}`, 'Try again in a moment.');
    sleep(20);
  }
}

export class Workspace {
  readonly spools: Spool[] = [];
  readonly items: Item[] = [];
  readonly skills: SkillFile[] = [];
  readonly problems: Problem[] = [];
  readonly home: Spool;
  readonly now: () => Date;
  /** Set for a command run under a run (`SPOOL_RUN`). */
  recorder?: Recorder;
  writer: QueueWriter = { actor: 'agent', command: 'workspace' };
  private readonly byId = new Map<string, Item>();
  private held: (() => void)[] = [];

  private constructor(home: Spool, now: () => Date) {
    this.home = home;
    this.now = now;
  }

  /** Open the workspace around `cwd`. Pass `write` to hold the locks until `close()`. */
  static open(cwd: string, now: () => Date = () => new Date(), write = false): Workspace {
    const root = findHome(cwd);
    if (!root) {
      throw new SpoolError('no .spool/ here or in any parent directory', 'Start one with: spool init');
    }
    const config = readConfig(root);
    const home: Spool = {
      root,
      dir: path.join(root, SPOOL_DIR),
      name: config.name || path.basename(root),
      home: true,
      config,
    };
    const ws = new Workspace(home, now);
    ws.spools.push(home);
    ws.walk(root, 0, home, new Set(config.ignore ?? []), config.depth ?? 4);
    if (write) ws.lock();
    try {
      for (const spool of ws.spools) ws.load(spool);
    } catch (error) {
      ws.close();
      throw error;
    }
    // Ids are random, so file order means nothing. Creation order is the one every listing shares.
    ws.items.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    return ws;
  }

  close(): void {
    for (const release of this.held) release();
    this.held = [];
  }

  // -------------------------------------------------------------- discovery

  private walk(dir: string, depth: number, owner: Spool, ignore: Set<string>, maxDepth: number): void {
    const probes = new Set(SKILL_DIRS);
    if (dir === owner.root && owner.config.skillsDir) probes.add(owner.config.skillsDir);
    for (const rel of probes) this.probeSkills(path.resolve(dir, rel), owner);
    if (depth >= maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name) || ignore.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      let childOwner = owner;
      if (fs.existsSync(path.join(child, SPOOL_DIR, 'config.json'))) {
        try {
          const config = readConfig(child);
          // A project switched off is left out of the folder above it, with everything under it.
          if (config.disabled) continue;
          childOwner = {
            root: child,
            dir: path.join(child, SPOOL_DIR),
            name: toPosix(path.relative(this.home.root, child)),
            home: false,
            config,
          };
          this.spools.push(childOwner);
        } catch (error) {
          this.problems.push({ file: path.join(child, SPOOL_DIR, 'config.json'), message: (error as Error).message });
        }
      }
      this.walk(child, depth + 1, childOwner, ignore, maxDepth);
    }
  }

  private probeSkills(dir: string, owner: Spool): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      if (this.skills.some((s) => s.dir === skillDir)) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      const field = (key: string): string => {
        const value = fm.data.get(key);
        return (Array.isArray(value) ? value.join(', ') : (value ?? '')).trim();
      };
      this.skills.push({
        name: field('name') || entry.name,
        description: field('description'),
        dir: skillDir,
        rel: toPosix(path.relative(owner.root, skillDir)),
        spool: owner,
      });
    }
  }

  // ---------------------------------------------------------------- locking

  private lock(): void {
    const targets = this.spools.map((s) => s.dir).sort();
    try {
      for (const dir of targets) this.held.push(lockSpool(dir));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  // ------------------------------------------------------------------ items

  private load(spool: Spool): void {
    const dir = path.join(spool.dir, 'items');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(dir, name);
      try {
        const item = deserialize(fs.readFileSync(file, 'utf8'), spool);
        if (`${item.id}.md` !== name) throw new Error(`id "${item.id}" does not match the file name`);
        if (this.byId.has(item.id)) throw new Error(`id "${item.id}" is also used in ${this.byId.get(item.id)!.spool.name}`);
        this.items.push(item);
        this.byId.set(item.id, item);
      } catch (error) {
        // One unreadable file must not take the whole queue down; `spool check` reports it.
        this.problems.push({ file, message: (error as Error).message });
      }
    }
  }

  file(item: Item): string {
    return path.join(item.spool.dir, 'items', `${item.id}.md`);
  }

  find(id: string): Item | undefined {
    return this.byId.get(id);
  }

  /** Resolve what a person or agent typed — exact id, id without the dash, or a unique prefix. */
  get(ref: string, kind?: Kind): Item {
    let key = ref.trim().toLowerCase().replace(/^\[\[|\]\]$/g, '');
    if (/^[ntds][a-z0-9]{3,}$/.test(key) && !key.includes('-')) key = `${key[0]}-${key.slice(1)}`;
    let item = this.byId.get(key);
    if (!item) {
      const matches = this.items.filter((i) => i.id.startsWith(key));
      if (matches.length > 1) {
        throw new SpoolError(`"${ref}" matches ${matches.length} items: ${matches.map((m) => m.id).join(', ')}`);
      }
      item = matches[0];
    }
    if (!item) throw new SpoolError(`no item "${ref}"`, 'See what exists with: spool list --all');
    if (kind && item.kind !== kind) {
      throw new SpoolError(`${item.id} is a ${item.kind}, not a ${kind}`);
    }
    return item;
  }

  /** Resolve a project by name, path, last path segment, or unique fragment. */
  project(ref?: string): Spool {
    if (!ref || ref === '.') return this.home;
    const key = ref.replace(/\/+$/, '').toLowerCase();
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
    const tests: ((s: Spool) => boolean)[] = [
      (s) => s.name.toLowerCase() === key,
      (s) => path.basename(s.root).toLowerCase() === key,
      (s) => norm(path.basename(s.root)) === norm(key) || norm(s.config.name ?? '') === norm(key),
      (s) => norm(s.name).includes(norm(key)),
    ];
    for (const test of tests) {
      const matches = this.spools.filter(test);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new SpoolError(`"${ref}" matches several projects: ${matches.map((m) => m.name).join(', ')}`);
      }
    }
    throw new SpoolError(`no project "${ref}"`, `Projects here: ${this.spools.map((s) => s.name).join(', ')}`);
  }

  private newId(kind: Kind): string {
    for (let length = 4; ; length++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        let id = `${KINDS[kind].prefix}-`;
        for (let i = 0; i < length; i++) id += ALPHABET[randomInt(ALPHABET.length)];
        if (!this.byId.has(id)) return id;
      }
    }
  }

  create(spool: Spool, kind: Kind, fields: Partial<Item> & { title: string }): Item {
    const now = timestamp(this.now());
    const item: Item = {
      id: this.newId(kind),
      kind,
      status: KINDS[kind].initial,
      created: now,
      updated: now,
      needs: [],
      from: [],
      options: [],
      steps: [],
      commits: [],
      reverted: [],
      tags: [],
      skills: [],
      body: '',
      extra: [],
      ...fields,
      spool,
    };
    this.items.push(item);
    this.byId.set(item.id, item);
    this.save(item);
    return item;
  }

  /** Write queue data that the manager's run recorder does not own. */
  writeQueue(spool: Spool, target: string, text: string | null, writer = this.writer): void {
    writeQueue(spool.dir, target, text, writer, this.now());
  }

  save(item: Item, writer = this.writer): void {
    const now = this.now();
    item.updated = timestamp(now);
    const file = this.file(item);
    const text = serialize(item);
    this.recorder?.keep(item, file);
    const entry = writeQueue(item.spool.dir, item.id, text, writer, now);
    if (entry) this.recorder?.wrote(item, file, text);
  }
}
