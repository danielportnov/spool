/**
 * The page's server, and the `spool page` command that starts it.
 *
 * `startPage` is a small HTTP server: it sends the page (`client/`), the board as JSON
 * (`board.ts`) and what an agent said on a run (`heard.ts`), and takes what the human does on
 * the page as POSTs. Each of those is an ordinary
 * command run as the human (`act.ts`), or a word to the runner it holds (`engine.ts`): on, off,
 * stop, interrupt, and the answer to an agent's question. A thread moved between columns is both, so `moveThread` is here, beside the runner it
 * tells. `servePage` is the command: it points at the page already up for a project, or starts
 * one, in the background if asked, and stays up to start it again when the page restarts onto
 * new code (`upkeep.ts`, `detach.ts`).
 *
 * The server listens on 127.0.0.1 only. Changing anything needs the token it
 * hands to its own page, and a Host header that names this machine, so another
 * website open in the same browser cannot press play on your behalf.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Body, act, change, text } from './act.ts';
import { askCleanup, cleanupAsked } from './cleanup.ts';
import { settle } from './leave.ts';
import { type Column, board, columnOf, diffOf } from './board.ts';
import { PAGE } from './client/page.html.ts';
import type { Bare, Result } from './commands.ts';
import { type Ctx, afkOf, builderOf, saveBuilder } from './context.ts';
import { type PageRecord, detachPage, forgetPage, pageStatus, pageUp, realOf, rememberPage, startedAbove, stopPage } from './detach.ts';
import { Runner } from './engine.ts';
import { heardRun } from './heard.ts';
import { lineageSections, threadLineage } from './lineage.ts';
import { type Item, type Spool, SpoolError, isRun } from './model.ts';
import { MAX_BYTES, pictureFile } from './pictures.ts';
import { sprintReview } from './review.ts';
import { openRun, taskState, tasks } from './schedule.ts';
import { readProposals, unanswered } from './proposals.ts';
import { atOnceIn } from './slots.ts';
import { rosterView, saveAgent } from './roster.ts';
import { briefAcross, named, projectsOf } from './projects.ts';
import { Workspace } from './store.ts';
import { CODE_DIR, CODE_EXT, Upkeep } from './upkeep.ts';
import { takeOverState } from './takeover.ts';
import { noticesOf } from './notices.ts';
import { usageOf } from './usage.ts';
import { watched } from './watch.ts';

interface Started {
  url: string;
  server: http.Server;
  /** What a POST must carry: kept in the page's record, so `spool agents` on this machine can use it. */
  token: string;
}

/**
 * A thread dragged to any column, from any column, at any time. Each move is the
 * commands a person would have typed for it:
 *
 *   - Backlog: off whoever is building it, and its work undone. An agent this
 *     page runs is ended first, then the files it changed and its commits are put back.
 *   - Build: it waits there. One being built is stopped with its work kept, and stays stopped until carried on; one done is reverted.
 *   - Building: this page builds it next, with agents switched on: now, if there is room. Where a chat builds, it waits in Build for the chat.
 *   - Done: the human marking it done; an agent of this page's on it is ended.
 */
function moveThread(ctx: Ctx, runner: Runner, id: string, to: string, who: Who): { ok: boolean; text: string; data?: unknown } {
  if (!/^t-[a-z0-9]+$/.test(id)) return { ok: false, text: 'which thread?' };
  if (!['proposed', 'build', 'building', 'done'].includes(to)) return { ok: false, text: 'a thread can be moved to the backlog, build, building or done' };
  let from: Column | null;
  let title = '';
  const ws = Workspace.open(ctx.cwd, ctx.now);
  try {
    const task = ws.get(id, 'task');
    from = columnOf(taskState(ws, task));
    title = task.title;
  } finally {
    ws.close();
  }
  if (!from) return { ok: false, text: `${id} was dropped` };
  if (from === to) return { ok: true, text: '' };
  const ours = runner.runs.has(id);

  if (to === 'proposed') {
    if (from === 'build') return act(ctx, ['propose', id]);
    if (from === 'building' && ours) {
      // Moved now, so the agent cannot finish it; its edits come off once it has gone.
      const moved = act(ctx, ['propose', '--abort', id]);
      if (moved.ok) runner.abort(id, true);
      return moved.ok ? { ...moved, text: 'Stopped, and back in the backlog. What the agent changed is being undone.' } : moved;
    }
    const undone = act(ctx, ['propose', '--undo', id]);
    return undone.ok ? { ...undone, text: `Back in the backlog, its commits undone: ${title}` } : undone;
  }

  if (to === 'build') {
    if (from === 'proposed') {
      const built = act(ctx, ['build', id]);
      // In Build is the human saying start: with room for it, its agent starts now.
      if (built.ok) runner.wake();
      return built;
    }
    if (from === 'done') {
      const reverted = act(ctx, ['revert', id, '--now', '--message=moved back to build on the page']);
      return reverted.ok ? { ...reverted, text: `Undone, and back in build: ${title}` } : reverted;
    }
    const stopped = act(ctx, ['build', '--abort', id]);
    if (stopped.ok) runner.abort(id);
    return stopped.ok ? { ...stopped, text: `Stopped, with its work kept. It waits in build until you carry on: ${title}` } : stopped;
  }

  if (to === 'building') {
    if (from === 'done') {
      const reverted = act(ctx, ['revert', id, '--now', '--message=moved back to building on the page']);
      if (!reverted.ok) return reverted;
    }
    if (from === 'proposed') {
      const built = act(ctx, ['build', id]);
      if (!built.ok) return built;
    }
    const check = Workspace.open(ctx.cwd, ctx.now);
    let state = '';
    try {
      state = taskState(check, check.get(id, 'task'));
    } finally {
      check.close();
    }
    if (state !== 'ready') return { ok: true, text: `In build, but it cannot start yet: it is ${state}.` };
    // With a chat building, the page starts nothing: the thread waits in Build for the chat to take.
    if (who === 'chat') return { ok: true, text: `In build, for the chat to take: ${title}` };
    if (who === 'elsewhere') return { ok: true, text: `In build, for its own page or a chat to take: ${title}` };
    runner.on = true;
    return { ok: true, text: runner.take(id) ? `Building now: ${title}` : `Next up, once an agent is free: ${title}` };
  }

  // Done: the human saying it is finished. A thread still in the backlog goes through build, as any start does.
  if (from === 'proposed') {
    const built = act(ctx, ['build', id]);
    if (!built.ok) return built;
  }
  const done = act(ctx, ['done', id, '--message=Marked done on the page']);
  if (!done.ok) {
    if (from === 'proposed') act(ctx, ['propose', id]);
    return done;
  }
  if (ours) runner.abort(id);
  return { ...done, text: `Done: ${title}` };
}

/** Who builds a project's threads, as a move sees it: this page's runner, a chat, or neither, since this page was started for another project. */
type Who = 'page' | 'chat' | 'elsewhere';

/**
 * The ids a POST names, each to be an item of the project it was sent for: what is done on one
 * project's board never reaches into another's.
 */
function strays(ws: Workspace, spool: Spool, body: Body): string[] {
  const ids = [body.id, body.before, body.after, ...(Array.isArray(body.ids) ? body.ids : [])].map(text).filter((id) => /^[a-z]-[a-z0-9]+$/.test(id));
  return ids.filter((id) => {
    const item = ws.find(id);
    return !!item && item.spool !== spool;
  });
}

function send(res: http.ServerResponse, status: number, type: string, payload: string): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

/** What a page restarting onto new code hands to the page that takes over: the same address, and whether agents were on. */
interface Resume {
  port: number;
  run: boolean;
}

/** The real folders of the projects a page builds: the one named, or with none named every one of the workspace. */
export function servedBy(ws: Workspace, project: string | undefined): string[] {
  return (project ? [ws.project(project)] : ws.spools).map((spool) => realOf(spool.root));
}

/**
 * Start the page's server. Returns once it is listening.
 *
 * `restart` is how the page gets onto new code once it finds some on disk: without it, it stays
 * on what it loaded. `resumed` says this page is taking over from one that restarted.
 */
export function startPage(
  ctx: Ctx,
  options: {
    port?: number;
    project?: string;
    run?: boolean;
    agent?: string;
    resumed?: boolean;
    restart?: (resume: Resume) => void;
    /** Told the projects the page builds, by their real folders, each time it reads them: a project set up below since is one more. */
    serves?: (roots: string[]) => void;
  },
  ready: (started: Started) => void,
): http.Server {
  const token = randomBytes(18).toString('base64url');
  const runner = new Runner(ctx, options.project, options.agent, !!options.run);
  const handOver = (agentsOn: boolean): void => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('the page is not listening');
    // Nothing more is started from here: the page that takes over does it.
    runner.close();
    options.restart!({ port: address.port, run: agentsOn });
  };
  const upkeep = new Upkeep(ctx, options.project, runner, options.restart ? handOver : undefined);
  runner.upkeep = () => upkeep.check();
  // The project the page was started for, and whether its runner builds another. Started with no
  // project named, it builds every project of the workspace; named, that one only.
  const own = (ws: Workspace): Spool => (options.project ? ws.project(options.project) : ws.home);
  const builds = (ws: Workspace, spool: Spool): boolean => !options.project || spool === own(ws);
  const whoBuilds = (ws: Workspace, spool: Spool): Who => (!builds(ws, spool) ? 'elsewhere' : builderOf(ctx, spool.root) === 'chat' ? 'chat' : 'page');
  /** A command run for one project: in its own folder, so it reads and writes that project's spool and no other. */
  const inProject = (ws: Workspace, spool: Spool): Ctx => (spool === ws.home ? ctx : { ...ctx, cwd: spool.root });
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    // Only a browser pointed at this machine: a name another site resolved here is refused.
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'not this machine');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html', PAGE.replace('__TOKEN__', token).replace('__BUILD__', upkeep.build));
      if (req.method === 'GET' && url.pathname === '/api/board') {
        // Someone is looking: an agent's question can wait for them.
        runner.looked();
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          options.serves?.(servedBy(ws, options.project));
          // The project asked for, by its name on the workspace's own list; any other is the page's own.
          const spool = named(ws, url.searchParams.get('project')) ?? own(ws);
          const shown = board(ws, spool === ws.home ? undefined : spool.name, runner, upkeep, builderOf(ctx, spool.root), atOnceIn(ctx, spool.root), usageOf(ctx), noticesOf(ctx), builderOf(ctx, spool.root) === 'chat' ? rosterView(ctx, ws, spool) : []);
          const several = ws.spools.length > 1;
          const workspace = {
            projects: projectsOf(ws, (p) => builds(ws, p), (id) => runner.runs.get(id)?.lines),
            current: spool.name,
            // Started at the top with nobody named, the page opens on all of them.
            opens: several && !options.project ? '' : own(ws).name,
            // Asked for by the home view alone; left out otherwise, so the page knows to ask.
            brief: several && url.searchParams.get('home') === '1' ? briefAcross(ws) : undefined,
          };
          // Whether the chat takes over this project's backlog, and what it would take next, for the header's switch and its menu.
          const takeOver = takeOverState(ctx, ws, spool);
          // The backlog's Clean Up: a pass open now, a request still waiting for whoever builds, and the leave that is live.
          const live = settle(ws, spool).live;
          // The newest pass whose proposals still wait for a yes or a no, so the button can lead there too.
          const waits = tasks(ws, spool)
            .filter((t) => isRun(t) && t.status !== 'active' && unanswered(readProposals(t)).length)
            .sort((a, b) => b.created.localeCompare(a.created))[0];
          const cleanup = {
            open: openRun(ws, spool)?.id ?? null,
            asked: cleanupAsked(spool)?.at ?? null,
            leave: live ? live.words : null,
            waiting: waits ? { id: waits.id, count: unanswered(readProposals(waits)).length } : null,
          };
          // Whether the human is AFK: agents take their own recommendation instead of asking.
          return send(res, 200, 'application/json', JSON.stringify({ ...shown, takeOver, cleanup, afk: afkOf(ctx), workspace }));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^t-[a-z0-9]+$/.test(id)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread?' }));
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(diffOf(ws, id)));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/lineage') {
        const id = url.searchParams.get('id') ?? '';
        if (!/^t-[a-z0-9]+$/.test(id)) return send(res, 400, 'application/json', JSON.stringify({ text: 'which thread?' }));
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          const task = ws.find(id);
          if (task?.kind !== 'task') return send(res, 404, 'application/json', JSON.stringify({ text: 'no such thread' }));
          return send(res, 200, 'application/json', JSON.stringify({ sections: lineageSections(threadLineage(ws, task)) }));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/review') {
        // A sprint's review, made when it is opened: it asks git about every thread, so the board does not carry it.
        const id = url.searchParams.get('id') ?? '';
        if (!/^r-[a-z0-9]+$/.test(id)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which sprint?' }));
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify(sprintReview(ws, id)));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/run') {
        // What the agent said on a thread's current run, or its last: `from` a line number on, so a face asks only for what is new.
        const id = url.searchParams.get('id') ?? '';
        const from = Number(url.searchParams.get('from') ?? 0);
        if (!/^t-[a-z0-9]+$/.test(id) || !Number.isInteger(from)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread, and from which line?' }));
        const ws = Workspace.open(ctx.cwd, ctx.now);
        try {
          return send(res, 200, 'application/json', JSON.stringify({ id, ...heardRun(ws.get(id, 'task').spool.dir, id, from, url.searchParams.get('run') ?? '') }));
        } finally {
          ws.close();
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/picture') {
        // A thread's picture, by the thread and the name Spool gave it. Both are checked against what is on disk.
        const ws = Workspace.open(ctx.cwd, ctx.now);
        let found: { file: string; type: string } | null = null;
        try {
          const task = ws.find(url.searchParams.get('id') ?? '');
          found = task?.kind === 'task' ? pictureFile(task, url.searchParams.get('name') ?? '') : null;
        } finally {
          ws.close();
        }
        if (!found) return send(res, 404, 'text/plain', 'no such picture');
        // A picture's name is never given twice in a thread, so the browser may keep it. Nothing kept runs:
        // text is plain text, and the policy lets nothing load or run in what is opened.
        res.writeHead(200, {
          'content-type': found.type,
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
          'content-disposition': `inline; filename="${path.basename(found.file)}"`,
        });
        return void res.end(fs.readFileSync(found.file));
      }
      if (req.method === 'POST' && url.pathname === '/api/attach') {
        if (req.headers['x-spool-token'] !== token) return send(res, 403, 'application/json', JSON.stringify({ ok: false, text: 'reload the page' }));
        return attachFrom(req, res, url);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-spool-token'] !== token) return send(res, 403, 'application/json', JSON.stringify({ ok: false, text: 'reload the page' }));
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLong = false;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 64_000) return void chunks.push(chunk);
          // Answer in words, once, and let the rest of the body drain unread.
          if (!tooLong) send(res, 413, 'application/json', JSON.stringify({ ok: false, text: 'That is too long to send: keep it under 60,000 characters.' }));
          tooLong = true;
        });
        req.on('end', () => {
          if (tooLong) return;
          let body: Body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Body;
          } catch {
            return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'not JSON' }));
          }
          const action = url.pathname.slice('/api/'.length);
          // Which project this is for: one on the workspace's own list, or the page's own where none is named.
          const ws = Workspace.open(ctx.cwd, ctx.now);
          let spool: Spool | undefined;
          let who: Who;
          let stray: string[];
          let several: boolean;
          try {
            spool = body.project === undefined ? own(ws) : named(ws, body.project);
            who = spool ? whoBuilds(ws, spool) : 'page';
            stray = spool ? strays(ws, spool, body) : [];
            several = ws.spools.length > 1 && !options.project;
          } finally {
            ws.close();
          }
          if (!spool) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which project?' }));
          if (stray.length) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: `${stray[0]} is another project's, not ${spool.name}'s` }));
          const here = inProject(ws, spool);
          if (who === 'elsewhere' && (action === 'runner' || action === 'builder' || action === 'roster')) {
            return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: `This page builds ${options.project} only. Agents for ${spool.name} are run by its own page, or a chat.` }));
          }
          // The runner is the page's own: switching it on or off, and stopping the agent it started.
          if (action === 'runner') {
            runner.on = body.on === true;
            runner.wake();
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: runner.on ? 'Agents are on: this page builds what is in Build.' : 'Agents are off.' }));
          }
          // Who builds: this page, starting the agent command, or a Claude Code chat running the loop.
          if (action === 'builder') {
            if (body.builder !== 'headless' && body.builder !== 'chat') return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'headless, or chat?' }));
            // Kept by the project's folder: each project of the page has its own pick.
            saveBuilder(ctx, spool.root, body.builder);
            const words =
              body.builder === 'chat'
                ? `A Claude Code chat builds now: say /spool-loop in one. This page starts no agents.${runner.runs.size ? ' What it had started is built to the end.' : ''}`
                : `This page builds now, headless. ${runner.on ? 'Agents are on.' : 'Switch Agents on to start.'}`;
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: words }));
          }
          // One agent's thread count, from its − and + in the header: the human's click, as spool builder --agent sets it.
          if (action === 'roster') {
            const name = text(body.agent).trim();
            const n = body.atOnce;
            if (!name || name.length > 40 || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20) {
              return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which agent, and how many threads (1 to 20)?' }));
            }
            const entry = saveAgent(ctx, spool.root, name, { atOnce: n });
            return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: `${entry.name} builds up to ${n === 1 ? '1 thread' : `${n} threads`} at once.` }));
          }
          if (action === 'cleanup') {
            // Clean Up: a pass over the backlog, by whoever builds this project. One already open is the answer.
            const result = cleanupFrom(here, spool, who, text(body.words));
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
          }
          if (action === 'move' || action === 'abort') {
            // A thread moved to any column, from any column. Abort is the move straight back to the backlog.
            const result = moveThread(here, runner, text(body.id), action === 'abort' ? 'proposed' : text(body.to), who);
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
          }
          if (action === 'order') {
            // A place in Build's line: `spool order`, after the same move to Build a drop on the column makes.
            const id = text(body.id);
            const before = text(body.before);
            const after = text(body.after);
            const spot = before ? `--before=${before}` : after ? `--after=${after}` : body.first === true ? '--first' : body.last === true ? '--last' : '';
            const ok = /^t-[a-z0-9]+$/.test(id) && spot && [before, after].every((t) => !t || /^t-[a-z0-9]+$/.test(t));
            if (!ok) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread, and where?' }));
            const moved = moveThread(here, runner, id, 'build', who);
            const result = moved.ok ? act(here, ['order', id, spot]) : moved;
            const words = result.ok ? (moved.text ? `${moved.text}. ` : '') + 'Build is in your order now.' : result.text;
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify({ ...result, text: words }));
          }
          if (action === 'stop') {
            // Stop on a thread ends that thread's agent and no other. With no thread named, every agent is stopped and agents are switched off.
            const id = text(body.id);
            if (!id && several) {
              // One project's Stop, on a page that builds several: that project's agents only, and the rest build on.
              const check = Workspace.open(ctx.cwd, ctx.now);
              let mine: string[];
              try {
                mine = [...runner.runs.keys()].filter((r) => check.find(r)?.spool.root === spool.root);
              } finally {
                check.close();
              }
              for (const r of mine) runner.stop(r);
              return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: `Stopped. What was being built in ${spool.name} is back in Build.` }));
            }
            if (!id) {
              runner.stopAll();
              return send(res, 200, 'application/json', JSON.stringify({ ok: true, text: 'Stopped. What was being built is back in Build, and agents are off.' }));
            }
            const stopped = runner.stop(id);
            const words = stopped ? 'Stopped. It waits in Build until you carry on.' : 'No agent of this page is building that thread.';
            return send(res, stopped ? 200 : 400, 'application/json', JSON.stringify({ ok: stopped, text: words }));
          }
          if (action === 'permit') {
            // The answer to an agent's question about a tool call: yes, once or for the rest of its run, or no and why.
            const how = text(body.answer);
            if (how !== 'once' && how !== 'run' && how !== 'no') return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'once, run, or no?' }));
            const result = runner.permit(text(body.id), text(body.ask), how, text(body.why));
            return send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify(result));
          }
          if (action === 'interrupt') {
            // Not a stop: the agent ends what it is doing and waits for what the human says next.
            const told = runner.interrupt(text(body.id));
            const words = told ? 'Told to stop what it is doing. It waits for your reply.' : 'No agent of this page that can be spoken to is building that thread.';
            return send(res, told ? 200 : 400, 'application/json', JSON.stringify({ ok: told, text: words }));
          }
          const result = change(here, action, body);
          // Words on a thread are answered: by the agent building it, or by the page itself, in seconds (quick.ts).
          if (action === 'note' && result.ok && result.id && result.id === text(body.id)) {
            const check = Workspace.open(ctx.cwd, ctx.now);
            let elsewhere = false;
            try {
              elsewhere = check.find(result.id)?.status === 'active';
            } finally {
              check.close();
            }
            const by = runner.heard(result.id, text(body.text), elsewhere && !runner.runs.has(result.id));
            return send(res, 200, 'application/json', JSON.stringify({ ...result, answers: by }));
          }
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
  /**
   * Clean Up, pressed. Their words, where they wrote any, are kept with the request and given as a
   * leave that allows nothing more than tidying, so the run's thread names it. Then the request is
   * left for whoever builds: a chat hears it from its watch, and this page's runner starts the pass.
   */
  const cleanupFrom = (here: Ctx, spool: Spool, who: Who, words: string): { ok: boolean; text: string; id?: string } => {
    if (who === 'elsewhere') return { ok: false, text: `This page builds ${options.project} only. Clean up ${spool.name} from its own page, or a chat.` };
    const ws = Workspace.open(here.cwd, here.now);
    let open: Item | undefined;
    // Their words become a leave only with a new request, and only where none is live: nothing renews a leave.
    let leave = false;
    try {
      // Opened in the project's own folder: its spool is the home one.
      const mine = ws.home;
      open = openRun(ws, mine);
      if (!open && !cleanupAsked(mine)) {
        leave = !!words && !settle(ws, mine).live;
        askCleanup(mine, 'human', words, ws.now());
      }
    } finally {
      ws.close();
    }
    if (open) return { ok: true, id: open.id, text: 'A clean-up is open already: here is its thread.' };
    if (leave) act(here, ['leave', '--', words]);
    if (who === 'chat') {
      const heard = watched(spool.root);
      return {
        ok: true,
        text: heard
          ? 'Asked the chat that builds: it goes through the backlog, and its proposals come here for your yes or no.'
          : 'Asked for. No chat is watching this project: say /spool-loop in one, and it runs the pass.',
      };
    }
    return runner.cleanup(here);
  };
  /**
   * A picture or a file pasted, dropped or picked on the page: the file's bytes as they are, the thread
   * and the file's own name in the query. It is the one POST that is not JSON, and the one allowed more
   * than 64,000 bytes. It is written to a file of that name (made safe) and handed to `spool attach`, as
   * a person would, so it is held to the same rules.
   */
  const attachFrom = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLong = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BYTES) return void chunks.push(chunk);
      if (!tooLong) send(res, 413, 'application/json', JSON.stringify({ ok: false, text: `That file is too big: keep it under ${MAX_BYTES / 1024 / 1024} MB.` }));
      tooLong = true;
    });
    req.on('end', () => {
      if (tooLong) return;
      const id = url.searchParams.get('id') ?? '';
      if (!/^t-[a-z0-9]+$/.test(id)) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which thread?' }));
      const ws = Workspace.open(ctx.cwd, ctx.now);
      let spool: Spool | undefined;
      let stray: string[];
      try {
        const asked = url.searchParams.get('project');
        spool = asked === null ? own(ws) : named(ws, asked);
        stray = spool ? strays(ws, spool, { id }) : [];
      } finally {
        ws.close();
      }
      if (!spool) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: 'which project?' }));
      if (stray.length) return send(res, 400, 'application/json', JSON.stringify({ ok: false, text: `${id} is another project's, not ${spool.name}'s` }));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-picture-'));
      try {
        // Only the name's last part, in plain characters: it names the file, and never reaches past the folder.
        const given = (url.searchParams.get('name') ?? '').replace(/^.*[\\/]/, '').replace(/[^\w. -]+/g, '').replace(/^[.\s]+/, '').slice(-80);
        const shown = given || 'pasted';
        const file = path.join(dir, shown);
        fs.writeFileSync(file, Buffer.concat(chunks));
        const result = act(inProject(ws, spool), ['attach', id, file]);
        const text = result.ok ? '' : result.text.replace(/^pasted /, 'That ');
        send(res, result.ok ? 200 : 400, 'application/json', JSON.stringify({ ok: result.ok, text }));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  };
  // Once, however many ports were tried first.
  server.once('listening', () => ready({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server, token }));
  const listen = (port: number, triesLeft: number): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // The usual port is taken, by another project's page perhaps: take the next one.
      if (error.code === 'EADDRINUSE' && triesLeft > 0 && !options.port) listen(port + 1, triesLeft - 1);
      // A page taking over keeps the address the open page already has: wait for the last one to let go of it.
      else if (error.code === 'EADDRINUSE' && triesLeft > 0 && options.resumed) setTimeout(() => listen(port, triesLeft - 1), 150);
      else {
        ctx.err(`spool: the page could not start: ${error.message}`);
        // With no page there is nothing to stay up for, and nothing should go on building: end the process once the message is out.
        runner.close();
        process.exitCode = 1;
        process.stderr.write('', () => process.exit(1));
      }
    });
    server.listen(port, '127.0.0.1');
  };
  listen(options.port ?? 4747, 20);
  // The server's own close comes later than a process that is exiting: put the thread back on the way out too.
  const leaving = (): void => runner.close();
  process.once('exit', leaving);
  server.on('close', () => {
    process.off('exit', leaving);
    runner.close();
    upkeep.close();
  });
  return server;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * How a page that was started by another says, as it ends: start me again, on the code now on
 * disk. The exit code also says whether its agents were on, since nothing else is sure to arrive.
 */
const RESTART = { on: 75, off: 76 } as const;

/** What a restarting page handed over, read from wherever it arrived; nothing unless it is whole. */
function resumeOf(value: unknown): Resume | undefined {
  try {
    const given = (typeof value === 'string' ? JSON.parse(value) : value) as { port?: unknown; run?: unknown } | null;
    if (given && typeof given.port === 'number' && Number.isInteger(given.port) && given.port > 0 && given.port < 65536) {
      return { port: given.port, run: given.run === true };
    }
  } catch {
    // Not what a page writes: there is nothing to take over.
  }
  return undefined;
}

/**
 * Stay up as the process the terminal, or the harness, started, and run the page in a child of
 * it. A process cannot load its own code a second time, so a page moves onto a new build by
 * ending and being started again; this is what starts it again, at the same address and with
 * agents as they were. Stopping this process stops the page, as it always did.
 */
function keepPage(ctx: Ctx, page: { project?: string; agent?: string }, first: Resume): void {
  const argv = [
    ...process.execArgv,
    path.join(CODE_DIR, `cli${CODE_EXT}`),
    'page',
    '--no-open',
    ...(page.project ? ['--project', page.project] : []),
    ...(page.agent ? ['--agent', page.agent] : []),
  ];
  let child: ChildProcess | undefined;
  let leaving = false;
  const start = (resume: Resume): void => {
    const started = spawn(process.execPath, argv, {
      cwd: ctx.cwd,
      // The terminal, and a channel: the page knows by the channel closing that this process has died.
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...ctx.env, SPOOL_PAGE_RESUME: JSON.stringify(resume) },
    });
    child = started;
    started.on('error', (error) => {
      ctx.err(`spool: the page could not be started again: ${error.message}`);
      process.exit(1);
    });
    started.on('exit', (code, signal) => {
      if (!leaving && (code === RESTART.on || code === RESTART.off)) start({ port: first.port, run: code === RESTART.on });
      else process.exit(code ?? (signal ? 1 : 0));
    });
  };
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      // Told to stop: the page is told the same, and puts back what it was building before both go.
      leaving = true;
      const running = child;
      if (running && running.exitCode === null && running.signalCode === null) {
        running.kill(signal);
        setTimeout(() => {
          running.kill('SIGKILL');
          process.exit(0);
        }, 5000).unref();
      } else process.exit(0);
    });
  }
  start(first);
}

function openUrl(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** `spool page`: start the server, say where it is, and open it. The process stays up until it is stopped. */
export function servePage({ ctx, opts }: Bare): Result {
  // A page that restarted onto new code says where the one before it was, and whether its agents were on.
  const resumed = resumeOf(ctx.env.SPOOL_PAGE_RESUME);
  const port = resumed ? resumed.port : opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new SpoolError('--port must be a port number');
  const project = typeof opts.project === 'string' ? opts.project : undefined;
  // Fail now, in words, where there is no spool or no such project.
  const ws = Workspace.open(ctx.cwd, ctx.now);
  let root: string;
  let roots: string[];
  try {
    board(ws, project);
    root = (project ? ws.project(project) : ws.home).root;
    roots = servedBy(ws, project);
  } finally {
    ws.close();
  }
  const chatBuilds = builderOf(ctx, root) === 'chat';
  const run = resumed ? resumed.run : !!opts.run;
  const agent = typeof opts.agent === 'string' ? opts.agent : undefined;
  if (opts.status) return pageStatus(ctx, root);
  if (opts.stop) return stopPage(ctx, root);
  // One page to a project: a second start points at the first instead of taking the next port.
  // Asked for a port of its own, it is given one: something is counting on that address (a preview pane, a test).
  const there = resumed ? undefined : pageUp(ctx, root);
  const up = there && (port === undefined || new URL(there.url).port === String(port)) ? there : undefined;
  if (up) {
    if (!opts['no-open'] && !opts.detach) openUrl(up.url);
    return { text: [`The Spool page is already up for this project: ${up.url}`, ...startedAbove(up, root)].join('\n') };
  }
  if (opts.detach) {
    const args = [...(port ? ['--port', String(port)] : []), ...(run ? ['--run'] : []), ...(agent ? ['--agent', agent] : []), ...(project ? ['--project', project] : [])];
    return detachPage(ctx, root, path.join(CODE_DIR, `cli${CODE_EXT}`), args);
  }
  // Started by a page that is staying up to restart this one: it is told how, and this one ends if it does.
  const kept = !!resumed && typeof process.send === 'function';
  // The process a terminal or `-d` started is the one to signal: a kept page is its child.
  const owner = kept ? process.ppid : process.pid;
  let handing = false;
  process.once('exit', () => handing || forgetPage(ctx, root, owner));
  // Ctrl-C, or closing the terminal, ends the page and the agent it started with it.
  const stop = (): void => {
    server.close();
    process.exit(0);
  };
  const restart = (resume: Resume): void => {
    // Started by a page that stayed up for this: ending this way is asking it to start the next.
    handing = kept;
    if (kept) process.exit(resume.run ? RESTART.on : RESTART.off);
    // The first restart. This process stays, since it is the one the terminal holds, and the page runs in a child from here on.
    for (const signal of SIGNALS) process.off(signal, stop);
    server.close();
    server.closeAllConnections();
    keepPage(ctx, { project, agent }, resume);
  };
  // What tells a page it is taking over is for that page alone, not for the agents it starts.
  const own: Ctx = { ...ctx, env: { ...ctx.env, SPOOL_PAGE_RESUME: undefined, SPOOL_PAGE_DETACHED: undefined } };
  // The record, once the page is listening. Kept here, so a project set up below later is added to it.
  let record: PageRecord | undefined;
  const serves = (now: string[]): void => {
    if (!record || now.join('\n') === roots.join('\n')) return;
    roots = now;
    record = { ...record, roots };
    rememberPage(ctx, record);
  };
  const server = startPage(own, { port, project, run, agent, resumed: !!resumed, restart, serves }, ({ url, token }) => {
    const before = resumed ? pageUp(ctx, root) : undefined;
    const since = before?.pid === owner ? before.since : ctx.now().toISOString();
    record = { pid: owner, url, root, roots, project, since, run, detached: ctx.env.SPOOL_PAGE_DETACHED === '1', token };
    rememberPage(ctx, record);
    if (resumed) {
      ctx.out(`Restarted on the new build: ${url}`);
      return;
    }
    ctx.out(`Spool page: ${url}`);
    if (run) ctx.out(chatBuilds ? 'A chat builds here, as picked on the page: this page starts no agents until that is set back to Headless.' : 'Agents are on: this page builds what is in Build, with no chat open.');
    ctx.out('Leave this running while you use the page. Ctrl-C stops it.');
    if (!opts['no-open']) openUrl(url);
  });
  for (const signal of SIGNALS) process.once(signal, stop);
  if (kept) process.once('disconnect', stop);
  return { text: '' };
}
