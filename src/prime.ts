/**
 * Priming: what an agent is told before it works.
 *
 * Spool has two roles. A recorder listens to the human and files what they
 * say. A worker takes tasks off the queue and does them. The rules for both
 * are written once, in the skills Spool ships (`skills/spool-recorder` and
 * `skills/spool-loop`), and an agent whose harness loads skills has them
 * already. What a skill cannot hold is what is true of this project right
 * now: its autonomy policy, its projects, what is waiting. `spool prime
 * <role> --context` prints that, and the skills run it first.
 *
 * Without `--context` the rules are printed too, read from those same skill
 * files. That is for agents with no skills: any harness that can run a
 * command, and the ones `spool loop` starts unattended.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { rules, section } from './builtin.ts';
import { type Spool, oneLine } from './model.ts';
import { ready, review, tasks, taskState } from './schedule.ts';
import type { Workspace } from './store.ts';

export type Role = 'worker' | 'recorder';

const WORKER = `# Spool · worker protocol

Spool is this project's work queue. The human drops feedback in; agents turn it
into tasks, work them, and go back to the human only for calls that are theirs
to make. State is markdown in .spool/. Use the \`spool\` CLI; never edit it by hand.

\`spool next --claim\` hands you the task to do now, with all its context.
`;

const RECORDER = `# Spool · recorder protocol

You are the recorder. The human talks, usually dictating, often while using the
thing, sometimes from a phone, and you make sure every idea lands in the right
place in the queue. You do not do the work; workers do. Stay in this role until
told otherwise, and treat each message as something to record unless it is
plainly a question or an instruction to you. Use the \`spool\` CLI; never edit
.spool/ by hand.
`;

export const DEFAULT_POLICY = `# Autonomy policy

How much rope agents get in this project. They read this through \`spool prime\`
before they work. Edit it freely — it is yours.

## Go ahead and assume

Decide, keep working, and record it with \`spool assume\`:

- Anything one \`spool revert\` undoes: visual tweaks, copy, tuning numbers, refactors, small fixes.
- Choices the feedback already points to.
- Carrying out a plan whose parts are each easy to undo.

## Ask first

Stop that task and use \`spool ask\`, with options and a recommendation:

- Spending money, publishing, releasing, or sending anything outside this repo.
- Deleting data, or anything a revert cannot bring back.
- New dependencies, accounts or services.
- Changing what the product is: scope, audience, pricing, name.
- Starting on a plan that sets a new direction or commits to more than a few days of work:
  hold its parts for a go-ahead (\`--needs <plan>\`).
- Questions of taste where two good answers exist and nothing said so far picks one.

## Never

- Answer your own question, or approve your own assumption or plan.
- Push, deploy or release unless a task says to in the human's own words.
`;

const BLOCK_START = '<!-- spool:start -->';
const BLOCK_END = '<!-- spool:end -->';

const BLOCK = `${BLOCK_START}
## Spool

This project's work queue lives in \`.spool/\`. The human drives it by talking to you, through the
Spool skills (\`/spool-help\` lists them). The \`spool\` CLI is your tool for it: never edit those
files by hand, and never ask the human to run a command you can run.

- The human gives feedback, an idea or a bug, even in passing: \`spool capture "<their exact words>"\`,
  then file it with \`spool task "<title>" --from <note-id>\`. The \`spool-recorder\` skill has the rules.
- Asked to do some work: \`spool status\` first. If it is already a task, \`spool start <id>\`, and
  work it by the rules in the \`spool-loop\` skill, so the work is on record and can be undone.
- No skills in your harness? \`spool prime\` prints the worker's rules, \`spool prime recorder\` the recorder's.
${BLOCK_END}`;

/** Insert or refresh Spool's block in an agent instructions file, leaving the rest alone. */
export function upsertBlock(existing: string): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return existing.slice(0, start) + BLOCK + existing.slice(end + BLOCK_END.length);
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${BLOCK}\n`;
}

/** One line on what a project is: its config, or failing that the top of its README. */
export function about(spool: Spool): string {
  if (spool.config.about) return oneLine(spool.config.about, 100);
  try {
    const readme = fs.readFileSync(path.join(spool.root, 'README.md'), 'utf8');
    const line = readme.split('\n').find((l) => /^[A-Za-z*_`]/.test(l.trim()));
    if (line) return oneLine(line.replace(/[*_`]/g, ''), 100);
    const heading = /^#\s+(.+)$/m.exec(readme);
    if (heading) return oneLine(heading[1]!, 100);
  } catch {
    // No README: the name will have to do.
  }
  return '';
}

/** The recorder's routing table: where things can go, and what is already waiting. */
function map(ws: Workspace): string {
  const lines: string[] = ['PROJECTS'];
  const width = Math.max(...ws.spools.map((s) => s.name.length));
  for (const spool of ws.spools) {
    const open = tasks(ws).filter((t) => t.spool === spool && !['done', 'dropped'].includes(taskState(ws, t)));
    const what = about(spool);
    lines.push(`  ${spool.name.padEnd(width)}  ${open.length} open${what ? `  · ${what}` : ''}`);
  }
  const queue = review(ws);
  if (queue.questions.length) {
    lines.push('', 'WAITING ON THE HUMAN');
    for (const d of queue.questions) {
      const options = d.options.map((o, i) => `${i + 1}) ${o}`).join('  ');
      lines.push(`  ${d.id}  ${oneLine(d.title, 90)}${options ? `\n          ${options}` : ''}`);
    }
  }
  if (queue.inbox.length) lines.push('', `INBOX  ${queue.inbox.length} unfiled — spool inbox`);
  return lines.join('\n');
}

/**
 * What a role needs before it starts. With `contextOnly`, just what is true of
 * this project now, for an agent that already has the rules from a skill.
 */
export function prime(ws: Workspace, role: Role, contextOnly = false): string {
  const parts: string[] = [];
  if (role === 'recorder') {
    if (!contextOnly) parts.push(RECORDER, `${rules('spool-recorder')}\n`);
    parts.push(`${map(ws)}\n`);
    return parts.join('\n');
  }
  if (!contextOnly) parts.push(WORKER, `${section('spool-loop', 'Working a task')}\n`);
  const policy = path.join(ws.home.dir, 'policy.md');
  const text = fs.existsSync(policy) ? fs.readFileSync(policy, 'utf8').trim() : DEFAULT_POLICY.trim();
  parts.push(`POLICY (${path.relative(ws.home.root, policy) || policy})\n\n${text}\n`);
  const others = ws.spools.filter((s) => !s.home && fs.existsSync(path.join(s.dir, 'policy.md')));
  if (others.length) {
    parts.push(
      `Each project has its own policy; read it before working there:\n${others
        .map((s) => `  ${path.join(s.name, '.spool', 'policy.md')}`)
        .join('\n')}\n`,
    );
  }
  const queue = review(ws);
  parts.push(`NOW  ${ready(ws).length} ready · ${queue.questions.length} waiting on the human · ${queue.inbox.length} unfiled`);
  return parts.join('\n');
}
