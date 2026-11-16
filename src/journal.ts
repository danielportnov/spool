/**
 * A run: a stretch of changes to the queue that can be taken back in one step.
 *
 * An agent that puts a backlog in order makes dozens of small writes: a size here, a drop there,
 * a few new threads. Each is easy to undo, and nobody would undo sixty by hand. So they are made
 * under a run. `SPOOL_RUN=<thread id>` in the environment names the thread the run belongs to,
 * and from then on every item a command writes is recorded under `.spool/runs/<id>/`:
 *
 *   before/<item>.md       the item's file as it was before the run first touched it
 *   before/<item>.absent   or a marker that there was none: the run made it
 *   journal.jsonl          a line for every write: when, which item, what changed, by which
 *                          command, and a hash of the file as it was left
 *
 * `spool revert <id>` then puts each item back from its copy and removes the ones the run made.
 * An item that is no longer as the run left it (the hash says so) was changed by someone since:
 * it is named and left as it is. Git cannot do this, since in most projects `.spool/` is not in
 * git. Code is never touched: a thread built since has commits of its own, and its own undo.
 *
 * The run's own thread is not recorded. It is the record.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { endLeaveOf } from './leave.ts';
import { type Item, type Kind, SpoolError, addLog, deserialize, isClosed, splitBody, timestamp } from './model.ts';
import { type Paint, itemJson, itemLine } from './render.ts';
import type { Recorder, Workspace } from './store.ts';
import { runDir } from './stream.ts';

export const JOURNAL = 'journal.jsonl';

/** One write, as the journal keeps it. */
export interface Entry {
  at: string;
  item: string;
  kind: Kind;
  title: string;
  change: 'created' | 'changed';
  /** The fields this write changed, as they were. A field that was not set is null. */
  was: Record<string, unknown>;
  /** The same fields as they are now; `body: true` where the text above the log was rewritten. */
  now: Record<string, unknown>;
  /** What the write added to the item's log: the reason, where the command was given one. */
  said: string[];
  /** The command that made it. */
  command?: string;
  /** sha256 of the item's file as this write left it: how an undo knows nobody has changed it since. */
  hash: string;
  /** The item's project, as a path from the run's own, where it is another. */
  project?: string;
}

/** The line an undo leaves, so a run is not undone twice and nothing more is done under it. */
interface Undone {
  at: string;
  undone: true;
  why?: string;
}

/** The fields a report tells apart. The body is only told as changed or not: it is long. */
const FIELDS = [
  'title', 'status', 'priority', 'size', 'type', 'sprint', 'hold', 'archived', 'suggested', 'place',
  'needs', 'from', 'tags', 'version', 'model', 'effort', 'by', 'choice', 'summary', 'reviewed',
] as const;

function dirOf(run: Item): string {
  return path.join(run.spool.dir, 'runs', run.id);
}

function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function read(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Whether a thread has a journal: it is a run's thread, and undoing it puts the queue back. */
export function journaled(task: Item): boolean {
  return fs.existsSync(path.join(dirOf(task), JOURNAL));
}

/** A run's journal, oldest first, and whether the run was undone. Lines that cannot be read are skipped. */
export function readJournal(run: Item): { entries: Entry[]; undone?: Undone } {
  const text = read(path.join(dirOf(run), JOURNAL))?.toString('utf8') ?? '';
  const entries: Entry[] = [];
  let undone: Undone | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<Entry & Undone>;
      if (parsed.undone) undone = parsed as Undone;
      else if (typeof parsed.item === 'string' && typeof parsed.hash === 'string') {
        entries.push({ ...(parsed as Entry), was: parsed.was ?? {}, now: parsed.now ?? {}, said: parsed.said ?? [] });
      }
    } catch {
      // A line cut short by a crash: the writes around it still stand.
    }
  }
  return { entries, undone };
}

function plain(value: unknown): unknown {
  return value === undefined || value === '' || (Array.isArray(value) && !value.length) ? null : value;
}

/** What a write changed, field by field. A new item has no "was". */
function diff(before: Item | null, after: Item): Pick<Entry, 'was' | 'now'> {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const key of FIELDS) {
    const old = before ? plain(before[key]) : null;
    const next = plain(after[key]);
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    if (before) was[key] = old;
    now[key] = next;
  }
  if (before && splitBody(before.body).main !== splitBody(after.body).main) now.body = true;
  return { was, now };
}

/** The lines a write added to the log, without their stamp and signature. */
function added(before: Item | null, after: Item): string[] {
  const old = before ? splitBody(before.body).log.length : 0;
  return splitBody(after.body)
    .log.slice(old)
    .map((line) => /^- \S+ \S+ [^:]+: (.*)$/.exec(line)?.[1] ?? line.replace(/^- /, ''));
}

class Journal implements Recorder {
  private readonly ws: Workspace;
  private readonly run: Item;
  private readonly command: string;
  /** The file about to be overwritten, between `keep` and `wrote`. */
  private prev: Buffer | null = null;

  constructor(ws: Workspace, run: Item, command: string) {
    this.ws = ws;
    this.run = run;
    this.command = command;
  }

  keep(item: Item, file: string): void {
    if (item.id === this.run.id) return;
    this.prev = read(file);
    const before = path.join(runDir(this.run.spool.dir, this.run.id), 'before');
    const copy = path.join(before, `${item.id}.md`);
    const none = path.join(before, `${item.id}.absent`);
    // Only the first time: what an undo puts back is the item as it was before the run, not between two of its writes.
    if (fs.existsSync(copy) || fs.existsSync(none)) return;
    fs.mkdirSync(before, { recursive: true });
    if (this.prev) fs.writeFileSync(copy, this.prev);
    else fs.writeFileSync(none, '');
  }

  wrote(item: Item, _file: string, text: string): void {
    if (item.id === this.run.id) return;
    let before: Item | null = null;
    try {
      before = this.prev ? deserialize(this.prev.toString('utf8'), item.spool) : null;
    } catch {
      // What was there could not be read as an item. Its copy is kept all the same.
    }
    const project = path.relative(this.run.spool.root, item.spool.root).split(path.sep).join('/');
    const entry: Entry = {
      at: item.updated,
      item: item.id,
      kind: item.kind,
      title: item.title,
      change: this.prev ? 'changed' : 'created',
      ...diff(before, item),
      said: added(before, item),
      command: this.command,
      hash: sha(text),
      ...(project ? { project } : {}),
    };
    this.prev = null;
    fs.appendFileSync(path.join(runDir(this.run.spool.dir, this.run.id), JOURNAL), `${JSON.stringify(entry)}\n`);
    // A run that is still writing has not gone quiet: its thread's claim is kept fresh, a minute at a time.
    if (this.run.status === 'active' && Date.parse(item.updated) - Date.parse(this.run.updated) >= 60_000) this.ws.save(this.run);
  }
}

/** Open a run's journal with nothing in it, so the thread is a run's from the start, whatever it goes on to write. */
export function startJournal(run: Item): void {
  const file = path.join(runDir(run.spool.dir, run.id), JOURNAL);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
}

/**
 * Put a command under the run its environment names, if it names one: every item it writes is
 * then kept and journaled. A run that is over takes no more writes, and says so, since an agent
 * that believes its changes are on record must not find out later that they were not.
 */
export function record(ws: Workspace, env: Record<string, string | undefined>, command: string): void {
  const id = env.SPOOL_RUN?.trim();
  // `spool manage` opens and closes runs itself, and is never made under one.
  if (!id || command === 'manage') return;
  const run = /^t-[a-z0-9]+$/.test(id) ? ws.find(id) : undefined;
  if (!run || run.kind !== 'task') {
    throw new SpoolError(`SPOOL_RUN names "${id}", which is not a thread here`, 'Unset it, or set it to the id of the thread this run belongs to');
  }
  const over = readJournal(run).undone ? 'was undone' : isClosed(run) ? `is ${run.status}` : '';
  if (over) {
    // Undoing is the one thing still done once a run is over, often from the very shell it ran in.
    if (command === 'revert') return;
    throw new SpoolError(`the run ${run.id} ${over}, so nothing more is done under it`, 'Unset SPOOL_RUN. For another run: spool manage --start');
  }
  ws.recorder = new Journal(ws, run, command);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whether a write moved a thread to build: from proposed, or by the commands that do. */
function movedToBuild(entry: Entry): boolean {
  return (entry.was.status === 'proposed' && entry.now.status === 'open') || entry.command === 'build' || entry.command === 'play';
}

export interface RunUndo {
  lines: string[];
  data: Record<string, unknown>;
}

/**
 * Undo a run: each item it wrote goes back to how it was before the run, and the items it made
 * are removed. An item changed since the run last wrote it is named and left as it is. The run's
 * thread is dropped: there is nothing of it to build again.
 */
export function undoRun(ws: Workspace, run: Item, actor: string, why: string, p: Paint): RunUndo {
  const { entries, undone } = readJournal(run);
  if (undone) throw new SpoolError(`${run.id} was undone already`, `What it had changed went back on ${undone.at.slice(0, 10)}`);
  const dir = dirOf(run);
  const writes = new Map<string, Entry[]>();
  for (const entry of entries) writes.set(entry.item, [...(writes.get(entry.item) ?? []), entry]);

  const restored: string[] = [];
  const removed: string[] = [];
  const left: { id: string; title: string; why: string }[] = [];
  const built: Item[] = [];
  for (const [id, mine] of writes) {
    const last = mine.at(-1)!;
    const leave = (reason: string) => left.push({ id, title: last.title, why: reason });
    // The journal is a file anyone can edit: only an item's own file, in a project of this workspace, is ever written.
    const root = path.resolve(run.spool.root, last.project ?? '');
    const spool = ws.spools.find((s) => s.root === root);
    if (!spool || !/^[a-z]-[a-z0-9]+$/.test(id)) {
      leave('its project is not in this workspace');
      continue;
    }
    const file = path.join(spool.dir, 'items', `${id}.md`);
    const copy = read(path.join(dir, 'before', `${id}.md`));
    if (!copy && !fs.existsSync(path.join(dir, 'before', `${id}.absent`))) {
      leave('the copy of how it was is gone');
      continue;
    }
    const now = read(file);
    if (!now) {
      // Made by the run and gone already is where the undo was taking it.
      if (copy) leave('deleted since');
      else removed.push(id);
      continue;
    }
    if (sha(now) !== last.hash) {
      const item = ws.find(id);
      // Built since the run moved it to build: its commits are its own, and so is its undo.
      if (item?.kind === 'task' && ['active', 'done'].includes(item.status) && mine.some(movedToBuild)) built.push(item);
      else leave('changed since');
      continue;
    }
    if (copy) {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, copy);
      fs.renameSync(temp, file);
      restored.push(id);
    } else {
      fs.rmSync(file, { force: true });
      removed.push(id);
    }
  }

  const kept = left.length + built.length;
  const outcome =
    [
      restored.length ? `${plural(restored.length, 'item')} put back as ${restored.length === 1 ? 'it was' : 'they were'}` : '',
      removed.length ? `${plural(removed.length, 'item')} it had made removed` : '',
      kept ? `${kept} left as ${kept === 1 ? 'it is' : 'they are'}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'it had changed nothing';
  const undo: Undone = { at: timestamp(ws.now()), undone: true, ...(why ? { why } : {}) };
  fs.appendFileSync(path.join(runDir(run.spool.dir, run.id), JOURNAL), `${JSON.stringify(undo)}\n`);
  run.status = 'dropped';
  run.by = undefined;
  run.place = undefined;
  addLog(run, actor, `undone: ${outcome}${why ? `. Why: ${why}` : ''}`, ws.now());
  ws.save(run);

  // The leave it ran under ends with it: what the run was let do is no longer wanted.
  const leave = endLeaveOf(ws, run);
  const lines = [`${p.bold(run.id)} undone: ${outcome}. No code was touched.`];
  if (leave) lines.push(`The leave it ran under is ended: "${leave.words}"`);
  if (left.length) {
    lines.push('Left as they are:');
    for (const l of left) {
      const item = ws.find(l.id);
      lines.push(`  ${item ? itemLine(ws, item, p) : `${p.bold(l.id)}  ${l.title}`}${p.dim(`  · ${l.why}`)}`);
    }
  }
  if (built.length) {
    lines.push('Built since the run moved them to build. Their commits are their own, and so is their undo:');
    for (const t of built) lines.push(`  ${itemLine(ws, t, p)}`, p.dim(`      ${undoOf(t)}`));
  }
  // A skill's folder is outside the queue. Its record is put back; what the run wrote or deleted on disk is not, and is said.
  const skills = [...writes].filter(([, mine]) => mine.some((e) => e.kind === 'skill' && (e.change === 'created' || e.now.status === 'dropped'))).map(([id]) => id);
  if (skills.length) {
    lines.push(`Not undone: the files of ${plural(skills.length, 'skill')} (${skills.join(', ')}). A skill's folder is outside the queue, so what the run wrote or deleted there is as the run left it.`);
  }
  return {
    lines,
    data: { run: itemJson(ws, run), restored, removed, left, built: built.map((t) => ({ id: t.id, undo: undoOf(t) })), skills, leaveEnded: leave?.words ?? null },
  };
}

/** The command that takes back one thread built under a run. */
function undoOf(task: Item): string {
  return task.status === 'done' ? `spool revert ${task.id}` : `spool propose --undo ${task.id}`;
}
