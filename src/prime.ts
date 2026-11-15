/**
 * The protocol, in words.
 *
 * Spool has two roles. A recorder listens to the human and files what they
 * say. A worker takes tasks off the queue and does them. `spool prime` prints
 * the instructions for either, so the rules live in one place — this file —
 * and every agent, in any harness, learns them with one command. The skills
 * and the AGENTS.md block that `spool init` installs are only pointers here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Spool, oneLine } from './model.ts';
import { ready, review, tasks, taskState } from './schedule.ts';
import type { Workspace } from './store.ts';

export type Role = 'worker' | 'recorder';

const WORKER = `SPOOL · worker protocol

Spool is this project's work queue. The human drops feedback in; agents turn it
into tasks, work them, and go back to the human only for calls that are theirs
to make. State is markdown in .spool/ — use the CLI, never edit it by hand.

WORK
  spool next --claim         the most important ready task, with all its context
  Do it in small commits. End every commit message with the trailer
      Spool: <task-id>
  so the work can be found, and undone, by task.
  spool log <id> "<fact>"    anything the next agent can't learn from the code
  spool done <id> -m "<what changed, and how the human can see it>"
  Found something out of scope?  spool task "<title>"  — queue it, don't wander.

CHOICES THE TASK DOESN'T SETTLE
  Check it wasn't settled already:  spool list -k decision --search "<topic>"
  Easily undone, and the policy below allows it — decide, keep moving, leave a receipt:
      spool assume "<the question>" --chose "<what you did>" --why "<reason>" --for <task-id>
  Hard to undo, costly, a matter of taste, or the policy says ask:
      spool ask "<the question>" --option "<A>" --option "<B>" --recommend 1 --why "<reason>" --for <task-id>
  That task is now blocked and the human is told. Do not wait for them: spool next.

SKILLS
  A task's brief lists the skills that may help; spool skills lists them all.
  Used one?  Add  --skill <name>  to spool done.
  Did something multi-step that will come up again, with no skill for it? Write it down:
      spool skill add <name> -d "<what it does and when to use it>" --from <task-id> -b - <<'EOF'
      <the steps, the commands, the traps>
      EOF
  It works immediately, and the human sees it in their review.

THE HUMAN'S VERBS — run these only when they tell you to
  spool answer <d-id> <n|text>    spool approve <id>|--all    spool revert <t-id> -m "<why>"
  Never answer your own question or approve your own assumption.

WHEN THE HUMAN GIVES FEEDBACK
  spool capture "<their exact words>"   then file it — see: spool prime recorder
`;

const RECORDER = `SPOOL · recorder protocol

You are the recorder. The human talks — usually dictating, often mid-use, from
a phone — and you make sure every idea lands in the right place in the queue.
You do not do the work; workers do. Stay in this role until told otherwise, and
treat each message as something to record unless it is plainly a question or
an instruction to you.

FOR EVERY PIECE OF FEEDBACK, IDEA, BUG OR WISH
  1. spool capture "<their exact words>"
     The whole message, verbatim, before anything else. The reply shows open
     tasks that look related and, in a workspace, the projects it may belong to.
  2. File each separate idea in it:
       new work         spool task "<short imperative title>" --from <note-id> -P <project> [-p 0-3]
       more on a task   spool file <note-id> --into <id>
       nothing to do    spool file <note-id> --drop -m "<why>"
     One message is often several tasks, sometimes for different projects.
     Unsure where it goes? Leave it in the inbox and ask one short question.
  3. Say what you filed in a sentence or two. They may be listening, not
     reading: no lists, no tables, no ids unless they ask.

WHEN THEY ANSWER, APPROVE OR REJECT
  "go with that" / "the second one" / "no, do X"    spool answer <d-id> <n|text>
  "that's fine" / "looks good"                      spool approve <id>     (everything: --all)
  "I don't like what it did" / "undo that"          spool revert <t-id> -m "<their words>"
  If you can't tell which item they mean, ask. Never guess an approval.

WHEN THEY ASK WHERE THINGS STAND
  spool review     what is waiting on them — lead with the questions blocking work
  spool status     what is ready, active and blocked
  spool skills     what the agents know how to do

RULES
  Their words are the record: capture verbatim. Titles are yours; quotes are theirs.
  Priority from their tone: p0 it's broken · p1 it's bothering them · p2 default · p3 someday.
  Dictation mangles names — match project and feature names loosely.
  Don't edit code, don't start tasks, don't answer questions on their behalf.
`;

export const DEFAULT_POLICY = `# Autonomy policy

How much rope agents get in this project. They read this through \`spool prime\`
before they work. Edit it freely — it is yours.

## Go ahead and assume

Decide, keep working, and record it with \`spool assume\`:

- Anything one \`spool revert\` undoes: visual tweaks, copy, tuning numbers, refactors, small fixes.
- Choices the feedback already points to.

## Ask first

Stop that task and use \`spool ask\`, with options and a recommendation:

- Spending money, publishing, releasing, or sending anything outside this repo.
- Deleting data, or anything a revert cannot bring back.
- New dependencies, accounts or services.
- Changing what the product is: scope, audience, pricing, name.
- Questions of taste where two good answers exist and nothing said so far picks one.

## Never

- Answer your own question or approve your own assumption.
- Push, deploy or release unless a task says to in the human's own words.
`;

export const SPOOL_SKILL = `---
name: spool
description: This project's work queue and feedback loop (the \`spool\` CLI). Use when the user gives feedback, an idea, a bug report or a complaint about the project; asks what's next, what's blocked or what needs their decision; says "run the loop" or asks you to work the queue; approves, answers or rejects something an agent did; or asks which skills exist. Also check it before starting any piece of work.
---

# Spool

Run \`spool prime\` and follow it. It prints the protocol and this project's
autonomy policy; the protocol lives in the CLI so it is always current.

- \`spool status\` — what is ready, active and blocked.
- \`spool next --claim\` — take the most important ready task.
- \`spool review\` — what is waiting on the human.

Never edit files in \`.spool/\` by hand.
`;

export const RECORDER_SKILL = `---
name: recorder
description: Turn this chat into the Spool recorder - the user dictates feedback and ideas, and you capture each one verbatim and file it in the right project's queue. Use when the user invokes /recorder, or says "you're the recorder", "recorder mode" or "start recording".
---

# Recorder

Run \`spool prime recorder\` now and follow it for the rest of this conversation.

From here on, treat every message as dictated feedback to record, unless it is
plainly a question or an instruction to you. You file work; you do not do it.
`;

const BLOCK_START = '<!-- spool:start -->';
const BLOCK_END = '<!-- spool:end -->';

const BLOCK = `${BLOCK_START}
## Spool

This project's work queue lives in \`.spool/\` and is managed with the \`spool\` CLI.
Never edit those files by hand.

- Start of a session: \`spool prime\`, then \`spool status\`.
- The human gives feedback: \`spool capture "<their exact words>"\`, then file it.
- Looking for work: \`spool next --claim\`.
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

export function prime(ws: Workspace, role: Role): string {
  const parts = [role === 'recorder' ? RECORDER : WORKER];
  if (role === 'recorder') {
    parts.push(`${map(ws)}\n`);
  } else {
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
    parts.push(
      `NOW  ${ready(ws).length} ready · ${queue.questions.length} waiting on the human · ${queue.inbox.length} unfiled`,
    );
  }
  return parts.join('\n');
}
