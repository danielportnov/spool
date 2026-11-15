/**
 * The verbs. Each command is a function from the workspace to a `Result` —
 * text for people, data for `--json` — with every rule about what may follow
 * what enforced here, so an agent cannot leave the queue in a shape the next
 * agent can't read. Errors say what to do instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import { type Ctx, notify } from './context.ts';
import { isReverted, repoRoot, resolveCommit, revertCommits, trailerCommits } from './git.ts';
import { runLoop } from './loop.ts';
import {
  type Config,
  type Item,
  type Kind,
  KIND_NAMES,
  SIZES,
  type Size,
  type Spool,
  SpoolError,
  TYPES,
  type WorkType,
  addLog,
  appendMain,
  isClosed,
  isPlan,
  oneLine,
  overlap,
  reportFile,
  setMain,
  splitBody,
  timestamp,
  tokens,
} from './model.ts';
import { DEFAULT_POLICY, RECORDER_SKILL, type Role, SPOOL_SKILL, about, prime, upsertBlock } from './prime.ts';
import {
  type Paint,
  brief,
  itemJson,
  itemLine,
  nothingReady,
  reviewText,
  showText,
  skillsText,
  statusText,
} from './render.ts';
import { blockers, children, dependents, findCycle, ready, review, stateOf, taskState } from './schedule.ts';
import { BUILT_IN, applicable, checkSkillName, fileFor, ledgerFor, skillPath, writeSkill } from './skills.ts';
import { SPOOL_DIR, type Workspace, findHome, readConfig, skillsDir } from './store.ts';

export type Options = NonNullable<ParseArgsConfig['options']>;
export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Bare {
  ctx: Ctx;
  args: string[];
  opts: Values;
  actor: string;
  p: Paint;
}

export interface Call extends Bare {
  ws: Workspace;
}

export interface Result {
  text: string;
  data?: unknown;
  code?: number;
}

export interface Command {
  name: string;
  aliases?: string[];
  group: 'you' | 'agents' | 'see' | 'setup';
  usage: string;
  summary: string;
  /** Acts for the human unless told otherwise with --as. */
  human?: boolean;
  /** Changes the store, so it runs under the lock. */
  write?: boolean;
  options?: Options;
  run?: (call: Call) => Result;
  /** For commands that manage the workspace themselves. */
  bare?: (call: Bare) => Result;
}

// ------------------------------------------------------------------ helpers

const PROJECT: Options = { project: { type: 'string', short: 'P' } };
const MESSAGE: Options = { message: { type: 'string', short: 'm' } };
const BODY: Options = { body: { type: 'string', short: 'b' } };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const raw = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
const many = (v: unknown): string[] =>
  raw(v)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function words(call: Bare, parts: string[], what: string, hint?: string): string {
  let text = parts.join(' ').trim();
  if (text === '-') text = call.ctx.stdin().trim();
  if (!text) throw new SpoolError(`${what} is missing`, hint);
  return text;
}

function bodyOf(call: Bare): string | undefined {
  const b = call.opts.body;
  if (typeof b !== 'string') return undefined;
  return (b === '-' ? call.ctx.stdin() : b).trim() || undefined;
}

function priorityOf(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^p?([0-3])$/i.exec(v.trim());
  if (!m) throw new SpoolError(`priority "${v}" must be 0 to 3`, '0 urgent · 1 high · 2 normal · 3 someday');
  return Number(m[1]);
}

const SIZE_WORDS: Record<string, Size> = {
  tiny: 'xs',
  xsmall: 'xs',
  'extra-small': 'xs',
  small: 's',
  medium: 'm',
  large: 'l',
  xlarge: 'xl',
  'extra-large': 'xl',
  huge: 'xl',
};
const SIZE_GUIDE = 'xs a line or a value · s one function or screen · m several files · l cuts across the project · xl a project in itself';

function sizeOf(v: unknown): Size | undefined {
  if (typeof v !== 'string') return undefined;
  const key = v.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const size = (SIZES as readonly string[]).includes(key) ? (key as Size) : SIZE_WORDS[key];
  if (!size) throw new SpoolError(`size "${v}" must be one of ${SIZES.join(', ')}`, SIZE_GUIDE);
  return size;
}

function typeOf(v: unknown): WorkType | undefined {
  if (typeof v !== 'string') return undefined;
  const type = TYPES.find((t) => t === v.trim().toLowerCase());
  if (!type) throw new SpoolError(`type "${v}" must be one of ${TYPES.join(', ')}`, 'change makes commits · audit makes a report and findings · plan makes a plan and its parts');
  return type;
}

/** Queue a piece of work: a change, an audit or a plan. */
function fileWork(call: Call, preset?: WorkType): Result {
  const { ws, p } = call;
  const title = words(call, call.args, 'the title', 'spool task "Shorten the jump hang time"');
  const from = many(call.opts.from).map((ref) => ws.get(ref));
  const needs = many(call.opts.needs).map((ref) => ws.get(ref));
  const size = sizeOf(call.opts.size);
  let type = preset ?? typeOf(call.opts.type) ?? 'change';
  // Nothing extra-large is built in one go. It is planned, and the plan's parts are what get built.
  const promoted = type === 'change' && size === 'xl';
  if (promoted) type = 'plan';
  // Findings and parts land beside the audit or plan they came from unless told otherwise.
  const spool = str(call.opts.project) ? ws.project(str(call.opts.project)) : (from.find((i) => i.kind === 'task')?.spool ?? ws.home);
  const quotes = from.filter((i) => i.kind === 'note').map(quoteNote);
  const task = ws.create(spool, 'task', {
    title: oneLine(title, 120),
    priority: priorityOf(call.opts.priority) ?? 2,
    size,
    type: type === 'change' ? undefined : type,
    hold: str(call.opts.hold)?.replace(/\s+/g, ' ').trim(),
    from: uniq(from.map((i) => i.id)),
    needs: uniq(needs.map((i) => i.id)),
    body: [...quotes, bodyOf(call)].filter(Boolean).join('\n\n'),
  });
  for (const note of from) {
    if (note.kind === 'note' && note.status === 'new') {
      note.status = 'filed';
      ws.save(note);
    }
  }
  const out = [`Queued in ${spool.name}:`, `  ${itemLine(ws, task, p, false)}`];
  if (promoted) out.push('Extra-large work starts as a plan, so this was queued as one: it gets split into parts, and the parts get built.');
  return { text: out.join('\n'), data: { task: itemJson(ws, task, true) } };
}

const WORK: Options = {
  priority: { type: 'string', short: 'p' },
  size: { type: 'string', short: 's' },
  from: { type: 'string', multiple: true },
  needs: { type: 'string', multiple: true },
  body: { type: 'string', short: 'b' },
  project: { type: 'string', short: 'P' },
  hold: { type: 'string' },
};

function first(call: Call, what: string, kind?: Kind): Item {
  const ref = call.args[0];
  if (!ref) throw new SpoolError(`${what} is missing`);
  return call.ws.get(ref, kind);
}

/** The human's words as a blockquote, signed with where they came from. */
function quoteNote(note: Item): string {
  const text = splitBody(note.body).main;
  const quoted = text
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return `${quoted}\n> — [[${note.id}]], ${note.created.slice(0, 10)}`;
}

/** Tasks that just became ready because `item` settled. */
function freed(ws: Workspace, item: Item): Item[] {
  return dependents(ws, item).filter((t) => taskState(ws, t) === 'ready');
}

function related(ws: Workspace, text: string): Item[] {
  const want = tokens(text);
  return ws.items
    .filter(
      (i) => (i.kind === 'task' && i.status !== 'dropped') || (i.kind === 'decision' && i.status !== 'dropped' && i.status !== 'decided'),
    )
    // Titles count for more: sibling tasks cut from one note share its quote, not its subject.
    .map((item) => ({
      item,
      score: 3 * overlap(want, tokens(item.title)) + overlap(want, tokens(splitBody(item.body).main)),
    }))
    .filter((m) => m.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((m) => m.item);
}

function likelyProjects(ws: Workspace, text: string): Spool[] {
  if (ws.spools.length < 2) return [];
  const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = tokens(text);
  return ws.spools
    .filter((s) => !s.home)
    .map((spool) => {
      const base = path.basename(spool.root).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const named = base.length >= 3 && flat.includes(base) ? 10 : 0;
      return { spool, score: named + overlap(want, tokens(`${spool.name} ${spool.config.name ?? ''} ${about(spool)}`)) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => m.spool);
}

function claim(call: Call, task: Item, force: boolean): void {
  const { ws, actor } = call;
  const state = taskState(ws, task);
  if (state === 'done' || state === 'dropped') throw new SpoolError(`${task.id} is already ${state}`);
  if (state === 'held') {
    throw new SpoolError(`${task.id} is on hold: ${task.hold}`, `Only the human releases it: spool release ${task.id}`);
  }
  if (state === 'blocked') {
    throw new SpoolError(
      `${task.id} is blocked on ${blockers(ws, task).map((b) => b.id).join(', ')}`,
      'Pick something else: spool next',
    );
  }
  if (state === 'active' && task.by !== actor && !force) {
    throw new SpoolError(`${task.id} is being worked by ${task.by ?? 'someone'}`, 'Take it anyway with --force, or: spool next');
  }
  task.status = 'active';
  task.by = actor;
  task.started = timestamp(ws.now());
  addLog(task, actor, state === 'stale' ? 'picked up after the last claim went quiet' : 'started', ws.now());
  ws.save(task);
}

// ----------------------------------------------------------------- commands

export const COMMANDS: Command[] = [
  // ---- the human's side ----------------------------------------------------
  {
    name: 'capture',
    aliases: ['note'],
    group: 'you',
    usage: 'capture <your words…> [-P <project>]',
    summary: 'Drop feedback in, exactly as said',
    human: true,
    write: true,
    options: { ...PROJECT },
    run(call) {
      const { ws, p } = call;
      const text = words(call, call.args, 'the feedback', 'spool capture "the jump feels floaty"');
      const spool = ws.project(str(call.opts.project));
      const note = ws.create(spool, 'note', { title: oneLine(text, 72), body: text, by: call.actor });
      const near = related(ws, text);
      const projects = likelyProjects(ws, text);
      const out = [`${p.bold(note.id)} captured in ${spool.name}'s inbox.`];
      if (near.length) out.push('', 'Looks related:', ...near.map((i) => `  ${itemLine(ws, i, p)}`));
      if (projects.length) out.push('', `May belong to: ${projects.map((s) => s.name).join(', ')}`);
      out.push(
        '',
        p.dim(`file it   spool task "<title>" --from ${note.id}${ws.spools.length > 1 ? ' -P <project>' : ''}`),
        p.dim(`          spool file ${note.id} --into <id>`),
      );
      return {
        text: out.join('\n'),
        data: {
          note: itemJson(ws, note, true),
          related: near.map((i) => itemJson(ws, i)),
          projects: projects.map((s) => s.name),
        },
      };
    },
  },
  {
    name: 'review',
    group: 'you',
    usage: 'review [-P <project>]',
    summary: 'Everything waiting on you, most blocking first',
    options: { ...PROJECT },
    run({ ws, p, opts }) {
      const queue = review(ws, str(opts.project));
      const json = Object.fromEntries(
        Object.entries(queue).map(([key, items]) => [key, (items as Item[]).map((i) => itemJson(ws, i, key === 'questions'))]),
      );
      return { text: reviewText(ws, queue, p), data: json };
    },
  },
  {
    name: 'answer',
    group: 'you',
    usage: 'answer <d-id> <option number | your call…>',
    summary: 'Answer a question, or overrule an assumption',
    human: true,
    write: true,
    run(call) {
      const { ws, p, actor } = call;
      const d = first(call, 'which decision', 'decision');
      const said = call.args.slice(1).join(' ').trim();
      const menu = d.options.map((o, i) => `${i + 1}) ${o}`).join('   ');
      if (!said) throw new SpoolError('the answer is missing', menu || `spool answer ${d.id} "<your call>"`);
      if (d.status === 'dropped') throw new SpoolError(`${d.id} was dropped`);
      let choice = said;
      if (/^\d+$/.test(said) && d.options.length) {
        const n = Number(said);
        if (n < 1 || n > d.options.length) throw new SpoolError(`${d.id} has no option ${n}`, menu);
        choice = d.options[n - 1]!;
      }

      const deps = dependents(ws, d);
      const was = d.status;
      const old = d.choice;
      d.status = 'decided';
      d.choice = choice;
      d.reviewed = timestamp(ws.now());

      if (was === 'open') {
        d.by = actor;
        addLog(d, actor, `answered: ${choice}`, ws.now());
        ws.save(d);
        const ready = freed(ws, d);
        const out = [`${p.bold(d.id)} decided: ${choice}`];
        if (ready.length) out.push('Now ready:', ...ready.map((t) => `  ${itemLine(ws, t, p)}`));
        return { text: out.join('\n'), data: { decision: itemJson(ws, d), unblocked: ready.map((t) => t.id) } };
      }

      if (old === choice) {
        addLog(d, actor, 'approved', ws.now());
        ws.save(d);
        return { text: `${p.bold(d.id)} approved: ${choice}`, data: { decision: itemJson(ws, d) } };
      }

      // The human wants something other than what was assumed. Work may already stand on the old answer.
      d.by = actor;
      addLog(d, actor, `overruled "${old ?? ''}" → ${choice}`, ws.now());
      ws.save(d);
      const built = deps.filter((t) => t.status === 'done');
      for (const t of deps.filter((t) => t.status === 'open' || t.status === 'active')) {
        addLog(t, actor, `${d.id} changed: now "${choice}" (was "${old ?? ''}")`, ws.now());
        ws.save(t);
      }
      const out = [`${p.bold(d.id)} overruled: ${choice}  ${p.dim(`(was: ${old ?? '—'})`)}`];
      let rework: Item | undefined;
      if (built.length || !deps.length) {
        const lines = built.map((t) => {
          const commits = t.commits.length ? ` — commits ${t.commits.map((c) => c.slice(0, 7)).join(', ')}` : '';
          return `- [[${t.id}]] ${t.title}${commits}. \`spool revert ${t.id}\` takes it back whole.`;
        });
        rework = ws.create(d.spool, 'task', {
          title: oneLine(`Rework: ${d.title} → ${choice}`, 90),
          priority: 1,
          from: [d.id],
          needs: [d.id],
          body: [
            `The human overruled an agent's assumption ([[${d.id}]]).`,
            `**Question:** ${d.title}\n**Was:** ${old ?? '—'}\n**Now:** ${choice}`,
            lines.length ? `Built on the old answer:\n${lines.join('\n')}` : 'Find what was built on the old answer and bring it in line.',
          ].join('\n\n'),
        });
        out.push(`Queued ${p.bold(rework.id)} to bring the work in line.`);
      }
      return { text: out.join('\n'), data: { decision: itemJson(ws, d), rework: rework?.id ?? null } };
    },
  },
  {
    name: 'approve',
    group: 'you',
    usage: 'approve <id…> | --all [-P <project>]',
    summary: "Accept an agent's call, finished work or a new skill; give a plan its go-ahead",
    human: true,
    write: true,
    options: { all: { type: 'boolean', short: 'a' }, ...PROJECT },
    run(call) {
      const { ws, p, actor } = call;
      let targets: Item[];
      if (call.opts.all) {
        const queue = review(ws, str(call.opts.project));
        targets = [...queue.assumptions, ...queue.shipped, ...queue.skills];
        if (!targets.length) return { text: 'Nothing to approve.', data: { approved: [] } };
      } else {
        if (!call.args.length) throw new SpoolError('what to approve is missing', 'spool approve <id>   or   spool approve --all');
        targets = call.args.map((ref) => ws.get(ref));
      }
      for (const item of targets) {
        if (item.kind === 'note') throw new SpoolError(`${item.id} is a note; file it instead`, `spool file ${item.id} --into <id>`);
        if (item.kind === 'decision' && item.status === 'open') {
          throw new SpoolError(`${item.id} is a question, not an assumption`, `Answer it: spool answer ${item.id} <n|text>`);
        }
        if (item.kind === 'task' && item.status !== 'done') throw new SpoolError(`${item.id} isn't finished yet`);
        if (item.status === 'dropped') throw new SpoolError(`${item.id} was dropped`);
      }
      const now = timestamp(ws.now());
      for (const item of targets) {
        if (item.kind === 'decision') item.status = 'decided';
        if (!item.reviewed) addLog(item, actor, 'approved', ws.now());
        item.reviewed = now;
        ws.save(item);
      }
      const ready = uniq(targets.flatMap((i) => freed(ws, i)));
      const out = [`Approved ${targets.length}:`, ...targets.map((i) => `  ${itemLine(ws, i, p)}`)];
      if (ready.length) out.push('Now ready:', ...ready.map((t) => `  ${itemLine(ws, t, p)}`));
      return { text: out.join('\n'), data: { approved: targets.map((i) => i.id), unblocked: ready.map((t) => t.id) } };
    },
  },
  {
    name: 'revert',
    group: 'you',
    usage: 'revert <t-id> [-m <why>] [--drop]',
    summary: "Undo a task's commits (or send back a plan or audit) and reopen it with your reason",
    human: true,
    write: true,
    options: { ...MESSAGE, drop: { type: 'boolean' } },
    run(call) {
      const { ws, p, actor } = call;
      const t = first(call, 'which task', 'task');
      if (t.status !== 'done') {
        throw new SpoolError(`${t.id} isn't finished, so there is nothing to revert`, `To abandon it: spool drop ${t.id}`);
      }
      const why = str(call.opts.message) ?? call.args.slice(1).join(' ').trim();
      const root = repoRoot(t.spool.root);
      let reverted: string[] = [];
      let skipped: { sha: string; why: string }[] = [];
      if (root) {
        const shas = uniq([...t.commits, ...trailerCommits(root, t.id)]);
        if (shas.length) {
          const result = revertCommits(root, shas, t.spool.dir, (undone) =>
            [
              `Revert "${t.title}"`,
              ...(why ? [why] : []),
              undone.map((sha) => `This reverts commit ${sha}.`).join('\n'),
              `Spool-Revert: ${t.id}`,
            ].join('\n\n'),
          );
          if (!result.ok) throw new SpoolError(`could not revert ${t.id}: ${result.error}`);
          ({ reverted, skipped } = result);
        }
      }

      // Calls an agent made for this task alone, never confirmed by the human, go with the work
      // they produced — otherwise the next attempt would be briefed to repeat the mistake.
      const voided = t.needs
        .map((id) => ws.find(id))
        .filter((d): d is Item => !!d && d.kind === 'decision' && d.status === 'assumed' && dependents(ws, d).every((x) => x === t));
      for (const d of voided) {
        d.status = 'dropped';
        addLog(d, actor, `dropped: ${t.id}, the work built on it, was reverted`, ws.now());
        ws.save(d);
      }
      t.needs = t.needs.filter((id) => !voided.some((d) => d.id === id));

      // A plan or an audit that is sent back takes its unstarted parts and findings with it.
      const orphans = t.type ? children(ws, t).filter((k) => k.status === 'open') : [];
      for (const k of orphans) {
        k.status = 'dropped';
        addLog(k, actor, `dropped: ${t.id}, the ${t.type} it came from, was sent back`, ws.now());
        ws.save(k);
      }

      t.status = call.opts.drop ? 'dropped' : 'open';
      t.by = undefined;
      t.summary = undefined;
      t.reviewed = undefined;
      t.commits = [];
      if (!call.opts.drop) t.priority = Math.min(t.priority ?? 2, 1);
      if (why) appendMain(t, `> ${why}\n> — on reverting the first attempt, ${timestamp(ws.now()).slice(0, 10)}`);
      addLog(t, actor, `reverted ${reverted.length} commit(s)${why ? `: ${why}` : ''}`, ws.now());
      ws.save(t);

      const out: string[] = [];
      if (reverted.length) {
        out.push(`${p.bold(t.id)} reverted — ${reverted.length} commit(s) undone in one new commit.`);
      } else {
        out.push(`${p.bold(t.id)} ${call.opts.drop ? 'dropped' : 'reopened'}. ${root ? 'No commits were tied to it' : 'This is not a git repository'}, so no code was changed.`);
      }
      for (const s of skipped) out.push(p.dim(`  left ${s.sha.slice(0, 7)} alone: ${s.why}`));
      for (const d of voided) out.push(p.dim(`  dropped the assumption behind it: ${d.id} ${oneLine(d.choice ?? d.title, 60)}`));
      if (orphans.length) out.push(p.dim(`  dropped ${orphans.length} unstarted ${t.type === 'plan' ? 'part(s)' : 'finding(s)'} that came from it`));
      if (!call.opts.drop) out.push(`It is back in the queue at p${t.priority}${why ? ' with your reason attached' : ''}.`);
      return { text: out.join('\n'), data: { task: itemJson(ws, t), reverted, skipped, voided: voided.map((d) => d.id), orphans: orphans.map((k) => k.id) } };
    },
  },

  {
    name: 'release',
    group: 'you',
    usage: 'release <t-id…>',
    summary: 'Take work off hold: it may start now',
    human: true,
    write: true,
    run(call) {
      const { ws, p, actor } = call;
      if (!call.args.length) throw new SpoolError('what to release is missing', 'See what is parked: spool list -s held');
      const tasks = call.args.map((ref) => ws.get(ref, 'task'));
      for (const t of tasks) if (!t.hold) throw new SpoolError(`${t.id} is not on hold`);
      for (const t of tasks) {
        addLog(t, actor, `released from hold (was: ${t.hold})`, ws.now());
        t.hold = undefined;
        ws.save(t);
      }
      return { text: `Released:\n${tasks.map((t) => `  ${itemLine(ws, t, p)}`).join('\n')}`, data: { released: tasks.map((t) => itemJson(ws, t)) } };
    },
  },

  // ---- the agents' side ----------------------------------------------------
  {
    name: 'prime',
    group: 'agents',
    usage: 'prime [worker|recorder]',
    summary: 'Print the protocol for a role — run it first',
    run({ ws, args }) {
      const role = (args[0] ?? 'worker') as Role;
      if (role !== 'worker' && role !== 'recorder') throw new SpoolError(`no role "${args[0]}"`, 'spool prime worker   or   spool prime recorder');
      return { text: prime(ws, role), data: { role, protocol: prime(ws, role) } };
    },
  },
  {
    name: 'next',
    group: 'agents',
    usage: 'next [--claim] [-P <project>]',
    summary: 'The most important ready task, with all its context',
    write: true,
    options: { claim: { type: 'boolean', short: 'c' }, ...PROJECT },
    run(call) {
      const { ws, p } = call;
      const project = str(call.opts.project);
      const list = ready(ws, project);
      const task = list[0];
      if (!task) return { text: nothingReady(ws, project), data: { task: null, ready: 0 } };
      if (call.opts.claim) claim(call, task, true);
      const out = [brief(ws, task, p)];
      if (!call.opts.claim) out.push(p.dim(`claim it        spool start ${task.id}`));
      if (list.length > 1) out.push(p.dim(`${list.length - 1} more ready behind it`));
      return { text: out.join('\n'), data: { task: itemJson(ws, task, true), brief: brief(ws, task, p), ready: list.length } };
    },
  },
  {
    name: 'start',
    group: 'agents',
    usage: 'start <t-id> [--force]',
    summary: 'Claim a specific task',
    write: true,
    options: { force: { type: 'boolean' } },
    run(call) {
      const t = first(call, 'which task', 'task');
      claim(call, t, !!call.opts.force);
      return { text: brief(call.ws, t, call.p), data: { task: itemJson(call.ws, t, true) } };
    },
  },
  {
    name: 'log',
    group: 'agents',
    usage: 'log <id> <what the next agent should know…>',
    summary: 'Leave a note on an item for whoever comes next',
    write: true,
    run(call) {
      const item = first(call, 'which item');
      addLog(item, call.actor, words(call, call.args.slice(1), 'the note'), call.ws.now());
      call.ws.save(item);
      return { text: `Logged on ${item.id}.`, data: { id: item.id } };
    },
  },
  {
    name: 'ask',
    group: 'agents',
    usage: 'ask <question…> --option <A> --option <B> [--recommend <n>] [--why <reason>] [--for <t-id>]',
    summary: 'Put a call to the human; the task waits, you move on',
    write: true,
    options: {
      option: { type: 'string', short: 'o', multiple: true },
      recommend: { type: 'string', short: 'r' },
      why: { type: 'string' },
      for: { type: 'string' },
      ...PROJECT,
    },
    run(call) {
      const { ws, p, actor } = call;
      const question = words(call, call.args, 'the question');
      const options = raw(call.opts.option).map((o) => o.trim()).filter(Boolean);
      let recommend: number | undefined;
      if (str(call.opts.recommend)) {
        recommend = Number(call.opts.recommend);
        if (!Number.isInteger(recommend) || recommend < 1 || recommend > options.length) {
          throw new SpoolError(`--recommend must be an option number from 1 to ${options.length}`);
        }
      }
      const task = str(call.opts.for) ? ws.get(str(call.opts.for)!, 'task') : undefined;
      if (task && isClosed(task)) throw new SpoolError(`${task.id} is already ${task.status}`);
      const spool = task?.spool ?? ws.project(str(call.opts.project));
      const d = ws.create(spool, 'decision', {
        title: question,
        options,
        recommend,
        by: actor,
        body: [str(call.opts.why), task ? `For [[${task.id}]] — ${task.title}` : ''].filter(Boolean).join('\n\n'),
      });
      if (task) {
        task.needs = uniq([...task.needs, d.id]);
        if (task.status === 'active') {
          task.status = 'open';
          task.by = undefined;
        }
        addLog(task, actor, `waiting on ${d.id}: ${question}`, ws.now());
        ws.save(task);
      }
      const told = notify(call.ctx, 'ask', question, d);
      const out = [`${p.bold(d.id)} asked${told ? ', and the human was notified' : ''}.`];
      if (task) out.push(`${task.id} waits until it is answered. Don't wait with it: spool next`);
      return { text: out.join('\n'), data: { decision: itemJson(ws, d, true), notified: told } };
    },
  },
  {
    name: 'assume',
    group: 'agents',
    usage: 'assume <question…> --chose <what you did> [--why <reason>] [--for <t-id>]',
    summary: 'Record a call you made yourself, and keep going',
    write: true,
    options: { chose: { type: 'string' }, why: { type: 'string' }, for: { type: 'string' }, ...PROJECT },
    run(call) {
      const { ws, p, actor } = call;
      const question = words(call, call.args, 'the question');
      const chose = str(call.opts.chose);
      if (!chose) throw new SpoolError('--chose is missing', 'Say what you decided: --chose "<what you did>"');
      const task = str(call.opts.for) ? ws.get(str(call.opts.for)!, 'task') : undefined;
      const spool = task?.spool ?? ws.project(str(call.opts.project));
      const d = ws.create(spool, 'decision', {
        title: question,
        status: 'assumed',
        choice: chose,
        by: actor,
        body: [str(call.opts.why), task ? `For [[${task.id}]] — ${task.title}` : ''].filter(Boolean).join('\n\n'),
      });
      if (task) {
        task.needs = uniq([...task.needs, d.id]);
        addLog(task, actor, `assumed ${d.id}: ${question} → ${chose}`, ws.now());
        ws.save(task);
      }
      return {
        text: `${p.bold(d.id)} recorded — carry on. The human will see it in their review.`,
        data: { decision: itemJson(ws, d, true) },
      };
    },
  },
  {
    name: 'done',
    group: 'agents',
    usage: 'done <t-id> -m <what changed> [--report <file>|-] [--commit <ref>…] [--skill <name>…]',
    summary: 'Finish a task: record how to undo a change, or hand in the report of an audit or plan',
    write: true,
    options: {
      ...MESSAGE,
      commit: { type: 'string', multiple: true },
      skill: { type: 'string', multiple: true },
      report: { type: 'string' },
    },
    run(call) {
      const { ws, p, actor } = call;
      const t = first(call, 'which task', 'task');
      if (isClosed(t)) throw new SpoolError(`${t.id} is already ${t.status}`);
      const type = t.type ?? 'change';
      const summary = (str(call.opts.message) ?? call.args.slice(1).join(' ')).replace(/\s+/g, ' ').trim();
      if (!summary) {
        throw new SpoolError(
          'the summary is missing',
          `The human reads it in their review: spool done ${t.id} -m "<what changed, and how to see it>"`,
        );
      }

      // An audit or a plan is finished by what it found, written down where the human can read it.
      const reportPath = reportFile(t);
      const reportArg = str(call.opts.report);
      let report: string | undefined;
      if (reportArg) {
        try {
          report = reportArg === '-' ? call.ctx.stdin() : fs.readFileSync(path.resolve(call.ctx.cwd, reportArg), 'utf8');
        } catch {
          throw new SpoolError(`cannot read the report at ${reportArg}`);
        }
        if (!report.trim()) throw new SpoolError('the report is empty');
      } else if (type !== 'change' && !fs.existsSync(reportPath)) {
        throw new SpoolError(
          `${type === 'audit' ? 'an audit' : 'a plan'} is finished by its report`,
          `spool done ${t.id} -m "<the headline>" --report - <<'EOF' … EOF      (or --report <file>)`,
        );
      }

      const root = repoRoot(t.spool.root);
      const commits = new Set(t.commits);
      for (const ref of many(call.opts.commit)) {
        if (!root) throw new SpoolError(`${t.spool.name} is not a git repository, so --commit means nothing here`);
        const sha = resolveCommit(root, ref);
        if (!sha) throw new SpoolError(`no commit "${ref}" in ${root}`);
        commits.add(sha);
      }
      if (root) for (const sha of trailerCommits(root, t.id)) if (!isReverted(root, sha)) commits.add(sha);

      const usable = applicable(ws, t.spool);
      const used = many(call.opts.skill);
      for (const name of used) {
        const skill = usable.find((s) => s.name === name);
        if (!skill) {
          throw new SpoolError(`no skill "${name}" for ${t.spool.name}`, `Known here: ${usable.map((s) => s.name).join(', ') || 'none'}`);
        }
        // The first reported use is what brings a hand-written skill onto the ledger.
        const ledger =
          ledgerFor(ws, skill) ??
          ws.create(skill.spool, 'skill', {
            title: skill.name,
            path: skill.rel,
            uses: 0,
            reviewed: timestamp(ws.now()),
            body: skill.description,
          });
        ledger.uses = (ledger.uses ?? 0) + 1;
        ledger.used = timestamp(ws.now());
        ws.save(ledger);
      }

      if (report !== undefined) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, `${report.trim()}\n`);
      }
      t.status = 'done';
      t.summary = summary;
      t.commits = [...commits];
      t.skills = uniq([...t.skills, ...used]);
      addLog(t, actor, `done: ${summary}`, ws.now());
      ws.save(t);

      const kids = children(ws, t).filter((k) => k.status !== 'dropped');
      const gated = kids.filter((k) => k.needs.includes(t.id) && k.status === 'open');
      const ready = uniq([...dependents(ws, t), ...kids]).filter((r) => taskState(ws, r) === 'ready');
      const out = [`${p.bold(t.id)} done.`];
      if (fs.existsSync(reportPath)) out.push(p.dim(`  ${type === 'plan' ? 'plan' : 'report'}  ${path.relative(t.spool.root, reportPath)}`));
      if (type === 'audit') out.push(p.dim(`  ${kids.length} finding(s) filed from it`));
      let told = false;
      if (type === 'plan') {
        if (!kids.length) out.push(p.yellow(`  No parts were filed from it. A plan is carried out by its parts: spool task "<part>" --from ${t.id}`));
        else out.push(p.dim(`  ${kids.length} part(s) filed from it`));
        if (gated.length) {
          told = notify(call.ctx, 'plan', `A plan is waiting for your go-ahead: ${t.title}`, t);
          out.push(`  ${gated.length} of them wait for the human's go-ahead${told ? ', and the human was notified' : ''}: spool approve ${t.id}`);
        }
      }
      if (commits.size) out.push(p.dim(`  ${commits.size} commit(s) on record — spool revert ${t.id} would undo them`));
      else if (root && type === 'change') {
        out.push(p.yellow(`  No commits found for it. Without the "Spool: ${t.id}" trailer or --commit, it cannot be reverted.`));
      }
      if (ready.length) out.push('Now ready:', ...ready.map((r) => `  ${itemLine(ws, r, p)}`));
      out.push(p.dim('  A procedure worth keeping? spool skill add <name> -d "<when to use it>" --from ' + t.id + ' -b -'));
      return {
        text: out.join('\n'),
        data: { task: itemJson(ws, t), unblocked: ready.map((r) => r.id), children: kids.map((k) => k.id), notified: told },
      };
    },
  },
  {
    name: 'task',
    aliases: ['add'],
    group: 'agents',
    usage: 'task <title…> [-s xs|s|m|l|xl] [-p 0-3] [-t change|audit|plan] [--hold <why>] [--from <id>…] [--needs <id>…] [-b <body>] [-P <project>]',
    summary: 'Queue a change',
    write: true,
    options: { ...WORK, type: { type: 'string', short: 't' } },
    run: (call) => fileWork(call),
  },
  {
    name: 'audit',
    group: 'agents',
    usage: 'audit <what to examine, and through whose eyes…> [-s size] [-p 0-3] [--from <id>…] [-P <project>]',
    summary: 'Queue a look-and-report: its output is a report and findings',
    write: true,
    options: { ...WORK },
    run: (call) => fileWork(call, 'audit'),
  },
  {
    name: 'plan',
    group: 'agents',
    usage: 'plan <the objective…> [-s size] [-p 0-3] [--from <id>…] [-P <project>]',
    summary: 'Queue something big or open: its output is a plan and its parts',
    write: true,
    options: { ...WORK },
    run: (call) => fileWork(call, 'plan'),
  },
  {
    name: 'file',
    group: 'agents',
    usage: 'file <n-id> --into <id> | --drop [-m <why>]',
    summary: 'Attach a note to an existing item, or set it aside',
    write: true,
    options: { into: { type: 'string' }, drop: { type: 'boolean' }, ...MESSAGE },
    run(call) {
      const { ws, p, actor } = call;
      const note = first(call, 'which note', 'note');
      if (call.opts.drop) {
        note.status = 'dropped';
        if (str(call.opts.message)) addLog(note, actor, `set aside: ${str(call.opts.message)}`, ws.now());
        ws.save(note);
        return { text: `${p.bold(note.id)} set aside.`, data: { note: itemJson(ws, note) } };
      }
      const into = str(call.opts.into);
      if (!into) throw new SpoolError('where to file it is missing', `spool file ${note.id} --into <id>   or   --drop`);
      const target = ws.get(into);
      if (target.kind === 'note' || target.kind === 'skill') throw new SpoolError(`${target.id} is a ${target.kind}; file notes into tasks or decisions`);
      if (target.status === 'done' || target.status === 'dropped') {
        throw new SpoolError(
          `${target.id} is already ${target.status}, so this is new work`,
          `spool task "<title>" --from ${note.id}${target.spool.home ? '' : ` -P ${target.spool.name}`}`,
        );
      }
      appendMain(target, quoteNote(note));
      target.from = uniq([...target.from, note.id]);
      ws.save(target);
      note.status = 'filed';
      ws.save(note);
      return { text: `${p.bold(note.id)} added to:\n  ${itemLine(ws, target, p)}`, data: { note: itemJson(ws, note), into: target.id } };
    },
  },
  {
    name: 'edit',
    group: 'agents',
    usage: 'edit <id> [--title <t>] [-p 0-3] [-s size] [-t type] [-b <body>] [--needs <id>…|none] [--reopen]',
    summary: 'Change an item',
    write: true,
    options: {
      title: { type: 'string' },
      priority: { type: 'string', short: 'p' },
      size: { type: 'string', short: 's' },
      type: { type: 'string', short: 't' },
      needs: { type: 'string', multiple: true },
      reopen: { type: 'boolean' },
      ...BODY,
    },
    run(call) {
      const { ws, p, actor } = call;
      const item = first(call, 'which item');
      const changed: string[] = [];
      if (str(call.opts.title)) {
        item.title = oneLine(str(call.opts.title)!, 120);
        changed.push('title');
      }
      const priority = priorityOf(call.opts.priority);
      if (priority !== undefined) {
        if (item.kind !== 'task') throw new SpoolError('only tasks have a priority');
        item.priority = priority;
        changed.push(`priority p${priority}`);
      }
      const size = sizeOf(call.opts.size);
      const type = typeOf(call.opts.type);
      if ((size || type) && item.kind !== 'task') throw new SpoolError('only tasks have a size and a type');
      if (size) {
        item.size = size;
        changed.push(`size ${size}`);
      }
      if (type) {
        item.type = type === 'change' ? undefined : type;
        changed.push(`type ${type}`);
      }
      const body = bodyOf(call);
      if (body !== undefined) {
        setMain(item, body);
        changed.push('body');
      }
      if (call.opts.needs !== undefined) {
        if (item.kind !== 'task') throw new SpoolError('only tasks have needs');
        const refs = many(call.opts.needs);
        item.needs = refs.length === 1 && refs[0] === 'none' ? [] : uniq(refs.map((ref) => ws.get(ref).id));
        if (item.needs.includes(item.id)) throw new SpoolError('a task cannot need itself');
        changed.push('needs');
      }
      if (call.opts.reopen) {
        if (item.kind !== 'task' && item.kind !== 'note') throw new SpoolError('only tasks and notes can be reopened');
        if (!isClosed(item)) throw new SpoolError(`${item.id} is already open`);
        item.status = item.kind === 'task' ? 'open' : 'new';
        item.by = item.kind === 'task' ? undefined : item.by;
        item.reviewed = undefined;
        changed.push('reopened');
      }
      if (!changed.length) throw new SpoolError('nothing to change', 'See: spool help edit');
      addLog(item, actor, `edited: ${changed.join(', ')}`, ws.now());
      ws.save(item);
      return { text: `Updated ${changed.join(', ')}:\n  ${itemLine(ws, item, p)}`, data: { item: itemJson(ws, item, true) } };
    },
  },
  {
    name: 'drop',
    group: 'agents',
    usage: 'drop <id…> [-m <why>]',
    summary: 'Abandon an item (a skill is deleted from disk)',
    write: true,
    options: { ...MESSAGE },
    run(call) {
      const { ws, p, actor } = call;
      if (!call.args.length) throw new SpoolError('what to drop is missing');
      const items = call.args.map((ref) => ws.get(ref));
      const why = str(call.opts.message);
      const out: string[] = [];
      const ready: Item[] = [];
      for (const item of items) {
        if (item.status === 'dropped') continue;
        const skill = item.kind === 'skill' ? fileFor(ws, item) : undefined;
        item.status = 'dropped';
        if (item.kind === 'task') item.by = undefined;
        addLog(item, actor, `dropped${why ? `: ${why}` : ''}`, ws.now());
        ws.save(item);
        if (skill && skill.dir.startsWith(skill.spool.root + path.sep) && path.basename(skill.dir) === item.title) {
          fs.rmSync(skill.dir, { recursive: true, force: true });
          out.push(`  removed ${skill.rel}/`);
        }
        out.unshift(`  ${itemLine(ws, item, p)}`);
        ready.push(...freed(ws, item));
      }
      if (ready.length) out.push('Now ready:', ...uniq(ready).map((t) => `  ${itemLine(ws, t, p)}`));
      return { text: `Dropped:\n${out.join('\n')}`, data: { dropped: items.map((i) => i.id), unblocked: uniq(ready).map((t) => t.id) } };
    },
  },
  {
    name: 'hold',
    group: 'agents',
    usage: 'hold <t-id…> -m <why>',
    summary: 'Park work the human does not want started yet; only they release it',
    write: true,
    options: { ...MESSAGE },
    run(call) {
      const { ws, p, actor } = call;
      const why = str(call.opts.message)?.replace(/\s+/g, ' ').trim();
      if (!call.args.length) throw new SpoolError('what to hold is missing');
      if (!why) throw new SpoolError('the reason is missing', 'Say why, in the human\'s words if you can: spool hold <id> -m "<why>"');
      const tasks = call.args.map((ref) => ws.get(ref, 'task'));
      for (const t of tasks) if (isClosed(t)) throw new SpoolError(`${t.id} is already ${t.status}`);
      for (const t of tasks) {
        t.hold = why;
        if (t.status === 'active') {
          t.status = 'open';
          t.by = undefined;
        }
        addLog(t, actor, `put on hold: ${why}`, ws.now());
        ws.save(t);
      }
      return { text: `On hold:\n${tasks.map((t) => `  ${itemLine(ws, t, p)}`).join('\n')}`, data: { held: tasks.map((t) => itemJson(ws, t)) } };
    },
  },
  {
    name: 'skill',
    group: 'agents',
    usage: 'skill add <name> -d <what it does and when to use it> [--from <t-id>] [-b <steps> | -b -] [-P <project>]',
    summary: 'Write a procedure down as a skill, or adopt one you wrote',
    write: true,
    options: {
      description: { type: 'string', short: 'd' },
      from: { type: 'string', multiple: true },
      ...BODY,
      ...PROJECT,
    },
    run(call) {
      const { ws, p, actor } = call;
      const [verb, name] = call.args;
      if (verb !== 'add' || !name) throw new SpoolError('usage: spool skill add <name> …', 'To list skills: spool skills');
      checkSkillName(name);
      const from = many(call.opts.from).map((ref) => ws.get(ref));
      const spool = str(call.opts.project)
        ? ws.project(str(call.opts.project))
        : (from.find((i) => i.kind === 'task')?.spool ?? ws.home);
      const existing = ws.skills.find((s) => s.spool === spool && s.name === name);
      if (existing && ledgerFor(ws, existing)) {
        throw new SpoolError(`skill "${name}" is already tracked as ${ledgerFor(ws, existing)!.id}`, `Improve it by editing ${existing.rel}/SKILL.md`);
      }
      const description = str(call.opts.description)?.replace(/\s+/g, ' ').trim();
      let rel: string;
      if (existing) {
        rel = existing.rel;
      } else {
        const body = bodyOf(call);
        if (!description || !body) {
          throw new SpoolError(
            'a new skill needs a description and its steps',
            `spool skill add ${name} -d "<what it does and when to use it>" -b - <<'EOF' … EOF\n  Or write ${path.relative(spool.root, skillPath(spool, name))}/SKILL.md yourself, then run this again to adopt it.`,
          );
        }
        if (description.length > 1024) throw new SpoolError('the description is over 1024 characters; say when to use it, briefly');
        if (fs.existsSync(skillPath(spool, name))) throw new SpoolError(`${skillPath(spool, name)} already exists`);
        rel = path.relative(spool.root, writeSkill(spool, name, description, body)).split(path.sep).join('/');
      }
      const ledger = ws.create(spool, 'skill', {
        title: name,
        by: actor,
        from: uniq(from.map((i) => i.id)),
        path: rel,
        uses: 0,
        body: description ?? existing?.description ?? '',
      });
      return {
        text: `${p.bold(ledger.id)} skill "${name}" ${existing ? 'adopted' : 'written'} in ${spool.name} — ${rel}/SKILL.md\nIt is live now, and the human will see it in their review.`,
        data: { skill: itemJson(ws, ledger, true) },
      };
    },
  },

  // ---- seeing --------------------------------------------------------------
  {
    name: 'status',
    aliases: ['st'],
    group: 'see',
    usage: 'status [-P <project>]',
    summary: 'One screen: what is ready, active, blocked, and waiting on you',
    options: { ...PROJECT },
    run({ ws, p, opts }) {
      const project = str(opts.project);
      const spools = project ? [ws.project(project)] : ws.spools;
      const queue = review(ws, project);
      return {
        text: statusText(ws, p, project),
        data: {
          workspace: ws.home.name,
          projects: spools.map((spool) => {
            const mine = ws.items.filter((i) => i.kind === 'task' && i.spool === spool);
            const count = (state: string) => mine.filter((t) => taskState(ws, t) === state).length;
            return {
              name: spool.name,
              path: spool.root,
              ready: count('ready') + count('stale'),
              active: count('active'),
              blocked: count('blocked'),
              done: count('done'),
            };
          }),
          waiting: Object.fromEntries(Object.entries(queue).map(([key, items]) => [key, (items as Item[]).length])),
        },
      };
    },
  },
  {
    name: 'list',
    aliases: ['ls'],
    group: 'see',
    usage: 'list [-k <kind>] [-s <state>] [-t <type>] [--size <sizes>] [--search <words>] [-P <project>] [--all]',
    summary: 'Find items; closed ones too with --all or --search',
    options: {
      kind: { type: 'string', short: 'k' },
      status: { type: 'string', short: 's' },
      type: { type: 'string', short: 't' },
      size: { type: 'string' },
      search: { type: 'string' },
      all: { type: 'boolean', short: 'a' },
      ...PROJECT,
    },
    run({ ws, p, opts }) {
      const spool = str(opts.project) ? ws.project(str(opts.project)) : undefined;
      let items = ws.items.filter((i) => !spool || i.spool === spool);
      if (str(opts.kind)) {
        const want = str(opts.kind)!.toLowerCase();
        const kind = KIND_NAMES.find((k) => k === want || `${k}s` === want || k[0] === want);
        if (!kind) throw new SpoolError(`no kind "${opts.kind}"`, `Kinds: ${KIND_NAMES.join(', ')}`);
        items = items.filter((i) => i.kind === kind);
      }
      const type = typeOf(opts.type);
      if (type) items = items.filter((i) => i.kind === 'task' && (i.type ?? 'change') === type);
      if (str(opts.size)) {
        const sizes = many(opts.size).map((v) => sizeOf(v));
        items = items.filter((i) => i.kind === 'task' && sizes.includes(i.size));
      }
      const search = str(opts.search);
      const status = str(opts.status)?.toLowerCase();
      if (status) items = items.filter((i) => stateOf(ws, i) === status || i.status === status);
      else if (search) items = items.filter((i) => i.status !== 'dropped');
      else if (!opts.all) items = items.filter((i) => !isClosed(i));
      if (search) {
        const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
        items = items.filter((i) => {
          const hay = `${i.id} ${i.title} ${i.choice ?? ''} ${i.summary ?? ''} ${i.body}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
      }
      const order: Kind[] = ['task', 'decision', 'note', 'skill'];
      items.sort(
        (a, b) =>
          order.indexOf(a.kind) - order.indexOf(b.kind) ||
          (a.priority ?? 2) - (b.priority ?? 2) ||
          a.created.localeCompare(b.created),
      );
      return {
        text: items.length ? items.map((i) => itemLine(ws, i, p)).join('\n') : 'Nothing matches.',
        data: { items: items.map((i) => itemJson(ws, i)) },
      };
    },
  },
  {
    name: 'show',
    group: 'see',
    usage: 'show <id>',
    summary: 'One item in full',
    run(call) {
      const item = first(call, 'which item');
      return { text: showText(call.ws, item, call.p), data: { item: itemJson(call.ws, item, true) } };
    },
  },
  {
    name: 'inbox',
    group: 'see',
    usage: 'inbox [-P <project>]',
    summary: 'Feedback nobody has filed yet',
    options: { ...PROJECT },
    run({ ws, p, opts }) {
      const notes = review(ws, str(opts.project)).inbox;
      const text = notes.length
        ? notes.map((n) => `${itemLine(ws, n, p)}\n${p.dim(`    ${oneLine(splitBody(n.body).main, 200)}`)}`).join('\n')
        : 'The inbox is empty.';
      return { text, data: { notes: notes.map((n) => itemJson(ws, n, true)) } };
    },
  },
  {
    name: 'skills',
    group: 'see',
    usage: 'skills',
    summary: 'Every skill in the workspace: where it came from, how often it is used',
    run({ ws, p }) {
      return {
        text: skillsText(ws, p),
        data: {
          skills: ws.skills.filter((s) => !BUILT_IN.has(s.name)).map((s) => {
            const ledger = ledgerFor(ws, s);
            return {
              name: s.name,
              description: s.description,
              project: s.spool.name,
              path: `${s.rel}/SKILL.md`,
              tracked: !!ledger,
              id: ledger?.id ?? null,
              by: ledger?.by ?? null,
              from: ledger?.from ?? [],
              uses: ledger?.uses ?? 0,
              reviewed: ledger ? !!ledger.reviewed : null,
            };
          }),
        },
      };
    },
  },
  {
    name: 'graph',
    group: 'see',
    usage: 'graph [--all]',
    summary: 'The items and their links, as a Mermaid diagram',
    options: { all: { type: 'boolean', short: 'a' } },
    run({ ws, opts }) {
      const items = ws.items.filter((i) => opts.all || i.status !== 'dropped');
      const shown = new Set(items.map((i) => i.id));
      const node = (id: string) => id.replace(/-/g, '_');
      const label = (i: Item) => `${i.id}: ${oneLine(i.title, 44).replace(/["\[\]{}()<>|]/g, "'")}`;
      const shape: Record<Kind, (text: string) => string> = {
        note: (t) => `(["${t}"])`,
        task: (t) => `["${t}"]`,
        decision: (t) => `{{"${t}"}}`,
        skill: (t) => `[["${t}"]]`,
      };
      const edges: { from: string; to: string; type: string }[] = [];
      for (const i of items) {
        for (const src of i.from) if (shown.has(src)) edges.push({ from: src, to: i.id, type: 'from' });
        for (const dep of i.needs) if (shown.has(dep) && !i.from.includes(dep)) edges.push({ from: dep, to: i.id, type: 'needs' });
        for (const name of i.skills) {
          const ledger = items.find((s) => s.kind === 'skill' && s.title === name);
          if (ledger) edges.push({ from: i.id, to: ledger.id, type: 'uses' });
        }
      }
      const arrow: Record<string, string> = { from: '-->', needs: '-.->|needs|', uses: '-.->|uses|' };
      const lines = [
        'flowchart LR',
        ...items.map((i) => `  ${node(i.id)}${shape[i.kind](label(i))}`),
        ...edges.map((e) => `  ${node(e.from)} ${arrow[e.type]} ${node(e.to)}`),
      ];
      return { text: lines.join('\n'), data: { nodes: items.map((i) => itemJson(ws, i)), edges } };
    },
  },
  {
    name: 'check',
    group: 'see',
    usage: 'check',
    summary: 'Validate the store: bad files, dangling links, cycles',
    run({ ws, p }) {
      const errors = ws.problems.map((pr) => `${pr.file}: ${pr.message}`);
      const warnings: string[] = [];
      for (const item of ws.items) {
        for (const id of item.needs) if (!ws.find(id)) warnings.push(`${item.id} needs ${id}, which is not in this workspace`);
        if (item.needs.includes(item.id)) errors.push(`${item.id} needs itself`);
        if (item.kind === 'decision') {
          if (item.recommend !== undefined && (item.recommend < 1 || item.recommend > item.options.length)) {
            errors.push(`${item.id} recommends option ${item.recommend} of ${item.options.length}`);
          }
          if ((item.status === 'assumed' || item.status === 'decided') && !item.choice) errors.push(`${item.id} is ${item.status} with no choice`);
        }
        if (item.kind === 'task') {
          if (item.status === 'done' && !item.summary) warnings.push(`${item.id} is done with no summary`);
          if (taskState(ws, item) === 'stale') warnings.push(`${item.id} was claimed by ${item.by ?? 'someone'} and has gone quiet`);
          if (item.priority !== undefined && (item.priority < 0 || item.priority > 3)) errors.push(`${item.id} has priority ${item.priority}`);
        }
        if (item.kind === 'skill' && item.status === 'active' && !fileFor(ws, item)) warnings.push(`${item.id} tracks skill "${item.title}" but ${item.path}/SKILL.md is gone`);
      }
      const cycle = findCycle(ws);
      if (cycle) errors.push(`needs form a loop: ${cycle.join(' → ')}`);
      const out = [...errors.map((e) => p.red(`error  ${e}`)), ...warnings.map((w) => p.yellow(`warn   ${w}`))];
      out.push(`${ws.items.length} items in ${ws.spools.length} project(s): ${errors.length} error(s), ${warnings.length} warning(s).`);
      return { text: out.join('\n'), data: { errors, warnings, items: ws.items.length }, code: errors.length ? 1 : 0 };
    },
  },

  // ---- setup ---------------------------------------------------------------
  {
    name: 'init',
    group: 'setup',
    usage: 'init [--name <name>] [--about <one line>] [--no-skills] [--no-agents-file] [--force]',
    summary: 'Start a spool in this directory',
    options: {
      name: { type: 'string' },
      about: { type: 'string' },
      'no-skills': { type: 'boolean' },
      'no-agents-file': { type: 'boolean' },
      force: { type: 'boolean' },
    },
    bare({ ctx, opts, p }) {
      const root = ctx.cwd;
      const dir = path.join(root, SPOOL_DIR);
      const wrote: string[] = [];
      const write = (file: string, text: string, overwrite = false): void => {
        if (!overwrite && fs.existsSync(file)) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        wrote.push(path.relative(root, file));
      };

      const fresh = !fs.existsSync(path.join(dir, 'config.json'));
      const parent = findHome(path.dirname(root));
      if (fresh) {
        const config: Config = { version: 1, name: str(opts.name) ?? path.basename(root) };
        if (str(opts.about)) config.about = str(opts.about);
        write(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
        write(path.join(dir, 'policy.md'), DEFAULT_POLICY);
        write(path.join(dir, '.gitignore'), '.lock\n*.tmp\n');
        fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
      }
      const config = readConfig(root);
      const spool: Spool = { root, dir, name: config.name ?? path.basename(root), home: true, config };

      if (!opts['no-skills']) {
        const base = skillsDir(spool);
        write(path.join(base, 'spool', 'SKILL.md'), SPOOL_SKILL, !!opts.force);
        write(path.join(base, 'recorder', 'SKILL.md'), RECORDER_SKILL, !!opts.force);
      }
      if (!opts['no-agents-file']) {
        const present = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(root, f)));
        for (const name of present.length ? present : ['AGENTS.md']) {
          const file = path.join(root, name);
          const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
          const after = upsertBlock(before);
          if (after !== before) write(file, after, true);
        }
      }

      const out = [fresh ? `Spool is set up in ${p.bold(spool.name)}.` : `${p.bold(spool.name)} already has a spool; refreshed what was missing.`];
      if (wrote.length) out.push(...wrote.map((f) => p.dim(`  wrote ${f}`)));
      if (parent) out.push(`It sits under ${path.basename(parent)} and shows up there as a project.`);
      if (fresh) {
        out.push(
          '',
          'Next',
          '  spool capture "<the first thing on your mind>"',
          '  /recorder in Claude Code turns a chat into the recorder for this folder.',
          `  ${path.join(SPOOL_DIR, 'policy.md')} says what agents may decide without you — worth two minutes.`,
        );
      }
      return { text: out.join('\n'), data: { root, created: fresh, wrote } };
    },
  },
  {
    name: 'loop',
    group: 'setup',
    usage: 'loop [--once] [--max <n>] [--watch <seconds>] [--agent <command>] [--dry-run] [-P <project>]',
    summary: 'Work the queue: hand each ready task to an agent until none are left',
    options: {
      once: { type: 'boolean' },
      max: { type: 'string' },
      watch: { type: 'string' },
      agent: { type: 'string' },
      'dry-run': { type: 'boolean' },
      ...PROJECT,
    },
    bare: (call) => runLoop(call),
  },
];
