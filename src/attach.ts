/**
 * `spool attach`: a picture or a file kept with a thread (pictures.ts). The page's paste and drop run it
 * too, with what was pasted written to a file first, so a picture from the page is held to the
 * same rules as one from the command line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from './commands.ts';
import { signAs } from './agent.ts';
import { SpoolError } from './model.ts';
import { type As, MAX_BYTES, attach, tooBig } from './pictures.ts';

export const ATTACH: Command = {
  name: 'attach',
  group: 'agents',
  usage: 'attach <t-id> <file…> [--as before|after] [--by <your name>] [-m "<caption>"]',
  summary: 'Keep a picture or a file (PDF, text) with a thread: what you mean, or the before and after of a change you can see. Its agent finds the path in its brief',
  write: true,
  options: { as: { type: 'string' }, by: { type: 'string' }, message: { type: 'string', short: 'm' } },
  run(call) {
    const ref = call.args[0];
    if (!ref) throw new SpoolError('which thread?', 'spool attach <t-id> <file…>');
    const task = call.ws.get(ref, 'task');
    // --as is every command's "act as" too. Here before and after say which side of the change a
    // picture shows; any other word is who attaches it, as it is everywhere else.
    const side = call.opts.as === 'before' || call.opts.as === 'after' ? call.opts.as : '';
    const files = call.args.slice(1).map((given) => {
      const full = path.resolve(call.ctx.cwd, given);
      const shown = path.basename(given);
      let size: number;
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) throw new Error('not a file');
        size = stat.size;
      } catch {
        throw new SpoolError(`there is no file ${given}`, 'Name a picture or a file on this machine: spool attach <t-id> shot.png');
      }
      // Too big is said before the whole of it is read.
      if (size > MAX_BYTES) throw tooBig(shown, size);
      return { bytes: fs.readFileSync(full), shown };
    });
    const caption = typeof call.opts.message === 'string' ? call.opts.message : '';
    // With --as taken for the side, who attached it is --by, or the environment's word, or the one who claimed the thread.
    const by = typeof call.opts.by === 'string' && call.opts.by.trim() ? call.opts.by.trim() : call.ctx.env.SPOOL_ACTOR;
    const actor = side || by ? signAs(by, task.status === 'active' ? task.by : undefined, 'agent') : call.actor;
    const added = attach(task, files, (side || null) as As | null, caption, actor, call.ws.now());
    call.ws.save(task);
    const lines = [`Attached to ${task.id}:`, ...added.map((p) => `  ${p.path}`)];
    return { text: lines.join('\n'), data: { id: task.id, pictures: added } };
  },
};
