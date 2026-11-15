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

function look(cwd: string, now: () => Date, project?: string): { seen: Seen; text: (note: string) => string; title: (id: string) => string } {
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
  let before = look(ctx.cwd, ctx.now, project).seen;
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
