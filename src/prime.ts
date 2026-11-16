/**
 * Priming: what an agent is told before it works.
 *
 * Spool has two roles. A recorder files one thing the human said, when they
 * ask for it to be recorded. A worker takes tasks off the queue and does them. Each role's rules
 * are written once, in a file Spool ships: the recorder's are the record
 * skill (`skills/spool-record`), the worker's are `rules/worker.md`, which no
 * skill repeats. What neither can hold is what is true of this project right
 * now: its autonomy policy, its projects, what is waiting. `spool prime
 * <role> --context` prints that, and the skills run it first.
 *
 * Without `--context` the rules are printed too, read from those same files.
 * That is how everyone who builds gets the worker's rules: a chat running the
 * loop, the subagents it starts, any harness that can run a command, and the
 * agents the page and `spool loop` start unattended.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { rules, workerRules } from './builtin.ts';
import { goalsFile, goalsOf, goalsText } from './goals.ts';
import { lessonsSection, withoutLessons } from './lessons.ts';
import { sprintAbout } from './sprints.ts';
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

You record what the human said into the queue: one message at a time, the one
they asked you to record. They say what they want added, and where; you make
sure every idea in it lands in the right place. You do not do the work;
workers do. Recording one message does not make the rest of the conversation
yours to record. Use the \`spool\` CLI; never edit .spool/ by hand.
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
Spool skills: \`/spool-init\`, \`/spool\`, \`/spool-loop\` and \`/spool-record\`. The \`spool\` CLI is your tool for it: never edit those
files by hand, and never ask the human to run a command you can run.

- The human gives an idea, a wish, feedback or a bug about the project, even in passing:
  \`spool capture "<their exact words>"\`, then file it with \`spool task "<title>" --from <note-id>\`.
  The \`spool-record\` skill has the rules.
- Not everything they say is a note. An instruction to you about the work ("work the backlog
  until midnight", "use subagents") is done, not recorded. A go, a no or a choice is a verb:
  \`spool build\`, \`spool propose\`, \`spool answer\`. In a long message, capture each idea on its own
  and act on the rest. Not sure whether it is an idea or an instruction? Record nothing and act.
- Asked to do some work: \`spool status\` first. If it is already a task, \`spool start <id>\`, and
  work it by the worker's rules (\`spool prime worker\`), so the work is on record and can be undone.
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
    const open = tasks(ws).filter((t) => t.spool === spool && !['done', 'dropped', 'archived'].includes(taskState(ws, t)));
    const what = about(spool);
    lines.push(`  ${spool.name.padEnd(width)}  ${open.length} open${what ? `  · ${what}` : ''}`);
  }
  // The plan a new thread may belong to: each sprint not yet reached, the one being played first, with what it is for.
  const rank = (s: { status: string }) => (s.status === 'running' ? 0 : 1);
  const sprints = ws.items
    .filter((i) => i.kind === 'sprint' && (i.status === 'planned' || i.status === 'running'))
    .sort((a, b) => rank(a) - rank(b) || a.created.localeCompare(b.created));
  if (sprints.length) {
    lines.push('', 'SPRINTS  a thread that serves one goes in it: --sprint <name>');
    for (const s of sprints) {
      const { goal, serves } = sprintAbout(s);
      const facts = [s.status === 'running' ? 'being played' : 'planned', ...(serves ? [`serves ${oneLine(serves, 50)}`] : []), ...(ws.spools.length > 1 ? [s.spool.name] : [])];
      lines.push(`  ${s.id}  ${oneLine(s.title, 40)} · ${facts.join(' · ')}${goal ? ` — ${oneLine(goal, 90)}` : ''}`);
    }
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
    if (!contextOnly) parts.push(RECORDER, `${rules('spool-record')}\n`);
    parts.push(`${map(ws)}\n`);
    return parts.join('\n');
  }
  if (!contextOnly) parts.push(WORKER, `${workerRules()}\n`);
  // Where the project is going comes first: the policy says how to work, the goals say what for.
  if (goalsOf(ws.home)) parts.push(`GOALS (${path.relative(ws.home.root, goalsFile(ws.home))})\n\n${goalsText(ws.home)}\n`);
  const policy = path.join(ws.home.dir, 'policy.md');
  const text = fs.existsSync(policy) ? fs.readFileSync(policy, 'utf8').trim() : DEFAULT_POLICY.trim();
  parts.push(`POLICY (${path.relative(ws.home.root, policy) || policy})\n\n${withoutLessons(text)}\n`);
  // What the human undid, and why: kept in the policy files, printed on its own, newest first.
  const undone = lessonsSection(ws);
  if (undone) parts.push(undone);
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
