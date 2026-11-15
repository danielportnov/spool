/**
 * The Spool page: the project's spool as a board in a browser.
 *
 * `spool page` starts a small server on this machine and opens a kanban board
 * of every thread: proposed, build, building, done. It is where the human
 * plans and steers. They drag a thread into build, or press play on it, and
 * that is the only way anything gets built; they add a thread at the foot of a
 * column; they open a card and read its thread: what they asked, what was done
 * and by which agent, and everything that happened in between; they write a
 * note on it and it lands there in their words; they answer a question and
 * work moves again; and they mark finished work complete when they have
 * looked at it.
 * Agents read the same spool and keep working while the page is open.
 *
 * Everything the page does is an ordinary command run in-process, as the
 * human: `build`, `propose`, `capture`, `task`, `file`, `edit`, `answer`, `approve`. So the page can do
 * nothing the command line cannot, and every rule the commands enforce holds
 * here too.
 *
 * The server listens on 127.0.0.1 only. Changing anything needs the token it
 * hands to its own page, and a Host header that names this machine, so another
 * website open in the same browser cannot press play on your behalf.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { run } from './cli.ts';
import type { Bare, Result } from './commands.ts';
import type { Ctx } from './context.ts';
import { type Item, SpoolError, oneLine, reportFile, splitBody } from './model.ts';
import { age, tableRows } from './render.ts';
import { blockers, children, docket, review, taskState, tasks } from './schedule.ts';
import { Workspace } from './store.ts';

type Column = 'proposed' | 'build' | 'building' | 'done';

interface Card {
  id: string;
  /** Its number in the loop's list, so the board and the chat point at the same thread. */
  n: number | null;
  title: string;
  difficulty: string;
  priority: string;
  urgent: boolean;
  type: string;
  /** What the human needs to know about it right now, if anything. */
  note: string;
  suggested: string;
  /** The fields a ticket shows and the human can change. */
  size: string;
  p: number;
  tags: string[];
  version: string;
  column: Column;
  created: string;
  updated: string;
  /** Shipped, and whether the human has marked it complete. */
  done: boolean;
  complete: boolean;
  thread: Thread;
  question: { id: string; title: string; options: string[]; recommend: number | null } | null;
}

/** A card opened up: what was asked, what was done about it and by whom, and where it came from. */
interface Thread {
  /** The human's own words, each as they said it. */
  said: { text: string; note: string; on: string }[];
  spec: string;
  /** Everything that happened to it, oldest first. */
  steps: { at: string; who: string; what: string }[];
  /**
   * The same story told as a conversation, oldest first: what the human said, what an agent
   * answered, and the small events in between.
   */
  feed: Post[];
  /** The report an audit or a plan handed in, in full: the long read belongs on the page. */
  report: string;
  /** Who built it, as they signed themselves. */
  by: string;
  summary: string;
  commits: string[];
  cameFrom: { id: string; title: string }[];
  parts: { id: string; title: string; state: string }[];
  questions: { id: string; title: string; status: string; choice: string }[];
}

interface Post {
  at: string;
  who: string;
  /** said: the human's words · post: an agent's note · shipped: it finished · asked: it needs a call · event: bookkeeping. */
  kind: 'said' | 'post' | 'shipped' | 'asked' | 'event';
  text: string;
}

/** The queue's own log lines: what moved where. Anything else an agent logged is something it had to say. */
const BOOKKEEPING = /^(started|moved to build|moved back to proposed|edited: |put on hold|released from hold|approved|picked up after|handed to |agent |reverted|reopened|dropped|agreed|filed )/;

function feedOf(ws: Workspace, task: Item, said: Thread['said'], steps: Thread['steps']): Post[] {
  const words: Post[] = said.map((s) => ({
    // A note knows when it was said; words with no note behind them were there from the start.
    at: (ws.find(s.note)?.created ?? task.created).slice(0, 16).replace('T', ' ') + 'Z',
    who: 'human',
    kind: 'said',
    text: s.text,
  }));
  const rest: Post[] = steps.map((s) => {
    if (s.what.startsWith('done: ')) return { at: s.at, who: s.who, kind: 'shipped', text: s.what.slice(6) };
    const asked = /^waiting on d-[a-z0-9]+: (.*)$/.exec(s.what);
    if (asked) return { at: s.at, who: s.who, kind: 'asked', text: asked[1]! };
    return { at: s.at, who: s.who, kind: BOOKKEEPING.test(s.what) || s.who === 'human' ? 'event' : 'post', text: s.what };
  });
  // Stable: things said in the same minute keep the order they were written in, words first.
  return [...words, ...rest].map((p, i) => ({ p, i })).sort((a, b) => a.p.at.localeCompare(b.p.at) || a.i - b.i).map((x) => x.p);
}

interface Board {
  project: string;
  version: string;
  gate: boolean;
  /** Every tag and version in use, to offer when the human types one. */
  tags: string[];
  versions: string[];
  /** How many finished threads the human has marked complete, shown or not. */
  history: number;
  columns: Record<Column, Card[]>;
  also: { assumptions: number; skills: number; inbox: number };
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;
/** Finished work is kept for good. The page carries what is still to check, and the most recent of the rest as history. */
const HISTORY_SHOWN = 60;

/** Which column a thread sits in. On hold is the human saying not yet, so it sits with what is not in build. */
function columnOf(state: string): Column | null {
  if (state === 'proposed' || state === 'held') return 'proposed';
  if (state === 'ready' || state === 'stale' || state === 'blocked') return 'build';
  if (state === 'active') return 'building';
  if (state === 'done') return 'done';
  return null;
}

/** A thread's body is the human's words, quoted and signed, around whatever spec was written for it. */
function readBody(main: string): { said: Thread['said']; spec: string } {
  const said: Thread['said'] = [];
  const spec: string[] = [];
  for (const block of main.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (!lines.every((l) => l.startsWith('>'))) {
      spec.push(block);
      continue;
    }
    const words = lines.map((l) => l.replace(/^> ?/, ''));
    const signed = /^— \[\[(n-[a-z0-9]+)\]\], (\d{4}-\d\d-\d\d)$/.exec(words.at(-1) ?? '');
    said.push({ text: (signed ? words.slice(0, -1) : words).join('\n').trim(), note: signed?.[1] ?? '', on: signed?.[2] ?? '' });
  }
  return { said, spec: spec.join('\n\n').trim() };
}

function readReport(task: Item): string {
  try {
    return fs.readFileSync(reportFile(task), 'utf8').trim();
  } catch {
    return '';
  }
}

function threadOf(ws: Workspace, task: Item, main: string, log: string[]): Thread {
  const steps = log.map((line) => {
    const parsed = /^- (\d{4}-\d\d-\d\d \d\d:\d\dZ) (.+?): (.*)$/.exec(line);
    return parsed ? { at: parsed[1]!, who: parsed[2]!, what: parsed[3]! } : { at: '', who: '', what: line.replace(/^- /, '') };
  });
  const from = task.from.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind !== 'note');
  const asked = task.needs.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind === 'decision');
  const read = readBody(main);
  return {
    ...read,
    steps,
    feed: feedOf(ws, task, read.said, steps),
    report: readReport(task),
    by: task.by ?? '',
    summary: task.summary ?? '',
    commits: task.commits.map((c) => c.slice(0, 7)),
    cameFrom: from.map((i) => ({ id: i.id, title: i.title })),
    parts: children(ws, task).map((k) => ({ id: k.id, title: k.title, state: taskState(ws, k) })),
    questions: asked.map((d) => ({ id: d.id, title: d.title, status: d.status, choice: d.choice ?? '' })),
  };
}

function card(ws: Workspace, task: Item, n: number | null, note: string, column: Column): Card {
  const { main, log } = splitBody(task.body);
  const asked = blockers(ws, task).find((b) => b.kind === 'decision' && b.status === 'open');
  return {
    id: task.id,
    n,
    title: task.title,
    difficulty: task.size ? DIFFICULTY[task.size] : '',
    priority: URGENCY[task.priority ?? 2] ?? 'Normal',
    urgent: (task.priority ?? 2) <= 1,
    type: task.type ?? 'change',
    note,
    suggested: task.suggested ?? '',
    size: task.size ?? '',
    p: task.priority ?? 2,
    tags: task.tags,
    version: task.version ?? '',
    column,
    created: task.created,
    updated: task.updated,
    done: task.status === 'done',
    complete: task.status === 'done' && !!task.reviewed,
    thread: threadOf(ws, task, main, log),
    question: asked ? { id: asked.id, title: asked.title, options: asked.options, recommend: asked.recommend ?? null } : null,
  };
}

/** The project's own version, where it keeps one in a place Spool knows; otherwise none is shown. */
function projectVersion(root: string): string {
  try {
    const found = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    if (typeof found === 'string') return found;
  } catch {
    // No package.json, or not one with a version: try the plain file.
  }
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim().split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * What a card says under its title. The column already says proposed, and a
 * question is shown with its buttons, so neither is repeated; what is left is
 * the reason an agent suggested it, or what it is waiting on.
 */
function cardNote(row: { item: Item; mark: string; note: string }): string {
  if (row.item.suggested) return `Why: ${row.item.suggested}`;
  if (row.mark === '🟠' || (row.mark === '🔴' && row.note.startsWith('Needs you: ') && !row.note.includes('go-ahead'))) return '';
  return `${row.mark} ${row.note}`.replace(/\*\*/g, '').trim();
}

/** The whole board for one project, read fresh from disk. */
export function board(ws: Workspace, project?: string): Board {
  const spool = project ? ws.project(project) : ws.home;
  const d = docket(ws, spool);
  const columns: Record<Column, Card[]> = { proposed: [], build: [], building: [], done: [] };
  // The open threads, in the order and with the numbers the loop's list gives them.
  for (const row of tableRows(ws, d)) {
    const column = columnOf(taskState(ws, row.item));
    if (column) columns[column].push(card(ws, row.item, row.n, cardNote(row), column));
  }
  const done = tasks(ws, spool)
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  // What the human has not looked at yet comes first, all of it; what they marked complete is history.
  const shown = [...done.filter((t) => !t.reviewed), ...done.filter((t) => t.reviewed).slice(0, HISTORY_SHOWN)];
  for (const t of shown) {
    columns.done.push(card(ws, t, null, `${age(t.updated, ws.now())} ago${t.summary ? ` · ${oneLine(t.summary, 160)}` : ''}`, 'done'));
  }
  const queue = review(ws, spool);
  const all = tasks(ws, spool);
  return {
    project: spool.name,
    version: projectVersion(spool.root),
    gate: !!spool.config.gate,
    tags: [...new Set(all.flatMap((t) => t.tags))].sort(),
    versions: [...new Set(all.map((t) => t.version ?? '').filter(Boolean))].sort().reverse(),
    history: done.filter((t) => t.reviewed).length,
    columns,
    also: { assumptions: queue.assumptions.length, skills: queue.skills.length, inbox: queue.inbox.length },
  };
}

// ------------------------------------------------------------------ the server

interface Started {
  url: string;
  server: http.Server;
}

/** Run one command as the human, in-process, and say whether it worked. */
function act(ctx: Ctx, argv: string[]): { ok: boolean; text: string; data: unknown } {
  const out: string[] = [];
  const err: string[] = [];
  // --json goes first: after a `--`, everything is the human's words.
  const code = run(['--json', ...argv], {
    ...ctx,
    env: { ...ctx.env, SPOOL_ACTOR: 'human' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: () => '',
    lines: () => {},
    color: false,
    inherit: false,
  });
  let data: unknown = null;
  try {
    data = JSON.parse(out.join('\n'));
  } catch {
    // Not every failure is JSON; the text below carries it.
  }
  const failed = (data as { error?: string } | null)?.error;
  return { ok: code === 0, text: failed ?? err.join('\n') ?? '', data };
}

type Body = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** What the page can do. Each is the command a person would have typed. */
function change(ctx: Ctx, action: string, body: Body, project?: string): { ok: boolean; text: string } {
  const id = text(body.id);
  if (action === 'complete-all') {
    // Every finished thread still to check, approved in one go. Only threads: the calls agents made are not swept in.
    const ws = Workspace.open(ctx.cwd, ctx.now);
    let ids: string[];
    try {
      ids = review(ws, project ? ws.project(project) : ws.home).shipped.map((t) => t.id);
    } finally {
      ws.close();
    }
    return ids.length ? act(ctx, ['approve', ...ids]) : { ok: true, text: 'Nothing left to check.' };
  }
  if (action === 'move') {
    const to = text(body.to);
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    if (to === 'build') return act(ctx, ['build', id]);
    if (to === 'proposed') return act(ctx, ['propose', id]);
    return { ok: false, text: 'a thread can be moved to build, or back to proposed' };
  }
  if (action === 'add') {
    const words = text(body.text);
    const to = text(body.to);
    if (!words) return { ok: false, text: 'say what to add' };
    if (to !== 'proposed' && to !== 'build') return { ok: false, text: 'a thread can be added to proposed, or to build' };
    // Their words are kept whole as the note; the thread's name is the first line of them.
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'it could not be saved' };
    const filed = act(ctx, ['task', '--from', note, '--', oneLine(words.split('\n')[0]!, 110)]);
    const task = (filed.data as { task?: { id?: string; status?: string } } | null)?.task;
    if (!filed.ok || !task?.id) return { ok: false, text: filed.text || 'it could not be filed' };
    // Adding it under Build is the human putting it in build; under Proposed it waits, gate or no gate.
    if (to === 'build' && task.status === 'proposed') return act(ctx, ['build', task.id]);
    if (to === 'proposed' && task.status !== 'proposed') return act(ctx, ['propose', task.id]);
    return { ok: true, text: '' };
  }
  if (action === 'note') {
    const words = text(body.text);
    if (!words) return { ok: false, text: 'the note is empty' };
    if (id && !/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    // Their words, exactly, as a note; on a thread, it is attached to it.
    const captured = act(ctx, ['capture', '--', words]);
    const note = (captured.data as { note?: { id?: string } } | null)?.note?.id;
    if (!captured.ok || !note) return { ok: false, text: captured.text || 'the note could not be saved' };
    if (!id) return { ok: true, text: '' };
    const filed = act(ctx, ['file', note, '--into', id]);
    if (filed.ok || !/already (done|dropped)/.test(filed.text)) return filed;
    // A reply on finished work is feedback on it: new work, linked to what it answers, and proposed like any other.
    const next = act(ctx, ['task', '--from', note, '--from', id, '--', oneLine(words.split('\n')[0]!, 110)]);
    return next.ok ? { ok: true, text: 'That thread is finished, so your reply is a new proposed thread linked to it.' } : next;
  }
  if (action === 'edit') {
    // The ticket's fields. Each is the `spool edit` a person would have typed; the command checks the values.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    const argv = ['edit', id];
    if (typeof body.title === 'string' && body.title.trim()) argv.push(`--title=${body.title.trim()}`);
    if (typeof body.priority === 'number') argv.push(`--priority=${body.priority}`);
    if (typeof body.size === 'string' && body.size) argv.push(`--size=${body.size}`);
    if (Array.isArray(body.tags)) argv.push(...(body.tags.length ? body.tags.map((t) => `--tag=${String(t)}`) : ['--tag=none']));
    if (typeof body.version === 'string') argv.push(`--version=${body.version.trim() || 'none'}`);
    if (argv.length === 2) return { ok: false, text: 'nothing to change' };
    return act(ctx, argv);
  }
  if (action === 'complete') {
    // "Mark as complete" is the human saying the change is good: the same as approving it.
    if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
    return act(ctx, ['approve', id]);
  }
  if (action === 'answer') {
    const choice = text(body.choice);
    if (!/^d-[a-z0-9]+$/.test(id) || !choice) return { ok: false, text: 'which question, and what is the answer?' };
    return act(ctx, ['answer', id, '--', choice]);
  }
  return { ok: false, text: `the page cannot ${action}` };
}

function send(res: http.ServerResponse, status: number, type: string, payload: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

/** Start the page's server. Returns once it is listening. */
export function startPage(ctx: Ctx, options: { port?: number; project?: string }, ready: (started: Started) => void): http.Server {
  const token = randomBytes(18).toString('base64url');
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    // Only a browser pointed at this machine: a name another site resolved here is refused.
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'not this machine');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html', PAGE.replace('__TOKEN__', token));
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(board(ws, options.project)));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-spool-token'] !== token) return send(res, 403, 'application/json', JSON.stringify({ ok: false, text: 'reload the page' }));
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64_000) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', () => {
          let body: Body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body;
          } catch {
            return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'not JSON' }));
          }
          const result = change(ctx, url.pathname.slice('/api/'.length), body, options.project);
          send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
        });
        return;
      }
      send(res, 404, 'text/plain', 'nothing here');
    } catch (error) {
      const message = error instanceof SpoolError ? error.message : 'something went wrong';
      send(res, 500, 'application/json', JSON.stringify({ ok: false, text: message }));
      if (!(error instanceof SpoolError)) ctx.err(String(error));
    }
  });
  const listen = (port: number, triesLeft: number): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The usual port is taken, by another project's page perhaps: take the next one.
      if (error.code === 'EADDRINUSE' && triesLeft > 0 && !options.port) listen(port + 1, triesLeft - 1);
      else ctx.err(`spool: the page could not start: ${error.message}`);
    });
    server.listen(port, '127.0.0.1', () => ready({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }));
  };
  listen(options.port ?? 4747, 20);
  return server;
}

/** `spool page`: start the server, say where it is, and open it. The process stays up until it is stopped. */
export function servePage({ ctx, opts }: Bare): Result {
  const port = opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SpoolError('--port must be a port number');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool or no such project.
  const ws = Workspace.open(ctx.cwd, ctx.now);
  try {
    board(ws, project);
  } finally {
    ws.close();
  }
  startPage(ctx, { port, project }, ({ url }) => {
    ctx.out(`Spool page: ${url}`);
    ctx.out('Leave this running while you use the page. Ctrl-C stops it.');
    if (!opts['no-open']) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  return { text: '' };
}

// ------------------------------------------------------------------ the page

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spool</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🧶%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1c1a; --soft: #6f6c66; --line: #e4e1da;
    --accent: #c2410c; --go: #15803d; --blue: #1d4ed8; --warn: #b45309; --chip: #f0eee8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151413; --panel: #201f1d; --ink: #f1efea; --soft: #a19d95; --line: #33312d;
      --accent: #fb923c; --go: #4ade80; --blue: #93c5fd; --warn: #fbbf24; --chip: #2b2926; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center; padding: 18px 20px 14px; }
  h1 { font-size: 20px; margin: 0; font-weight: 650; }
  .add { width: 100%; text-align: left; border-style: dashed; background: transparent; color: var(--soft); }
  .add:hover { color: var(--ink); }
  .adding textarea { margin-top: 0; background: var(--panel); }
  .adding .acts { margin-top: 6px; }
  button { font: inherit; cursor: pointer; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 11px; }
  button:hover { border-color: var(--soft); }
  button.go { background: var(--go); border-color: var(--go); color: #fff; font-weight: 600; }
  @media (prefers-color-scheme: dark) { button.go { color: #052e16; } }
  .where { color: var(--soft); }
  .rule { padding: 0 20px 12px; color: var(--soft); font-size: 13px; }
  main { display: grid; grid-template-columns: repeat(4, minmax(240px, 1fr)); gap: 14px; padding: 0 20px 32px; align-items: start; overflow-x: auto; }
  section { background: var(--chip); border-radius: 14px; padding: 10px; min-height: 160px; border: 2px solid transparent; }
  section.over { border-color: var(--go); }
  section h2 { font-size: 13px; letter-spacing: .04em; text-transform: uppercase; margin: 4px 6px 10px; display: flex; justify-content: space-between; color: var(--soft); }
  section h2 b { color: var(--ink); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin-bottom: 9px; }
  .card[draggable=true] { cursor: grab; }
  .card.dragging { opacity: .45; }
  .top { display: flex; gap: 8px; align-items: baseline; }
  .n { color: var(--soft); font-variant-numeric: tabular-nums; min-width: 1.4em; }
  .title { font-weight: 600; flex: 1; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 0 0; }
  .chip { background: var(--chip); border-radius: 999px; padding: 1px 9px; font-size: 12px; color: var(--soft); }
  .chip.hot { color: var(--accent); }
  .chip.ai { color: var(--blue); }
  .note { margin-top: 7px; font-size: 13px; color: var(--soft); overflow-wrap: anywhere; }
  .q { margin-top: 8px; padding: 8px; border-radius: 9px; background: var(--chip); font-size: 13px; }
  .q button { margin: 6px 6px 0 0; }
  .q button.rec { border-color: var(--go); }
  .acts { display: flex; gap: 6px; margin-top: 9px; }
  details { margin-top: 8px; font-size: 13px; }
  summary { cursor: pointer; color: var(--soft); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 6px 0; }
  textarea { width: 100%; min-height: 54px; margin-top: 6px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--ink); font: inherit; resize: vertical; }
  .empty { color: var(--soft); font-size: 13px; padding: 8px 6px; }
  .title { cursor: pointer; }
  .title:hover { text-decoration: underline; }
  .openit { background: none; border: 0; padding: 0; margin-top: 8px; color: var(--soft); font-size: 13px; }
  .openit:hover { color: var(--ink); }
  .chip.ok { color: var(--go); }
  .tick { margin-left: auto; flex: none; width: 28px; height: 28px; padding: 0; border-radius: 50%; color: var(--go); font-weight: 700; }
  .tick:hover { background: var(--go); border-color: var(--go); color: #fff; }
  .foot { width: 100%; margin-bottom: 8px; }
  .history { background: none; border: 0; padding: 6px; color: var(--soft); font-size: 13px; width: 100%; text-align: left; }
  .history:hover { color: var(--ink); }
  .card.past { opacity: .7; }
  .chip.check { color: var(--warn); }
  #veil { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
  #thread { position: fixed; top: 5vh; left: 50%; transform: translateX(-50%); width: min(1000px, 96vw); max-height: 90vh; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow-y: auto; padding: 22px 24px 26px; box-shadow: 0 24px 64px rgba(0,0,0,.3); }
  .ticket { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 28px; }
  @media (max-width: 760px) { .ticket { grid-template-columns: 1fr; } #thread { top: 0; max-height: 100vh; border-radius: 0; width: 100vw; } }
  .key { font-size: 12px; color: var(--soft); margin: 0 40px 6px 0; }
  #thread h2 { font-size: 21px; margin: 0 0 6px; overflow-wrap: anywhere; border-radius: 6px; padding: 2px 4px; margin-left: -4px; outline: none; cursor: text; }
  #thread h2:hover, #thread h2:focus { background: var(--chip); }
  .side { border-left: 1px solid var(--line); padding-left: 22px; }
  @media (max-width: 760px) { .side { border-left: 0; padding-left: 0; border-top: 1px solid var(--line); } }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin-bottom: 5px; }
  .field select, .field input { width: 100%; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
  .field .val { font-size: 14px; }
  .tag { cursor: pointer; }
  .tag b { font-weight: 400; margin-left: 5px; opacity: .6; }
  .tag b:hover { opacity: 1; }
  #filter { margin: 0 20px 12px; font-size: 13px; }
  #filter button { border-radius: 999px; padding: 3px 11px; }
  #thread h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 22px 0 8px; }
  #thread .x { position: absolute; top: 14px; right: 16px; }
  .said { border-left: 3px solid var(--accent); padding: 4px 0 4px 12px; margin: 0 0 10px; }
  .feed { margin-top: 18px; }
  .post { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 18px; }
  .post::before { content: ''; position: absolute; left: 19px; top: 44px; bottom: 2px; width: 2px; background: var(--line); }
  .post:last-child::before { display: none; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 15px; color: #fff; background: var(--soft); }
  .avatar.you { background: var(--ink); color: var(--bg); }
  .avatar.claude { background: #d97757; }
  .avatar svg { width: 24px; height: 24px; }
  .byline { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .byline b { font-weight: 650; }
  .byline .model { background: var(--chip); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--soft); }
  .byline .at { color: var(--soft); font-size: 13px; }
  .post pre { margin: 3px 0 0; }
  .post .badge { display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--go); }
  .post .badge.ask { color: var(--warn); }
  .event { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; position: relative; padding-bottom: 14px; font-size: 13px; color: var(--soft); }
  .event::before { content: ''; position: absolute; left: 19px; top: 0; bottom: 0; width: 2px; background: var(--line); }
  .event .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--line); margin: 4px auto 0; position: relative; }
  .compose { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 12px; margin-top: 6px; }
  .compose textarea { margin-top: 0; }
  .compose .acts { margin-top: 8px; justify-content: flex-end; }
  details.desc { margin: 12px 0 0; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font-size: 14px; }
  details.desc summary { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; }
  .who { font-size: 12px; color: var(--soft); margin-bottom: 2px; }
  .step { display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 5px 0; font-size: 13px; border-top: 1px solid var(--line); }
  .step .at { color: var(--soft); font-variant-numeric: tabular-nums; }
  .step b { font-weight: 600; }
  .step.you b { color: var(--accent); }
  .reply { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--bg); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .finish { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line); }
  .finish button { width: 100%; padding: 10px; font-size: 15px; }
  .finish .ok { color: var(--go); font-weight: 600; }
  #said { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #said.on { opacity: 1; }
  @media (max-width: 900px) { main { grid-template-columns: repeat(4, 82vw); } }
</style>
</head>
<body>
<header>
  <h1>🧶 <span id="project">Spool</span></h1>
  <span class="where" id="where"></span>
</header>
<div class="rule" id="rule"></div>
<div id="filter" hidden></div>
<main id="board"></main>
<div id="veil" hidden></div>
<aside id="thread" hidden></aside>
<div id="said"></div>
<script>
const TOKEN = '__TOKEN__';
const COLUMNS = [
  ['proposed', '🟠 Proposed', 'Nothing here is built. Drag a thread to Build, or press ▶.'],
  ['build', '🟢 Build', 'Agents take these in order, top first.'],
  ['building', '🔵 Building', 'An agent has it now.'],
  ['done', '✅ Done', 'For you to check.'],
];
let last = '';
let busy = false;
// The thread that is open, if one is, and notes begun but not yet added.
let openId = null;
const drafts = new Map();
// Completed threads are history: kept, and out of the way until asked for.
let showHistory = false;
// The tag or version the board is narrowed to, as { kind: 'tag' | 'version', value }.
let only = null;
const SIZES = [['xs', 'Tiny'], ['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Huge']];
const PRIORITIES = ['Urgent', 'High', 'Normal', 'Someday'];
const shows = (c) => !only || (only.kind === 'tag' ? c.tags.includes(only.value) : c.version === only.value);
const narrow = (kind, value) => { only = only && only.kind === kind && only.value === value ? null : { kind, value }; last = ''; load(true); };
// The column whose "+ Add" is open, and what has been typed into it so far.
let adding = null;
let addDraft = '';

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

function say(words) {
  const box = document.getElementById('said');
  box.textContent = words;
  box.classList.add('on');
  clearTimeout(say.t);
  say.t = setTimeout(() => box.classList.remove('on'), 2600);
}

async function post(action, body, done) {
  busy = true;
  say('Saving…');
  try {
    const res = await fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': TOKEN }, body: JSON.stringify(body) });
    const out = await res.json();
    say(out.ok ? out.text || done : out.text || 'That did not work');
    return out.ok;
  } catch (e) {
    say('The page lost its server. Run spool page again.');
    return false;
  } finally {
    busy = false;
    last = '';
    // Show what was just done at once. The box they typed in still has the focus, and waiting for
    // it to lose it is what made adding feel stuck.
    load(true);
  }
}

function cardNode(c, column) {
  const movable = column === 'proposed' || column === 'build';
  const chips = el('div', { class: 'chips' },
    c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : 'For you to check'),
    c.type !== 'change' && el('span', { class: 'chip' }, c.type),
    c.difficulty && el('span', { class: 'chip' }, c.difficulty),
    column !== 'done' && el('span', { class: 'chip' + (c.urgent ? ' hot' : '') }, c.priority),
    c.suggested && el('span', { class: 'chip ai', title: c.suggested }, '✨ AI suggested'),
    c.version && el('span', { class: 'chip tag', title: 'Show only this version', onclick: () => narrow('version', c.version) }, 'v' + c.version),
    c.tags.map((t) => el('span', { class: 'chip tag', title: 'Show only this tag', onclick: () => narrow('tag', t) }, '#' + t)));
  const node = el('div', { class: 'card' + (c.complete ? ' past' : ''), draggable: movable, 'data-id': c.id,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', c.id + ' ' + column); node.classList.add('dragging'); busy = true; },
    ondragend: () => { node.classList.remove('dragging'); busy = false; } },
    el('div', { class: 'top' }, c.n != null && el('span', { class: 'n' }, c.n), el('span', { class: 'title', onclick: () => openThread(c.id) }, c.title),
      c.done && !c.complete && el('button', { class: 'tick', title: 'Mark as complete', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓')),
    chips,
    c.note && el('div', { class: 'note' }, c.note));

  if (c.question) {
    node.append(el('div', { class: 'q' }, el('div', {}, '❓ ' + c.question.title),
      c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '',
        onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o))));
  }
  if (column === 'proposed') node.append(el('div', { class: 'acts' }, el('button', { class: 'go', onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title) }, '▶ Build')));
  if (column === 'build') node.append(el('div', { class: 'acts' }, el('button', { onclick: () => post('move', { id: c.id, to: 'proposed' }, 'Back to proposed') }, 'Not yet')));

  const steps = c.thread.steps.length;
  node.append(el('button', { class: 'openit', onclick: () => openThread(c.id) }, 'Open thread' + (steps ? ' · ' + steps + (steps === 1 ? ' step' : ' steps') : '')));
  return node;
}

// ---- a card opened up: what was asked, what was done and by whom, and how it got here

const whoIs = (who) => (who === 'human' ? 'You' : who === 'agent' ? 'An agent' : who === 'loop' ? 'The loop' : who || 'Someone');
// An agent that signed with its model's name is shown as who it is: "Claude" and the model beside it.
const speaker = (who) => {
  if (who === 'human') return { name: 'You', model: '', kind: 'you' };
  const claude = /^claude\b[\s-]*(.*)$/i.exec(who || '');
  if (claude) return { name: 'Claude', model: claude[1].trim(), kind: 'claude' };
  if (who === 'agent' || !who) return { name: 'Agent', model: '', kind: 'agent' };
  if (who === 'loop') return { name: 'The loop', model: '', kind: 'agent' };
  return { name: who, model: '', kind: 'agent' };
};
// A sunburst for Claude: drawn here, not the official mark.
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>';
function avatar(who) {
  const s = speaker(who);
  const node = el('div', { class: 'avatar ' + s.kind, title: s.model ? s.name + ' ' + s.model : s.name });
  if (s.kind === 'claude') node.innerHTML = SUN;
  else node.textContent = s.kind === 'you' ? 'You'.slice(0, 1) : '🤖';
  return node;
}
function byline(who, at) {
  const s = speaker(who);
  return el('div', { class: 'byline' }, el('b', {}, s.name), s.model && el('span', { class: 'model' }, s.model), el('span', { class: 'at' }, when(at)));
}
const when = (at) => (at ? at.slice(5, 10).replace('-', '/') + ' ' + at.slice(11, 16) : '');

// The open thread is in the address, so a ticket can be linked to and survives a reload.
function openThread(id) { openId = id; history.replaceState(null, '', '#' + id); last = ''; load(true); }
function closeThread() { openId = null; history.replaceState(null, '', location.pathname); last = ''; load(true); }

// A ticket, the way a board has always shown one: the story on the left, its fields on the right.
function threadNode(c, b) {
  const t = c.thread;
  const save = (fields, done) => post('edit', { id: c.id, ...fields }, done);
  const box = el('textarea', { placeholder: 'Post your reply', oninput: (e) => drafts.set(c.id, e.target.value) });
  box.value = drafts.get(c.id) || '';
  const lineage = [
    ...t.cameFrom.map((f) => 'Came out of: ' + f.title),
    ...t.parts.map((p) => 'Part: ' + p.title + ' (' + p.state + ')'),
    ...t.questions.map((q) => 'Asked: ' + q.title + (q.choice ? ' → ' + q.choice : ' → not answered yet')),
  ];

  const title = el('h2', { contenteditable: 'plaintext-only', spellcheck: 'false', title: 'Click to rename',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = c.title; e.target.blur(); e.stopPropagation(); } },
    onblur: (e) => { const now = e.target.textContent.trim(); if (now && now !== c.title) save({ title: now }, 'Renamed'); else e.target.textContent = c.title; } }, c.title);

  const story = el('div', {},
    el('div', { class: 'key' }, (c.n != null ? '#' + c.n + ' · ' : '') + c.id),
    title,
    (t.spec || c.suggested) && el('details', { class: 'desc', open: true },
      el('summary', {}, 'Description'),
      c.suggested && el('pre', {}, '✨ Why the agent suggested it: ' + c.suggested),
      t.spec && el('pre', {}, t.spec)),

    // The thread itself: a conversation, oldest first. You said, Claude answered, and the moves in between.
    el('div', { class: 'feed' },
      t.feed.map((p) => {
        if (p.kind === 'event') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }), el('div', {}, speaker(p.who).name + ' ' + p.text + ' · ' + when(p.at)));
        }
        const asking = p.kind === 'asked' && c.question && c.question.title === p.text;
        return el('div', { class: 'post' }, avatar(p.who),
          el('div', {}, byline(p.who, p.at),
            p.kind === 'shipped' && el('span', { class: 'badge' }, '✓ Shipped'),
            p.kind === 'asked' && el('span', { class: 'badge ask' }, '❓ Needs a call from you'),
            el('pre', {}, p.text),
            p.kind === 'shipped' && t.commits.length > 0 && el('div', { class: 'mono', style: 'margin-top: 6px; color: var(--soft)' }, (t.commits.length === 1 ? 'commit ' : 'commits ') + t.commits.join(' · ')),
            asking && el('div', {}, c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '', style: 'margin: 8px 6px 0 0',
              onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)))));
      }),
      // A question with no line of its own in the log still has to be answerable here.
      c.question && !t.feed.some((p) => p.kind === 'asked' && p.text === c.question.title) && el('div', { class: 'post' }, avatar(t.by || 'agent'),
        el('div', {}, byline(t.by || 'agent', ''), el('span', { class: 'badge ask' }, '❓ Needs a call from you'), el('pre', {}, c.question.title),
          el('div', {}, c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '', style: 'margin: 8px 6px 0 0',
            onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)))))),

    t.report && el('details', { class: 'desc', open: true }, el('summary', {}, c.type === 'plan' ? 'The plan' : 'The report'), el('pre', {}, t.report)),

    lineage.length > 0 && [el('h3', {}, 'Linked'), lineage.map((l) => el('div', { class: 'note' }, l))],

    el('div', { class: 'compose' }, avatar('human'),
      el('div', {}, box,
        el('div', { class: 'acts' }, el('button', { class: 'go', onclick: async () => {
          if (!box.value.trim()) return;
          if (await post('note', { id: c.id, text: box.value }, 'Posted to the thread')) drafts.delete(c.id);
        } }, 'Reply')))),
    c.done && el('div', { class: 'finish' }, c.complete
      ? el('div', { class: 'ok' }, '✓ Complete. You approved this change.')
      : el('button', { class: 'go', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓ Mark as complete')));

  const field = (label, ...kids) => el('div', { class: 'field' }, el('label', {}, label), kids);
  const choose = (options, value, onchange) => {
    const node = el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  const movable = c.column === 'proposed' || c.column === 'build';
  const status = movable
    ? choose([['proposed', '🟠 Proposed'], ['build', '🟢 Build']], c.column, (to) => post('move', { id: c.id, to }, to === 'build' ? 'In build' : 'Back to proposed'))
    : el('div', { class: 'val' }, c.column === 'building' ? '🔵 Building' + (t.by ? ', by ' + whoIs(t.by) : '') : c.complete ? '✅ Done · complete' : '✅ Done · for you to check');
  const addTag = el('input', { placeholder: 'Add a tag', list: 'known-tags',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      e.preventDefault();
      save({ tags: [...c.tags, e.target.value.trim()] }, 'Tagged');
    } });
  const version = el('input', { placeholder: 'None', list: 'known-versions',
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    onchange: (e) => { if (e.target.value.trim() !== c.version) save({ version: e.target.value }, e.target.value.trim() ? 'Version set' : 'Version cleared'); } });
  version.value = c.version;

  const side = el('div', { class: 'side' },
    field('Status', status),
    field('Priority', c.done ? el('div', { class: 'val' }, c.priority) : choose(PRIORITIES.map((name, i) => [String(i), name]), String(c.p), (v) => save({ priority: Number(v) }, 'Priority: ' + PRIORITIES[Number(v)]))),
    field('Difficulty', c.done ? el('div', { class: 'val' }, c.difficulty || 'Not sized') : choose([['', 'Not sized'], ...SIZES], c.size, (v) => v && save({ size: v }, 'Difficulty changed'))),
    field('Tags',
      el('div', { class: 'chips', style: 'margin: 0 0 7px' }, c.tags.map((tag) => el('span', { class: 'chip tag' }, '#' + tag,
        el('b', { title: 'Remove', onclick: () => save({ tags: c.tags.filter((x) => x !== tag) }, 'Tag removed') }, '✕')))),
      addTag, el('datalist', { id: 'known-tags' }, b.tags.filter((x) => !c.tags.includes(x)).map((x) => el('option', { value: x })))),
    field('Version', version, el('datalist', { id: 'known-versions' }, b.versions.map((x) => el('option', { value: x })))),
    c.type !== 'change' && field('Type', el('div', { class: 'val' }, c.type)),
    (c.column === 'building' || c.done) && field('Built by', el('div', { class: 'val' }, whoIs(t.by))),
    c.suggested && field('Came from', el('div', { class: 'val' }, '✨ AI suggested')),
    field('Created', el('div', { class: 'val' }, c.created.slice(0, 10))),
    field('Updated', el('div', { class: 'val' }, c.updated.slice(0, 16).replace('T', ' '))));

  return [el('button', { class: 'x', onclick: closeThread, title: 'Close' }, '✕'), el('div', { class: 'ticket' }, story, side)];
}

function drawThread(b) {
  const pane = document.getElementById('thread');
  const veil = document.getElementById('veil');
  const c = openId && Object.values(b.columns).flat().find((x) => x.id === openId);
  pane.hidden = veil.hidden = !c;
  if (!c) { openId = null; return; }
  const at = pane.scrollTop;
  pane.replaceChildren(...threadNode(c, b));
  pane.scrollTop = at;
}


function draw(b) {
  document.getElementById('project').textContent = b.project;
  // The yarn is the tab's icon, so the title is the project's name alone.
  document.title = b.project;
  document.getElementById('where').textContent = b.version ? 'v' + b.version : '';
  // The header is the project's name and its version. One thing is still worth a line: a project
  // where the gate is off, because there the board cannot promise that nothing builds by itself.
  const rule = document.getElementById('rule');
  rule.textContent = b.gate ? '' : 'The build gate is off in this project: new threads go straight to Build.';
  rule.hidden = b.gate;
  const main = document.getElementById('board');
  const filter = document.getElementById('filter');
  filter.hidden = !only;
  if (only) filter.replaceChildren('Showing only ', el('button', { onclick: () => narrow(only.kind, only.value) }, (only.kind === 'tag' ? '#' : 'v') + only.value + '  ✕'));
  main.replaceChildren(...COLUMNS.map(([key, name, hint]) => {
    const every = b.columns[key].filter(shows);
    // Done shows what is still for them to check. What they marked complete is history, a click away.
    const past = key === 'done' ? every.filter((c) => c.complete) : [];
    const cards = key === 'done' ? every.filter((c) => !c.complete) : every;
    const drop = key === 'proposed' || key === 'build';
    return el('section', { 'data-column': key,
      ondragover: (e) => { if (drop) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.currentTarget.classList.remove('over');
        const [id, from] = e.dataTransfer.getData('text/plain').split(' ');
        if (!drop || !id || from === key) return;
        e.preventDefault();
        post('move', { id, to: key }, key === 'build' ? 'In build' : 'Back to proposed');
      } },
      el('h2', {}, el('b', {}, name), el('span', {}, String(cards.length))),
      cards.length ? cards.map((c) => cardNode(c, key)) : el('div', { class: 'empty' }, key === 'done' ? 'Nothing left to check.' : hint),
      key === 'done' && cards.length > 1 && el('button', { class: 'foot go', onclick: () => post('complete-all', {}, 'All marked as complete') }, '✓ Mark all ' + cards.length + ' as complete'),
      key === 'done' && b.history > 0 && el('button', { class: 'history', onclick: () => { showHistory = !showHistory; last = ''; load(true); } },
        (showHistory ? '▾ Hide history' : '▸ History') + ' · ' + b.history + ' complete'),
      key === 'done' && showHistory && past.map((c) => cardNode(c, key)),
      key === 'done' && showHistory && b.history > past.length && !only && el('div', { class: 'empty' }, '+ ' + (b.history - past.length) + ' older'),
      drop && addNode(key));
  }));
  const box = document.querySelector('.adding textarea');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  drawThread(b);
}

// "+ Add" at the foot of a column: a thread added there starts in that column.
function addNode(column) {
  if (adding !== column) {
    return el('button', { class: 'add', onclick: () => { adding = column; addDraft = ''; last = ''; load(true); } }, '+ Add');
  }
  const close = () => { adding = null; addDraft = ''; last = ''; load(true); };
  const save = async () => {
    const words = addDraft.trim();
    if (!words) return;
    adding = null;
    addDraft = '';
    await post('add', { text: words, to: column }, column === 'build' ? 'Added to build' : 'Added as proposed');
  };
  const box = el('textarea', { placeholder: column === 'build' ? 'What should be built?' : 'What do you want added?',
    oninput: (e) => { addDraft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') close();
    } });
  box.value = addDraft;
  return el('div', { class: 'adding' }, box,
    el('div', { class: 'acts' }, el('button', { class: 'go', onclick: save }, 'Add'), el('button', { onclick: close }, 'Cancel')));
}

async function load(now) {
  // Never redraw under someone's typing or choosing; a redraw that was asked for goes ahead.
  const at = document.activeElement;
  if (!now && (busy || ['TEXTAREA', 'INPUT', 'SELECT'].includes(at?.tagName) || at?.isContentEditable)) return;
  try {
    const text = await (await fetch('/api/board')).text();
    if (text === last) return;
    last = text;
    draw(JSON.parse(text));
  } catch (e) {
    say('The page lost its server. Run spool page again.');
  }
}

if (/^#t-[a-z0-9]+$/.test(location.hash)) openId = location.hash.slice(1);
document.getElementById('veil').addEventListener('click', closeThread);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId && !adding && !document.activeElement?.isContentEditable) closeThread(); });
load();
setInterval(load, 1500);
</script>
</body>
</html>
`;
