/**
 * Where a project's board stands, for `spool status`: whether a page is up and where, who builds,
 * and, when Build has work in it and nothing is being built, the reason why, in one line.
 *
 * Most of it is on this machine already: the page's record (src/detach.ts), the Headless | Chat
 * pick, and the files a `spool watch` leaves. Whether the page's agents are on is known only to
 * the page, so it is asked. With no page up, nothing is asked and nothing waits.
 */

import { spawnSync } from 'node:child_process';
import { type Builder, type Ctx, builderOf } from './context.ts';
import { pageUp } from './detach.ts';
import { type Item, type Spool, oneLine } from './model.ts';
import { stoppedInBuild } from './page.ts';
import { blockers, buildLine, taskState, tasks } from './schedule.ts';
import type { Workspace } from './store.ts';
import { watched } from './watch.ts';
import { landingState, landingWords } from './worktree.ts';
import { type AgentView, rosterLine, rosterView } from './roster.ts';

/** How long a page has to answer before it is said not to be. */
export const ANSWER_MS = 2000;

/**
 * The request a page is asked, made in a process of its own and waited for. `spool status` is a
 * plain command that answers at once, over `--json` and `spool mcp` too, and both of those take
 * what it says when it returns: an answer printed later would be lost there. What to send comes
 * on stdin, so the token never shows in a list of processes.
 */
const ASK = `let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', async () => {
  const { url, method, token, body, ms } = JSON.parse(input);
  try {
    const headers = token ? { 'content-type': 'application/json', 'x-spool-token': token } : {};
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(ms) });
    process.stdout.write(JSON.stringify({ status: res.status, text: await res.text() }));
  } catch {
    process.exitCode = 1;
  }
});`;

/** Ask the page at `url` for `where`, and wait for it; undefined if it does not answer in time. */
export function askPage(url: string, where: string, send?: { token: string; body: unknown }): { status: number; body: unknown } | undefined {
  const request = { url: new URL(where, url).href, method: send ? 'POST' : 'GET', token: send?.token, body: send ? JSON.stringify(send.body) : undefined, ms: ANSWER_MS };
  // Nothing of the caller's environment: a NODE_OPTIONS or a proxy meant for something else has no business here.
  const ran = spawnSync(process.execPath, ['-e', ASK], { input: JSON.stringify(request), encoding: 'utf8', timeout: ANSWER_MS + 2000, env: {} });
  if (ran.status !== 0 || !ran.stdout) return undefined;
  try {
    const { status, text } = JSON.parse(ran.stdout) as { status: number; text: string };
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: the words as they came.
    }
    return { status, body };
  } catch {
    return undefined;
  }
}

export interface Standing {
  /** The page's address, or null with no page up. */
  page: string | null;
  /** Whether the page answered; null with no page to ask. */
  answering: boolean | null;
  builder: Builder;
  /** Whether the page's agents are on; null where that is not known (no page, or not answering). */
  agents: boolean | null;
  /** Threads being built right now. */
  building: number;
  /** With a chat building: whether a `spool watch` is up for this project. */
  watching: boolean | null;
  /** With a chat building: each agent on the roster, its count, whether it is watching, and what it is building. */
  roster?: AgentView[];
  /** Why nothing in Build is moving, where it has work and none is being built. */
  stuck: string | null;
  /** A thread landing now, and any waiting behind it and for how long, in a sentence; null when nothing is landing. */
  landing?: string | null;
}

/** The first thing a thread in Build waits on, in a few words. */
function waitsOn(ws: Workspace, task: Item): string {
  const first = blockers(ws, task)[0];
  if (!first) return '';
  return `${first.kind === 'decision' ? 'your answer to ' : ''}${first.id} “${oneLine(first.title, 60)}”`;
}

export function standingOf(ctx: Ctx, ws: Workspace, spool: Spool): Standing {
  const builder = builderOf(ctx, spool.root);
  const up = pageUp(ctx, spool.root);
  const board = up ? askPage(up.url, 'api/board') : undefined;
  const runner = (board?.body as { runner?: { on?: unknown } } | undefined)?.runner;
  const answering = up ? !!runner : null;
  const agents = runner ? runner.on === true : null;
  const building = tasks(ws, spool).filter((t) => taskState(ws, t) === 'active').length;
  const watching = builder === 'chat' ? watched(spool.root) : null;

  let stuck: string | null = null;
  const line = buildLine(ws, spool);
  if (line.length && !building) {
    const blocked = line.filter((t) => taskState(ws, t) === 'blocked');
    // With a chat building, a stopped thread is taken like any other.
    const stopped = builder === 'chat' ? [] : line.filter((t) => taskState(ws, t) !== 'blocked' && stoppedInBuild(t));
    if (builder === 'headless' && !up) stuck = 'no page is up to build it. spool page -d --run starts one with agents on.';
    else if (builder === 'headless' && !answering) stuck = `the page at ${up!.url} is not answering.`;
    else if (builder === 'headless' && !agents) stuck = 'the page’s agents are off. spool agents on, or the Agents switch on the page, starts them.';
    else if (builder === 'chat' && !watching) stuck = 'a chat builds here, but none is watching. Say /spool-loop in a Claude Code chat in this project, or spool builder headless.';
    else if (blocked.length === line.length) stuck = `every thread in it is waiting. The first, ${blocked[0]!.id}, waits on ${waitsOn(ws, blocked[0]!)}.`;
    else if (blocked.length + stopped.length === line.length) stuck = `every thread in it was stopped. Carry on with one from its card on the page: ${stopped[0]!.id} “${oneLine(stopped[0]!.title, 60)}”.`;
  }
  const roster = builder === 'chat' ? { roster: rosterView(ctx, ws, spool) } : {};
  return { page: up?.url ?? null, answering, builder, agents, building, watching, stuck, landing: landingWords(landingState(spool.root)) ?? null, ...roster };
}

/** The lines `spool status` prints under a project's count. */
export function standingLines(s: Standing): string[] {
  const where = !s.page ? 'not up (spool page -d starts it)' : s.answering ? s.page : `${s.page}, not answering`;
  let who: string;
  if (s.builder === 'chat') who = s.watching ? 'a chat builds, and one is watching' : 'a chat builds, but none is watching';
  else who = `the page builds (Headless)${s.agents === null ? '' : s.agents ? ', agents on' : ', agents off'}`;
  const building = s.building ? `, ${s.building} building` : '';
  const roster = s.roster?.length ? [`Agents: ${rosterLine(s.roster)}`] : [];
  return [`Board: ${where} · ${who}${building}`, ...roster, ...(s.stuck ? [`Build is not moving: ${s.stuck}`] : []), ...(s.landing ? [`Landing: ${s.landing}`] : [])];
}
