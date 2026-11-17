/**
 * Watching: tell an agent the moment the human has given it something to do.
 *
 * `spool watch` stays up and prints one line whenever something the loop
 * should act on changes: a thread that can now be built (moved to build on the
 * page, or freed by an answer), words, a picture or a file the human added to a thread, a question
 * an agent has just put to the human, or a note nobody has filed. It prints
 * nothing else, so every line is worth waking for.
 *
 * It is what makes the loop reactive. A harness that can listen to a command's
 * output (Claude Code's Monitor) runs this and is woken by each line, so the
 * human presses play on the page and the build starts, with no timer and
 * nobody typing. It reads the same files every other command reads; there is
 * no daemon behind it and nothing to keep in step.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Bare, Result } from './commands.ts';
import { type Item, SpoolError, isSettled, oneLine, splitBody } from './model.ts';
import { dependents, ready, tasks } from './schedule.ts';
import type { Ctx } from './context.ts';
import { Workspace } from './store.ts';
import { takeOverOf, tidyDue, tidyLine } from './takeover.ts';
import { picturesOf } from './pictures.ts';
import { signer } from './agent.ts';

/** Names a watch is signed with that are no agent's own. */
const NOT_WATCHERS = new Set(['agent', 'human', '']);

interface Seen {
  /** Threads that could be claimed right now. */
  ready: Map<string, string>;
  /** For each open thread, the notes of the human's that are on it. */
  said: Map<string, Set<string>>;
  /** For each open thread, the pictures and files the human added to it, each with the line that tells of it. */
  added?: Map<string, Map<string, string>>;
  /** Notes nobody has filed. */
  inbox: Set<string>;
  /** Questions waiting on the human, each with the line that tells of it. */
  asks: Map<string, string>;
  /** Projects whose backlog the chat takes over, by name. */
  takeOver?: Set<string>;
  /** Projects where, taking over, a tidy of the backlog is due, by name. */
  tidy?: Set<string>;
}

/**
 * The file a watch leaves for as long as it is up, named with its pid: the folders of the projects
 * it is watching. The page reads these to say whether a chat is listening for work.
 */
const beatFile = (pid: number): string => path.join(os.tmpdir(), `spool-watch-${pid}.json`);

const real = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * The agents whose `spool watch` on this machine is up and watching the project in this folder, by
 * the name each signed with (`spool watch --as Codex`); an empty name for a watch nobody signed.
 */
export function watchers(root: string): string[] {
  return watcherList(root).map((w) => w.agent);
}

/** Each watch that is up for the project: the agent it signed as, the model it said, and when it started. */
export function watcherList(root: string): { agent: string; model: string; since: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return [];
  }
  const wanted = real(root);
  const out: { agent: string; model: string; since: string }[] = [];
  for (const name of names) {
    const found = /^spool-watch-(\d+)\.json$/.exec(name);
    if (!found) continue;
    const file = path.join(os.tmpdir(), name);
    try {
      process.kill(Number(found[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
        // Its watch was ended outright and could not tidy up.
        fs.rmSync(file, { force: true });
        continue;
      }
    }
    try {
      // A list of folders, from before a watch said who it is; or the folders and the agent.
      const kept: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const beat = Array.isArray(kept) ? { roots: kept } : (kept as { roots?: unknown; agent?: unknown; model?: unknown; since?: unknown });
      const text = (v: unknown): string => (typeof v === 'string' ? v : '');
      if (Array.isArray(beat.roots) && beat.roots.includes(wanted)) {
        const b = beat as { agent?: unknown; model?: unknown; since?: unknown };
        out.push({ agent: text(b.agent), model: text(b.model), since: text(b.since) });
      }
    } catch {
      // Half-written, or gone this instant.
    }
  }
  return out;
}

/** Whether a `spool watch` on this machine is up and watching the project in this folder. */
export function watched(root: string): boolean {
  return watchers(root).length > 0;
}

/**
 * The line for a question an agent asked: its id, the thread it holds up, the question and its options,
 * so a chat that builds can put it to the human without looking anything up.
 */
function asked(ws: Workspace, d: Item): string {
  const thread = dependents(ws, d).find((t) => !isSettled(t));
  const options = d.options.map((o, i) => `${i + 1}) ${oneLine(o, 80)}${d.recommend === i + 1 ? ' (recommended)' : ''}`);
  return [`ask: ${d.id}`, thread ? `for ${thread.id} ${oneLine(thread.title, 90)} —` : '', `"${oneLine(d.title, 140)}"`, options.join('  ')]
    .filter(Boolean)
    .join(' ');
}

function look(
  ctx: Ctx,
  project?: string,
): { seen: Seen; roots: string[]; text: (note: string) => string; title: (id: string) => string } {
  const ws = Workspace.open(ctx.cwd, ctx.now);
  try {
    const open = tasks(ws, project).filter((t) => t.status !== 'done' && t.status !== 'dropped');
    const notes = new Map(ws.items.filter((i) => i.kind === 'note').map((n) => [n.id, oneLine(splitBody(n.body).main, 140)]));
    const titles = new Map(ws.items.map((i) => [i.id, oneLine(i.title, 90)]));
    const spool = project ? ws.project(project) : undefined;
    const questions = ws.items
      .filter((i) => i.kind === 'decision' && i.status === 'open' && (!spool || i.spool === spool))
      .sort((a, b) => a.created.localeCompare(b.created));
    return {
      seen: {
        ready: new Map(ready(ws, project).map((t) => [t.id, oneLine(t.title, 90)])),
        said: new Map(open.map((t) => [t.id, new Set(t.from.filter((id) => notes.has(id)))])),
        added: new Map(open.map((t) => [t.id, addedBy(t)])),
        inbox: new Set(ws.items.filter((i) => i.kind === 'note' && i.status === 'new').map((n) => n.id)),
        asks: new Map(questions.map((d) => [d.id, asked(ws, d)])),
        takeOver: new Set((spool ? [spool] : ws.spools).filter((s) => takeOverOf(ctx, s.root)).map((s) => s.name)),
        tidy: new Set((spool ? [spool] : ws.spools).filter((s) => tidyDue(ctx, ws, s).due).map((s) => s.name)),
      },
      roots: (project ? [ws.project(project)] : ws.spools).map((s) => real(s.root)),
      text: (note) => notes.get(note) ?? '',
      title: (id) => titles.get(id) ?? '',
    };
  } finally {
    ws.close();
  }
}

/**
 * What the human added to a thread from the page or the command line, by name, each as the reply it
 * is: with its path, so the chat that builds opens it. An agent's own, and a before or an after, are not news.
 */
function addedBy(t: Item): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of picturesOf(t)) {
    if (k.by !== 'human' || k.as) continue;
    const what = k.kind === 'picture' ? 'a picture' : 'a file';
    out.set(k.name, `${what}: ${k.path}${k.caption ? ` "${oneLine(k.caption, 140)}"` : ''}`);
  }
  return out;
}

/** What changed between two looks, as the lines to print. Only gains are news: the loop needs no telling that work went away. Unfiled notes are not here: `watch` holds them back a moment. */
export function changes(before: Seen, after: Seen, text: (note: string) => string, title: (id: string) => string): string[] {
  const out: string[] = [];
  for (const [id, name] of after.ready) if (!before.ready.has(id)) out.push(`build: ${id} ${name}`);
  for (const [id, notes] of after.said) {
    const had = before.said.get(id);
    // A thread that is new arrives with its first words; those are the thread, not a reply on it.
    if (!had) continue;
    for (const note of notes) if (!had.has(note)) out.push(`reply: ${id} ${title(id)} — "${text(note)}"`);
  }
  for (const [id, added] of after.added ?? []) {
    const had = before.added?.get(id);
    if (!had) continue;
    for (const [name, line] of added) if (!had.has(name)) out.push(`reply: ${id} ${title(id)} — added ${line}`);
  }
  // A question is news once, as it is asked. One answered or dropped goes without a word.
  for (const [id, line] of after.asks) if (!before.asks.has(id)) out.push(line);
  // Switched on, taking over is news: the chat may fill an empty Build from the backlog now.
  for (const name of after.takeOver ?? []) if (!before.takeOver?.has(name)) out.push(`takeover: ${name} — they switched taking over the backlog on: Build empty? spool build --takeover`);
  // Taking over, a tidy of the backlog has come due: the chat runs the pass itself. Once, as it comes due.
  for (const name of after.tidy ?? []) if (!before.tidy?.has(name)) out.push(tidyLine(name));
  return out;
}

/** `spool watch`: print each change as it happens, until stopped. */
export function watch({ ctx, opts, actor }: Bare): Result {
  const every = opts.interval === undefined ? 1000 : Number(opts.interval);
  if (!Number.isInteger(every) || every < 20) throw new SpoolError('--interval is in milliseconds, 20 or more');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool; after this the watch only reports.
  const first = look(ctx, project);
  let before = first.seen;
  // Say it is up, for as long as it is: the page shows whether anyone is listening.
  const beat = beatFile(process.pid);
  try {
    // Who is watching, by the agent part of its name: the page shows which agents are here.
    const agent = NOT_WATCHERS.has(actor.trim().toLowerCase()) ? '' : signer(actor).agent;
    const model = agent ? (signer(actor).model ?? '') : '';
    fs.writeFileSync(beat, JSON.stringify({ roots: first.roots, agent, model, since: new Date().toISOString() }));
    const leave = (): void => fs.rmSync(beat, { force: true });
    process.once('exit', leave);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        leave();
        // Then end as it would have with nobody listening for the signal.
        process.kill(process.pid, signal);
      });
    }
  } catch {
    // Nowhere to say so. It watches all the same.
  }
  // A note is often filed a moment after it is captured (the page's + Add does both), so one still unfiled
  // after this long is reported, and one filed sooner never is. Three looks, which is three seconds by default.
  const hold = every * 3;
  const waiting = new Map<string, number>();
  const told = new Set(before.inbox);
  setInterval(() => {
    try {
      const now = look(ctx, project);
      for (const line of changes(before, now.seen, now.text, now.title)) ctx.out(line);
      for (const note of waiting.keys()) if (!now.seen.inbox.has(note)) waiting.delete(note);
      for (const note of now.seen.inbox) {
        if (told.has(note)) continue;
        const since = waiting.get(note) ?? Date.now();
        waiting.set(note, since);
        if (Date.now() - since >= hold) {
          told.add(note);
          waiting.delete(note);
          ctx.out(`unfiled: ${note} "${now.text(note)}"`);
        }
      }
      before = now.seen;
    } catch (error) {
      // A file half-written by another command reads as an error for an instant. Say so only if it is a real one.
      if (!(error instanceof SpoolError)) ctx.out(`error: ${String(error)}`);
    }
  }, every);
  return { text: '' };
}
