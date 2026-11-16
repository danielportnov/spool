/**
 * Watching: tell an agent the moment the human has given it something to do.
 *
 * `spool watch` stays up and prints one line whenever something the loop
 * should act on changes: a thread that can now be built (moved to build on the
 * page, or freed by an answer), words the human added to a thread, or a note
 * nobody has filed. It prints nothing else, so every line is worth waking for.
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
import { SpoolError, oneLine, splitBody } from './model.ts';
import { ready, tasks } from './schedule.ts';
import { Workspace } from './store.ts';

interface Seen {
  /** Threads that could be claimed right now. */
  ready: Map<string, string>;
  /** For each open thread, the notes of the human's that are on it. */
  said: Map<string, Set<string>>;
  /** Notes nobody has filed. */
  inbox: Set<string>;
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

/** Whether a `spool watch` on this machine is up and watching the project in this folder. */
export function watched(root: string): boolean {
  let names: string[] = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return false;
  }
  const wanted = real(root);
  return names.some((name) => {
    const found = /^spool-watch-(\d+)\.json$/.exec(name);
    if (!found) return false;
    const file = path.join(os.tmpdir(), name);
    try {
      process.kill(Number(found[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
        // Its watch was ended outright and could not tidy up.
        fs.rmSync(file, { force: true });
        return false;
      }
    }
    try {
      const roots: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(roots) && roots.includes(wanted);
    } catch {
      return false; // Half-written, or gone this instant.
    }
  });
}

function look(
  cwd: string,
  now: () => Date,
  project?: string,
): { seen: Seen; roots: string[]; text: (note: string) => string; title: (id: string) => string } {
  const ws = Workspace.open(cwd, now);
  try {
    const open = tasks(ws, project).filter((t) => t.status !== 'done' && t.status !== 'dropped');
    const notes = new Map(ws.items.filter((i) => i.kind === 'note').map((n) => [n.id, oneLine(splitBody(n.body).main, 140)]));
    const titles = new Map(ws.items.map((i) => [i.id, oneLine(i.title, 90)]));
    return {
      seen: {
        ready: new Map(ready(ws, project).map((t) => [t.id, oneLine(t.title, 90)])),
        said: new Map(open.map((t) => [t.id, new Set(t.from.filter((id) => notes.has(id)))])),
        inbox: new Set(ws.items.filter((i) => i.kind === 'note' && i.status === 'new').map((n) => n.id)),
      },
      roots: (project ? [ws.project(project)] : ws.spools).map((s) => real(s.root)),
      text: (note) => notes.get(note) ?? '',
      title: (id) => titles.get(id) ?? '',
    };
  } finally {
    ws.close();
  }
}

/** What changed between two looks, as the lines to print. Only gains are news: the loop needs no telling that work went away. */
export function changes(before: Seen, after: Seen, text: (note: string) => string, title: (id: string) => string): string[] {
  const out: string[] = [];
  for (const [id, name] of after.ready) if (!before.ready.has(id)) out.push(`build: ${id} ${name}`);
  for (const [id, notes] of after.said) {
    const had = before.said.get(id);
    // A thread that is new arrives with its first words; those are the thread, not a reply on it.
    if (!had) continue;
    for (const note of notes) if (!had.has(note)) out.push(`reply: ${id} ${title(id)} — "${text(note)}"`);
  }
  for (const note of after.inbox) if (!before.inbox.has(note)) out.push(`unfiled: ${note} "${text(note)}"`);
  return out;
}

/** `spool watch`: print each change as it happens, until stopped. */
export function watch({ ctx, opts }: Bare): Result {
  const every = opts.interval === undefined ? 1000 : Number(opts.interval);
  if (!Number.isInteger(every) || every < 20) throw new SpoolError('--interval is in milliseconds, 20 or more');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool; after this the watch only reports.
  const first = look(ctx.cwd, ctx.now, project);
  let before = first.seen;
  // Say it is up, for as long as it is: the page shows whether anyone is listening.
  const beat = beatFile(process.pid);
  try {
    fs.writeFileSync(beat, JSON.stringify(first.roots));
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
  setInterval(() => {
    try {
      const now = look(ctx.cwd, ctx.now, project);
      for (const line of changes(before, now.seen, now.text, now.title)) ctx.out(line);
      before = now.seen;
    } catch (error) {
      // A file half-written by another command reads as an error for an instant. Say so only if it is a real one.
      if (!(error instanceof SpoolError)) ctx.out(`error: ${String(error)}`);
    }
  }, every);
  return { text: '' };
}
