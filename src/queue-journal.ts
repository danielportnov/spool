/**
 * The project's queue history. Its entries are independent of any manager run.
 * One receipt is staged under the project lock before the queue file is changed,
 * then renamed into place. If a process stops between those renames, the file's
 * hash tells the next writer whether to keep the pending receipt.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SpoolError, deserialize, timestamp, type Spool } from './model.ts';

export interface QueueWriter {
  actor: string;
  command: string;
}

export interface QueueEntry extends QueueWriter {
  id: string;
  at: string;
  target: string;
  before: string | null;
  after: string | null;
  hash: string | null;
  undoOf?: string;
  beforeMode?: number;
}

const ITEM = '[ntdsr]-[a-z0-9]+';
export const QUEUE_ITEM = new RegExp(`^${ITEM}$`);
const TARGET = new RegExp(`^(?:${ITEM}|report-t-[a-z0-9]+|config|policy|goals)$`);
const ENTRY = new RegExp(`^j-((?:${ITEM}|report-t-[a-z0-9]+|config|policy|goals))-[0-9a-f]{32}$`);
const HISTORY = 'history';
const PENDING = '.pending.json';

// Only fields managed by project commands can appear in history. In particular, local user
// settings and unrecognized fields in a project's config never become part of a receipt.
const CONFIG_KEYS = ['version', 'name', 'about', 'gate', 'disabled'] as const;

function hash(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
}

function queueFile(dir: string, target: string): string {
  if (!TARGET.test(target)) throw new SpoolError(`unknown queue target "${target}"`);
  if (QUEUE_ITEM.test(target)) return path.join(dir, 'items', `${target}.md`);
  if (target.startsWith('report-')) return path.join(dir, 'reports', `${target.slice(7)}.md`);
  return path.join(dir, target === 'config' ? 'config.json' : `${target}.md`);
}

function plainDirectory(dir: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new SpoolError(`expected a directory at ${dir}`);
  return !!stat;
}

/** Read only ordinary files, without following symlinks. Missing is distinct from unreadable. */
function read(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new SpoolError(`expected a regular file at ${file}`);
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new SpoolError(`expected a file at ${file}`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function queueText(dir: string, target: string): string | null {
  const file = queueFile(dir, target);
  return plainDirectory(dir) && plainDirectory(path.dirname(file)) ? read(file) : null;
}

function atomicWrite(file: string, text: string, mode?: number): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function config(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpoolError('the project config must hold a JSON object');
  return value as Record<string, unknown>;
}

/** Copy only supported project values, including only the fields of the switch that Spool defines. */
function projectConfig(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  const { version, name, about, gate, disabled } = config(text);
  const off = disabled as { since?: unknown; block?: unknown } | undefined;
  return {
    ...(typeof version === 'number' ? { version } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof about === 'string' ? { about } : {}),
    ...(gate === 'locked' || typeof gate === 'boolean' ? { gate } : {}),
    ...(off && typeof off === 'object' ? {
      disabled: {
        ...(typeof off.since === 'string' ? { since: off.since } : {}),
        ...(Array.isArray(off.block) ? { block: off.block.filter((name) => name === 'AGENTS.md' || name === 'CLAUDE.md') } : {}),
      },
    } : {}),
  };
}

function configChanges(before: string | null, after: string | null): Pick<QueueEntry, 'before' | 'after'> {
  const old = projectConfig(before);
  const next = projectConfig(after);
  const keys = CONFIG_KEYS.filter((key) => JSON.stringify(old?.[key]) !== JSON.stringify(next?.[key]));
  const changed = (values: Record<string, unknown> | null): string | null =>
    values === null ? null : `${JSON.stringify(Object.fromEntries(keys.map((key) => [key, values[key]])), null, 2)}\n`;
  return { before: changed(old), after: changed(next) };
}

function parseEntry(file: string): QueueEntry | undefined {
  const text = read(file);
  if (text === null) return undefined;
  try {
    const entry = JSON.parse(text) as QueueEntry;
    if (
      typeof entry.id === 'string' && typeof entry.target === 'string' && ENTRY.exec(entry.id)?.[1] === entry.target &&
      typeof entry.at === 'string' &&
      typeof entry.actor === 'string' && typeof entry.command === 'string' &&
      (entry.before === null || typeof entry.before === 'string') &&
      (entry.after === null || typeof entry.after === 'string') &&
      (entry.hash === null || (typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash))) &&
      (entry.beforeMode === undefined || (Number.isInteger(entry.beforeMode) && entry.beforeMode >= 0 && entry.beforeMode <= 0o777))
    ) return entry;
  } catch {
    // An unreadable entry cannot be used to write back into the queue.
  }
  return undefined;
}

function entryFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function recover(dir: string, history: string): void {
  const pending = path.join(history, PENDING);
  const entry = parseEntry(pending);
  if (entry && hash(queueText(dir, entry.target)) === entry.hash) fs.renameSync(pending, entryFile(history, entry.id));
  else fs.rmSync(pending, { force: true });
}

/** Write one queue file and its receipt. The caller holds this project's queue lock. */
export function writeQueue(
  dir: string, target: string, after: string | null, writer: QueueWriter, now: Date, undoOf?: QueueEntry,
): QueueEntry | undefined {
  const file = queueFile(dir, target);
  const before = queueText(dir, target);
  if (undoOf && hash(before) !== undoOf.hash) throw changedAfter(undoOf);
  if (before === after) return undefined;

  const history = path.join(dir, HISTORY);
  if (!plainDirectory(history)) fs.mkdirSync(history, { mode: 0o700 });
  // Shared queues can be tracked by Git. Receipts have older text and are local even there.
  const ignore = path.join(history, '.gitignore');
  if (!fs.existsSync(ignore)) atomicWrite(ignore, '*\n');
  recover(dir, history);
  const mode = before === null ? undefined : (fs.statSync(file).mode & 0o777);
  const entry: QueueEntry = {
    id: `j-${target}-${randomUUID().replaceAll('-', '')}`,
    at: timestamp(now),
    ...writer,
    target,
    ...(target === 'config' ? configChanges(before, after) : { before, after }),
    hash: hash(after),
    ...(undoOf ? { undoOf: undoOf.id } : {}),
    ...(mode === undefined ? {} : { beforeMode: mode }),
  };
  const pending = path.join(history, PENDING);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(pending, JSON.stringify(entry), 0o600);
  try {
    if (undoOf && hash(queueText(dir, target)) !== undoOf.hash) throw changedAfter(undoOf);
    if (after === null) fs.unlinkSync(file);
    else atomicWrite(file, after, mode ?? undoOf?.beforeMode);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
  fs.renameSync(pending, entryFile(history, entry.id));
  return entry;
}

/** Receipts in this project, newest first. Only the requested files' snapshots are read. */
export function queueHistory(spool: Spool, targets: string[]): QueueEntry[] {
  const history = path.join(spool.dir, HISTORY);
  if (!(plainDirectory(spool.dir) && plainDirectory(history))) return [];
  const pending = parseEntry(path.join(history, PENDING));
  const entries: { entry: QueueEntry; order: bigint }[] = [];
  for (const name of fs.readdirSync(history)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const target = ENTRY.exec(id)?.[1];
    if (!target || !targets.includes(target)) continue;
    const file = entryFile(history, id);
    const entry = parseEntry(file);
    if (entry?.id === id) entries.push({ entry, order: fs.statSync(file, { bigint: true }).mtimeNs });
  }
  if (pending && targets.includes(pending.target) && !entries.some(({ entry }) => entry.id === pending.id) &&
    hash(queueText(spool.dir, pending.target)) === pending.hash) {
    entries.push({ entry: pending, order: 0n });
  }
  return entries.sort((a, b) => b.entry.at.localeCompare(a.entry.at) || (a.order > b.order ? -1 : a.order < b.order ? 1 : 0))
    .map(({ entry }) => entry);
}

export function queueEntry(spool: Spool, id: string): QueueEntry | undefined {
  const target = ENTRY.exec(id)?.[1];
  if (!target) return undefined;
  const history = path.join(spool.dir, HISTORY);
  if (!(plainDirectory(spool.dir) && plainDirectory(history))) return undefined;
  // Undo holds the lock, so it can settle an interrupted write just as any other writer does.
  recover(spool.dir, history);
  const entry = parseEntry(entryFile(history, id));
  return entry?.id === id ? entry : undefined;
}

/** Whether a receipt has effects in addition to the queue file it wrote. */
export function associatedCommand(spool: Spool, entry: QueueEntry): string | undefined {
  if (entry.target === 'config') {
    if (entry.before === null) return 'The project needs its first config to find the queue.';
    if (entry.command === 'disable') return 'Use spool enable to switch Spool on and restore its block in the project instructions.';
    if (entry.command === 'enable') return 'Use spool disable to switch Spool off and remove its block from the project instructions.';
  }
  if (QUEUE_ITEM.test(entry.target)) {
    const before = entry.before === null ? undefined : deserialize(entry.before, spool);
    const after = entry.after === null ? undefined : deserialize(entry.after, spool);
    if (entry.command === 'drop' && before?.kind === 'skill' && before.path && after?.status === 'dropped') {
      return 'This also removed the skill from disk. Restore the skill with spool skill add.';
    }
    if (before?.kind === 'task' || after?.kind === 'task') {
      const git = (item: typeof before) => [item?.commits ?? [], item?.reverted ?? [], item?.revert];
      if (JSON.stringify(git(before)) !== JSON.stringify(git(after))) {
        return `See spool revert ${entry.target} to take back work with Git commits.`;
      }
      const checkout = (item: typeof before) => [item?.worktree, item?.branch, item?.status === 'active'];
      if (JSON.stringify(checkout(before)) !== JSON.stringify(checkout(after))) {
        return `See spool show ${entry.target} and use the thread's work controls to change its claim or worktree.`;
      }
    }
  }
  return undefined;
}

function changedAfter(entry: QueueEntry): SpoolError {
  const target = entry.target.startsWith('report-') ? entry.target.slice(7) : entry.target;
  return new SpoolError(`${entry.target} changed after ${entry.id}`, `See spool history ${target}`);
}

/** Take back one receipt, with the same exact-file check as run undo. */
export function undoQueue(spool: Spool, entry: QueueEntry, writer: QueueWriter, now: Date): QueueEntry {
  const current = queueText(spool.dir, entry.target);
  if (hash(current) !== entry.hash) throw changedAfter(entry);
  let before = entry.before;
  if (entry.target === 'config' && before !== null && entry.after !== null && current !== null) {
    const was = config(before);
    const after = config(entry.after);
    const live = config(current);
    for (const key of CONFIG_KEYS) {
      if (Object.hasOwn(was, key)) live[key] = was[key];
      else if (Object.hasOwn(after, key)) delete live[key];
    }
    before = `${JSON.stringify(live, null, 2)}\n`;
  }
  if (before !== null && QUEUE_ITEM.test(entry.target) && deserialize(before, spool).id !== entry.target) {
    throw new SpoolError(`the before copy for ${entry.id} does not name ${entry.target}`);
  }
  const undo = writeQueue(spool.dir, entry.target, before, writer, now, entry);
  if (!undo) throw new SpoolError(`${entry.id} has already been undone`);
  return undo;
}
