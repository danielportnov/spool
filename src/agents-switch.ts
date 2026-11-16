/**
 * `spool agents [on | off]`: the page's Agents switch, from a chat or a terminal.
 *
 * It presses the same switch the button on the page does (`POST /api/runner`), so the page says
 * what happened in its own words. Every change to the page needs its token, which the page keeps
 * in its record on this machine (src/detach.ts), readable by this user only: that is how a command
 * here gets in while another website open in the browser still cannot.
 */

import { type Ctx, builderOf } from './context.ts';
import { pageUp } from './detach.ts';
import { SpoolError } from './model.ts';
import { askPage } from './standing.ts';

export interface AgentsResult {
  text: string;
  data: { project: string; page: string | null; builder: string; on: boolean | null };
}

const NO_PAGE = 'No Spool page is up for this project. spool page -d --run starts one with agents on.';

/**
 * `word` is on, off, or nothing to only say. `guard` is the lock: it throws where the project's
 * gate leaves starting work to the human, and is asked only for `on`. Stopping is always safe.
 */
export function agentsCommand(ctx: Ctx, project: { name: string; root: string }, word: string | undefined, guard: () => void): AgentsResult {
  if (word !== undefined && word !== 'on' && word !== 'off') {
    throw new SpoolError(`"${word}" is not on or off`, 'spool agents on, spool agents off, or spool agents alone to see');
  }
  const builder = builderOf(ctx, project.root);
  const data = (page: string | null, on: boolean | null): AgentsResult['data'] => ({ project: project.name, page, builder, on });
  if (word === 'on') {
    guard();
    if (builder === 'chat') {
      throw new SpoolError(`a chat builds ${project.name}, so the page starts no agents`, 'Have the page build first: spool builder headless');
    }
  }
  const up = pageUp(ctx, project.root);
  if (!up) {
    if (word === 'on') throw new SpoolError('no Spool page is up for this project', 'spool page -d --run starts one with agents on');
    return { text: NO_PAGE, data: data(null, null) };
  }

  if (word === undefined) {
    const runner = (askPage(up.url, 'api/board')?.body as { runner?: { on?: unknown } } | undefined)?.runner;
    if (!runner) return { text: `The Spool page at ${up.url} is not answering just now.`, data: data(up.url, null) };
    const on = runner.on === true;
    const chat = builder === 'chat' ? ' A chat builds here (Chat), so the page starts none either way.' : '';
    return { text: `The page at ${up.url} has its agents ${on ? 'on' : 'off'}.${chat}`, data: data(up.url, on) };
  }

  if (!up.token) {
    throw new SpoolError('the page that is up was started by an older Spool, and keeps no token for this', 'Use the Agents switch on the page, or start it again: spool page --stop, then spool page -d');
  }
  const on = word === 'on';
  const said = askPage(up.url, 'api/runner', { token: up.token, body: { on } });
  if (!said) throw new SpoolError(`the Spool page at ${up.url} is not answering`, 'Try again in a moment, or use the Agents switch on the page');
  const reply = said.body as { ok?: boolean; text?: string } | string;
  const words = typeof reply === 'string' ? reply : (reply.text ?? '');
  if (said.status !== 200) throw new SpoolError(`the page refused: ${words || `status ${said.status}`}`);
  return { text: words, data: data(up.url, on) };
}
