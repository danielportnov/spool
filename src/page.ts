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
 * human: `build`, `propose`, `capture`, `task`, `file`, `answer`, `approve`. So the page can do
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
import { type Item, SpoolError, oneLine, splitBody } from './model.ts';
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
  /** Who built it, as they signed themselves. */
  by: string;
  summary: string;
  commits: string[];
  cameFrom: { id: string; title: string }[];
  parts: { id: string; title: string; state: string }[];
  questions: { id: string; title: string; status: string; choice: string }[];
}

interface Board {
  project: string;
  version: string;
  gate: boolean;
  columns: Record<Column, Card[]>;
  also: { assumptions: number; skills: number; inbox: number };
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;
const DONE_SHOWN = 12;

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

function threadOf(ws: Workspace, task: Item, main: string, log: string[]): Thread {
  const steps = log.map((line) => {
    const parsed = /^- (\d{4}-\d\d-\d\d \d\d:\d\dZ) (.+?): (.*)$/.exec(line);
    return parsed ? { at: parsed[1]!, who: parsed[2]!, what: parsed[3]! } : { at: '', who: '', what: line.replace(/^- /, '') };
  });
  const from = task.from.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind !== 'note');
  const asked = task.needs.map((id) => ws.find(id)).filter((i): i is Item => !!i && i.kind === 'decision');
  return {
    ...readBody(main),
    steps,
    by: task.by ?? '',
    summary: task.summary ?? '',
    commits: task.commits.map((c) => c.slice(0, 7)),
    cameFrom: from.map((i) => ({ id: i.id, title: i.title })),
    parts: children(ws, task).map((k) => ({ id: k.id, title: k.title, state: taskState(ws, k) })),
    questions: asked.map((d) => ({ id: d.id, title: d.title, status: d.status, choice: d.choice ?? '' })),
  };
}

function card(ws: Workspace, task: Item, n: number | null, note: string): Card {
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
    if (column) columns[column].push(card(ws, row.item, row.n, cardNote(row)));
  }
  const done = tasks(ws, spool)
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updated.localeCompare(a.updated));
  for (const t of done.slice(0, DONE_SHOWN)) {
    columns.done.push(card(ws, t, null, `${age(t.updated, ws.now())} ago${t.summary ? ` · ${oneLine(t.summary, 160)}` : ''}`));
  }
  const queue = review(ws, spool);
  return {
    project: spool.name,
    version: projectVersion(spool.root),
    gate: !!spool.config.gate,
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
function change(ctx: Ctx, action: string, body: Body): { ok: boolean; text: string } {
  const id = text(body.id);
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
    return id ? act(ctx, ['file', note, '--into', id]) : { ok: true, text: '' };
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
          const result = change(ctx, url.pathname.slice('/api/'.length), body);
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
  .chip.check { color: var(--warn); }
  #veil { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
  #thread { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; padding: 18px 20px 28px; box-shadow: -12px 0 32px rgba(0,0,0,.18); }
  #thread h2 { font-size: 18px; margin: 0 34px 4px 0; overflow-wrap: anywhere; }
  #thread h3 { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--soft); margin: 22px 0 8px; }
  #thread .x { position: absolute; top: 14px; right: 16px; }
  .said { border-left: 3px solid var(--accent); padding: 4px 0 4px 12px; margin: 0 0 10px; }
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
  ['done', '✅ Done', 'Most recent first.'],
];
let last = '';
let busy = false;
// The thread that is open, if one is, and notes begun but not yet added.
let openId = null;
const drafts = new Map();
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
  try {
    const res = await fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': TOKEN }, body: JSON.stringify(body) });
    const out = await res.json();
    say(out.ok ? done : out.text || 'That did not work');
    return out.ok;
  } catch (e) {
    say('The page lost its server. Run spool page again.');
    return false;
  } finally {
    busy = false;
    last = '';
    load();
  }
}

function cardNode(c, column) {
  const movable = column === 'proposed' || column === 'build';
  const chips = el('div', { class: 'chips' },
    c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : 'For you to check'),
    c.type !== 'change' && el('span', { class: 'chip' }, c.type),
    c.difficulty && el('span', { class: 'chip' }, c.difficulty),
    column !== 'done' && el('span', { class: 'chip' + (c.urgent ? ' hot' : '') }, c.priority),
    c.suggested && el('span', { class: 'chip ai', title: c.suggested }, '✨ AI suggested'));
  const node = el('div', { class: 'card', draggable: movable, 'data-id': c.id,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', c.id + ' ' + column); node.classList.add('dragging'); busy = true; },
    ondragend: () => { node.classList.remove('dragging'); busy = false; } },
    el('div', { class: 'top' }, c.n != null && el('span', { class: 'n' }, c.n), el('span', { class: 'title', onclick: () => openThread(c.id) }, c.title)),
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
const when = (at) => (at ? at.slice(5, 10).replace('-', '/') + ' ' + at.slice(11, 16) : '');

function openThread(id) { openId = id; last = ''; load(true); }
function closeThread() { openId = null; last = ''; load(true); }

function threadNode(c) {
  const t = c.thread;
  const box = el('textarea', { placeholder: 'Reply on this thread, in your words', oninput: (e) => drafts.set(c.id, e.target.value) });
  box.value = drafts.get(c.id) || '';
  const lineage = [
    ...t.cameFrom.map((f) => 'Came out of: ' + f.title),
    ...t.parts.map((p) => 'Part: ' + p.title + ' (' + p.state + ')'),
    ...t.questions.map((q) => 'Asked: ' + q.title + (q.choice ? ' → ' + q.choice : ' → not answered yet')),
  ];
  return [
    el('button', { class: 'x', onclick: closeThread, title: 'Close' }, '✕'),
    el('h2', {}, (c.n != null ? c.n + ' · ' : '') + c.title),
    el('div', { class: 'chips' },
      c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : 'For you to check'),
      c.type !== 'change' && el('span', { class: 'chip' }, c.type),
      c.difficulty && el('span', { class: 'chip' }, c.difficulty),
      el('span', { class: 'chip' + (c.urgent ? ' hot' : '') }, c.priority),
      c.suggested && el('span', { class: 'chip ai' }, '✨ AI suggested')),

    t.said.length > 0 && el('h3', {}, 'What you said'),
    t.said.map((s) => el('div', { class: 'said' }, el('div', { class: 'who' }, 'You' + (s.on ? ' · ' + s.on : '')), el('pre', {}, s.text))),
    c.suggested && [el('h3', {}, 'Why the agent suggested it'), el('pre', {}, c.suggested)],
    t.spec && [el('h3', {}, 'The spec'), el('pre', {}, t.spec)],

    c.done && [el('h3', {}, 'The response'),
      el('div', { class: 'reply' },
        el('div', { class: 'who' }, '🤖 Built by ' + whoIs(t.by)),
        el('pre', {}, t.summary || 'No summary was left.'),
        t.commits.length > 0 && el('div', { class: 'mono' }, (t.commits.length === 1 ? 'commit ' : 'commits ') + t.commits.join(' · ')))],
    c.question && [el('h3', {}, 'Waiting on you'), el('div', { class: 'q' }, el('div', {}, '❓ ' + c.question.title),
      c.question.options.map((o, i) => el('button', { class: c.question.recommend === i + 1 ? 'rec' : '',
        onclick: () => post('answer', { id: c.question.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)))],

    t.steps.length > 0 && el('h3', {}, 'Everything that happened'),
    t.steps.map((s) => el('div', { class: 'step' + (s.who === 'human' ? ' you' : '') },
      el('span', { class: 'at' }, when(s.at)), el('span', {}, el('b', {}, whoIs(s.who)), ' ' + s.what))),
    lineage.length > 0 && [el('h3', {}, 'Where it came from, and what came of it'), lineage.map((l) => el('div', { class: 'note' }, l))],

    el('h3', {}, 'Add to this thread'),
    box,
    el('button', { onclick: async () => {
      if (!box.value.trim()) return;
      if (await post('note', { id: c.id, text: box.value }, 'Added to the thread')) drafts.delete(c.id);
    } }, 'Add note'),

    c.done && el('div', { class: 'finish' }, c.complete
      ? el('div', { class: 'ok' }, '✓ Complete. You approved this change.')
      : el('button', { class: 'go', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓ Mark as complete')),
  ];
}

function drawThread(b) {
  const pane = document.getElementById('thread');
  const veil = document.getElementById('veil');
  const c = openId && Object.values(b.columns).flat().find((x) => x.id === openId);
  pane.hidden = veil.hidden = !c;
  if (!c) { openId = null; return; }
  const at = pane.scrollTop;
  pane.replaceChildren(...threadNode(c).flat(3).filter(Boolean));
  pane.scrollTop = at;
}


function draw(b) {
  document.getElementById('project').textContent = b.project;
  document.title = '🧶 ' + b.project;
  document.getElementById('where').textContent = b.version ? 'v' + b.version : '';
  // The header is the project's name and its version. One thing is still worth a line: a project
  // where the gate is off, because there the board cannot promise that nothing builds by itself.
  const rule = document.getElementById('rule');
  rule.textContent = b.gate ? '' : 'The build gate is off in this project: new threads go straight to Build.';
  rule.hidden = b.gate;
  const main = document.getElementById('board');
  main.replaceChildren(...COLUMNS.map(([key, name, hint]) => {
    const cards = b.columns[key];
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
      cards.length ? cards.map((c) => cardNode(c, key)) : el('div', { class: 'empty' }, hint),
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
  // Never redraw under someone's typing; opening or closing "+ Add" is the one redraw that is asked for.
  if (!now && (busy || document.activeElement?.tagName === 'TEXTAREA')) return;
  try {
    const text = await (await fetch('/api/board')).text();
    if (text === last) return;
    last = text;
    draw(JSON.parse(text));
  } catch (e) {
    say('The page lost its server. Run spool page again.');
  }
}

document.getElementById('veil').addEventListener('click', closeThread);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId && !adding) closeThread(); });
load();
setInterval(load, 3000);
</script>
</body>
</html>
`;
