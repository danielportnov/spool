/**
 * The verbs. Each command is a function from the workspace to a `Result` —
 * text for people, data for `--json` — with every rule about what may follow
 * what enforced here, so an agent cannot leave the queue in a shape the next
 * agent can't read. Errors say what to do instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import { agentsCommand } from './agents-switch.ts';
import { builderCommand } from './builder.ts';
import { effortOf, modelOf } from './agent.ts';
import { morning, morningText } from './brief.ts';
import { HARNESSES, describe, harness, installFor, installedAnywhere, others } from './harness.ts';
import { spawnSync } from 'node:child_process';
import { type Ctx, notify, saveUserConfig, userConfig } from './context.ts';
import { doctor } from './doctor.ts';
import { GOALS_STARTER, goalsFile, goalsOf, goalsText } from './goals.ts';
import { isReverted, repoRoot, resolveCommit, revertCommits, trailerCommits } from './git.ts';
import { demo } from './demo.ts';
import { dropLesson, keepLesson, lessonLine, lessons } from './lessons.ts';
import { runLoop } from './loop.ts';
import { servePage } from './page.ts';
import { watch } from './watch.ts';
import { serve } from './mcp.ts';
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
  whyOf,
  tokens,
} from './model.ts';
import { DEFAULT_POLICY, type Role, about, prime, upsertBlock } from './prime.ts';
import {
  type Paint,
  brief,
  candidateJson,
  itemJson,
  itemLine,
  nothingReady,
  overviewTable,
  overviewText,
  tableRows,
  reviewText,
  showText,
  skillsText,
  sprintAbout,
  statusText,
  suggestText,
} from './render.ts';
import {
  IN_BUILD,
  blockers,
  buildLine,
  children,
  dependents,
  docket,
  findCycle,
  ready,
  review,
  sprintOf,
  sprintTasks,
  stateOf,
  taskState,
} from './schedule.ts';
import { BUILT_IN, applicable, checkSkillName, fileFor, ledgerFor, skillPath, writeSkill } from './skills.ts';
import { SPOOL_DIR, Workspace, findFolder, findHome, readConfig, skillsDir, worktreeOwner } from './store.ts';
import { alikeIn, alikeLines, similarLines, similarTo } from './similar.ts';
import { addQuote, setLine, visionQuote } from './sprints.ts';
import { SUGGEST, suggestSkills } from './suggest.ts';
import { standingLines, standingOf } from './standing.ts';
import { type Landing, type Opened, closeWorktree, land, openWorktree } from './worktree.ts';

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
  /** Whatever the command's `before` step found out, done while nothing was locked. */
  before?: unknown;
}

export interface Result {
  text: string;
  data?: unknown;
  code?: number;
}

export interface Command {
  name: string;
  aliases?: string[];
  /** 'setup' is for a person at their own machine: those verbs start programs or write wherever they are pointed, so `spool mcp` does not offer them. */
  group: 'you' | 'agents' | 'see' | 'setup';
  usage: string;
  summary: string;
  /** Acts for the human unless told otherwise with --as. */
  human?: boolean;
  /** Changes the store, so it runs under the lock. */
  write?: boolean;
  options?: Options;
  /** The option that names a file to read. A caller with no files (`spool mcp`) gives the text instead. */
  reads?: string;
  run?: (call: Call) => Result;
  /** For commands that manage the workspace themselves. */
  bare?: (call: Bare) => Result;
  /**
   * Slow work to do first, before the store is opened and locked: its result arrives as `call.before`.
   * It may refuse the command by throwing.
   */
  before?: (call: Bare) => unknown;
  /** Runs last, whatever happened, with what `before` gave back: to let go of anything it took. */
  after?: (before: unknown) => void;
}

// ------------------------------------------------------------------ helpers

/**
 * `.spool/.gitignore`. The queue is working state for agents, and it holds what
 * the human said word for word, so by default git ignores all of it: the `*`
 * covers every file in the directory, this one included. Sharing the queue is
 * a choice someone makes on purpose, by deleting that line or with `--share`.
 */
const QUEUE_SHARED = '.lock\n*.tmp\n';
const QUEUE_LOCAL = `# Spool's queue is working state for agents: what you said, word for word, and
# the tasks and decisions that came of it. By default git ignores all of it,
# this file included, so none of it is committed or pushed.
#
# To keep the queue in git instead, for a team or for its history, delete the
# "*" line below, or run:  spool init --refresh --share
${QUEUE_SHARED}*
`;

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
/** Tags are short labels: lower case, words joined by hyphens, so "Level Design" and "level-design" are one tag. */
function tagsOf(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  const given = many(v);
  if (given.length === 1 && given[0] === 'none') return [];
  const tags = given.map((t) => t.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)).filter(Boolean);
  if (!tags.length) throw new SpoolError('a tag needs a letter or a digit', 'spool edit <id> --tag level-design   or   --tag none');
  return uniq(tags);
}

/** A version is whatever the project calls its versions: 0.9.0, 1.2, "spring". One short word. */
function versionOf(v: unknown): string | undefined {
  const given = str(v)?.trim().replace(/^v(?=\d)/, '');
  if (given === undefined) return undefined;
  if (given === 'none') return '';
  if (!/^[\w.+-]{1,24}$/.test(given)) throw new SpoolError(`"${given}" is not a version`, 'One short word, such as 0.9.0 or none');
  return given;
}

/**
 * The project's own check: the command its human named as the proof a change is sound (the tests, a
 * build). It runs before a change can be finished, and a failure refuses the finish. It runs with
 * nothing locked, since tests take as long as they take and the page must stay usable meanwhile.
 */
const CHECK_MINUTES = 30;
interface Checked {
  command: string;
  seconds: number;
}
function runCheck(ctx: Ctx, command: string, cwd: string): Checked {
  const began = Date.now();
  const ran = spawnSync(command, { shell: true, cwd, encoding: 'utf8', timeout: CHECK_MINUTES * 60_000, maxBuffer: 64 * 1024 * 1024, env: ctx.env });
  const seconds = Math.round((Date.now() - began) / 1000);
  if (ran.status === 0) return { command, seconds };
  const tail = `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n  ');
  const how = ran.error ? `could not run (${ran.error.message})` : ran.signal ? `was stopped (${ran.signal})` : `failed (exit ${ran.status})`;
  throw new SpoolError(
    `the check ${how}: ${command}`,
    `It has to pass before this can be finished. Fix what it found and run spool done again.\n  If the check itself is wrong, that is the human's to change: put it to them with spool ask.${tail ? `\n\n  ${tail}` : ''}`,
  );
}

/** What `spool done` found out before the store was locked: the check that passed, and the landing it still holds. */
interface Finishing {
  checked?: Checked;
  landing?: Landing<Checked | undefined>;
}

/** The summary `spool done` was given, as it is kept. */
function summaryOf({ args, opts }: Bare): string {
  return (str(opts.message) ?? args.slice(1).join(' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The steps a person follows to see a change working, from `--steps` (once a step), or one a line
 * from stdin with `--steps -`. A list someone pasted keeps its words, not its numbers or bullets.
 * Undefined when none were given; `none` clears them.
 */
function stepsOf(call: Bare): string[] | undefined {
  const given = raw(call.opts.steps);
  if (!given.length) return undefined;
  if (given.length === 1 && given[0] === 'none') return [];
  const lines = given.length === 1 && given[0] === '-' ? call.ctx.stdin().split('\n') : given;
  const steps = lines.map((l) => oneLine(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), 200)).filter(Boolean);
  if (!steps.length) throw new SpoolError('the steps are empty', 'One short thing a person does or sees, each: --steps "Open the board" --steps "The card is at the top"');
  return steps;
}

/** What `spool done` says of a change that leaves no way to see it working. A courtesy: it never refuses. */
function noSteps(id: string): string {
  return `  No steps to check it by. Add two or three a person can follow in a minute: spool edit ${id} --steps "<step>" --steps "<step>"`;
}

/**
 * What `spool done` does first, with nothing locked: run the check where the thread was worked.
 * For a thread in the project's own checkout that is all. A thread with a worktree of its own is
 * landed here too: rebased onto the checkout, checked there, and the checkout fast-forwarded to it.
 */
function beforeDone(call: Bare): Finishing | undefined {
  const { ctx, args } = call;
  if (!args[0]) return undefined;
  const ws = Workspace.open(ctx.cwd, ctx.now);
  let task: Item;
  try {
    task = ws.find(args[0]) ?? ws.get(args[0], 'task');
  } catch {
    return undefined; // Not something that can be finished: the command itself says why.
  } finally {
    ws.close();
  }
  if (task.kind !== 'task' || task.status === 'done') return undefined;
  // Only a change is checked: an audit or a plan hands in words, and its parts are checked as they are built.
  const command = task.type ? undefined : userConfig(ctx).checks?.[task.spool.root];
  if (task.worktree) {
    // What the command is about to refuse is left for it to refuse, before anything is landed.
    if (isClosed(task) || task.status === 'proposed' || !summaryOf(call)) return undefined;
    const landing = land(task, (cwd) => (command ? runCheck(ctx, command, cwd) : undefined));
    return { checked: landing.checked, landing };
  }
  return command ? { checked: runCheck(ctx, command, task.spool.root) } : undefined;
}

/**
 * The lock. Where a project's gate is locked, the commands that start work are
 * the human's in fact and not only by convention: they run from a terminal a
 * person is sitting at, or from the Spool page on a click, and nowhere else.
 *
 * It stops an agent starting work by mistake, or on its own reading of what
 * the human meant. It is not a security boundary: a program running as the
 * user can do whatever the user can. What it changes is that getting past it
 * takes a deliberate act, where before it took none.
 */
function byTheHuman(call: Call, spools: Spool[], verb: string): void {
  if (call.ctx.tty || call.ctx.human) return;
  const locked = spools.find((s) => s.config.gate === 'locked');
  if (!locked) return;
  throw new SpoolError(
    `spool ${verb} is the human's alone in ${locked.name}: its gate is locked`,
    'They do it on the Spool page (spool page), or type it in their own terminal. Give them the thread\'s link and stop; do not look for a way round.',
  );
}

/** A sprint by its id or by its name, as a person would say it: "sprint 2", "Polish". */
function sprintBy(ws: Workspace, ref: string): Item {
  const named = ws.items.filter((i) => i.kind === 'sprint' && i.status !== 'dropped' && i.title.toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new SpoolError(`${named.length} sprints are called "${ref}"`, `Name one by id: ${named.map((s) => s.id).join(', ')}`);
  return ws.get(ref, 'sprint');
}

/** A sprint is over when everything in it is finished. Nothing else ends one. */
function settleSprint(ws: Workspace, task: Item, actor: string): Item | undefined {
  const sprint = sprintOf(ws, task);
  if (!sprint || sprint.status === 'done') return undefined;
  const inIt = sprintTasks(ws, sprint);
  if (!inIt.length || inIt.some((t) => t.status !== 'done')) return undefined;
  sprint.status = 'done';
  addLog(sprint, actor, `done: all ${inIt.length} finished`, ws.now());
  ws.save(sprint);
  return sprint;
}

/**
 * Take back what a thread did: its commits undone in one new commit, and the calls an
 * agent made for it alone dropped with them. Shared by revert, and by moving a thread
 * back to the backlog with --undo. Throws, changing nothing, if the commits will not come off.
 */
function undoWork(ws: Workspace, t: Item, actor: string, why: string): { reverted: string[]; skipped: { sha: string; why: string }[]; voided: Item[] } {
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
  t.commits = [];
  return { reverted, skipped, voided };
}

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
  const suggested = str(call.opts.suggested)?.replace(/\s+/g, ' ').trim();
  const task = ws.create(spool, 'task', {
    title: oneLine(title, 120),
    priority: priorityOf(call.opts.priority) ?? 2,
    size,
    type: type === 'change' ? undefined : type,
    // An agent's own idea waits for a yes. Where the gate is on, everything does: it starts proposed.
    // Where it is off, the idea goes on hold, like anything else the human has not asked to start.
    hold: str(call.opts.hold)?.replace(/\s+/g, ' ').trim() ?? (suggested && !spool.config.gate ? 'AI suggested: waiting for your yes' : undefined),
    suggested,
    tags: tagsOf(call.opts.tag) ?? [],
    version: versionOf(call.opts.version) || undefined,
    sprint: str(call.opts.sprint) ? sprintBy(ws, str(call.opts.sprint)!).id : undefined,
    from: uniq(from.map((i) => i.id)),
    needs: uniq(needs.map((i) => i.id)),
    body: [...quotes, bodyOf(call)].filter(Boolean).join('\n\n'),
  });
  if (spool.config.gate) {
    task.status = 'proposed';
    ws.save(task);
  }
  for (const note of from) {
    if (note.kind === 'note' && note.status === 'new') {
      note.status = 'filed';
      ws.save(note);
    }
  }
  const out = [`${spool.config.gate ? 'Proposed' : 'Queued'} in ${spool.name}:`, `  ${itemLine(ws, task, p, false)}`];
  if (spool.config.gate) out.push(p.dim(`  It is built only once the human moves it to build: spool build ${task.id}`));
  if (promoted) out.push('Extra-large work starts as a plan, so this was queued as one: it gets split into parts, and the parts get built.');
  const similar = similarTo(ws, task);
  out.push(...similarLines(ws, task, similar, p));
  return { text: out.join('\n'), data: { task: itemJson(ws, task, true), similar: similar.map((m) => ({ ...itemJson(ws, m.item), how: m.how, why: m.why })) } };
}

const WORK: Options = {
  priority: { type: 'string', short: 'p' },
  size: { type: 'string', short: 's' },
  from: { type: 'string', multiple: true },
  needs: { type: 'string', multiple: true },
  body: { type: 'string', short: 'b' },
  project: { type: 'string', short: 'P' },
  hold: { type: 'string' },
  suggested: { type: 'string' },
  tag: { type: 'string', multiple: true },
  version: { type: 'string' },
  sprint: { type: 'string' },
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

/**
 * Claim a thread for whoever is calling. With `worktree`, or where the thread has one from an
 * earlier start, it is given a git worktree of its own to be built in, and that is returned.
 */
function claim(call: Call, task: Item, force: boolean, worktree = false): Opened | undefined {
  const { ws, actor } = call;
  const state = taskState(ws, task);
  if (state === 'done' || state === 'dropped') throw new SpoolError(`${task.id} is already ${state}`);
  if (state === 'proposed') {
    throw new SpoolError(`${task.id} is proposed, not in build`, `Only the human moves it to build: spool build ${task.id}`);
  }
  if (state === 'held') {
    throw new SpoolError(`${task.id} is on hold: ${task.hold}`, `Only the human releases it: spool release ${task.id}`);
  }
  if (state === 'archived') {
    throw new SpoolError(`${task.id} is archived`, `Only the human brings it back: spool archive --undo ${task.id}`);
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
  // Before anything is written: where there can be no worktree, the thread is not claimed either.
  const opened = worktree || task.worktree ? openWorktree(task) : undefined;
  task.status = 'active';
  task.by = actor;
  task.started = timestamp(ws.now());
  // Taken, it has left Build, and its place in line with it.
  task.place = undefined;
  const how = state === 'stale' ? 'picked up after the last claim went quiet' : 'started';
  addLog(task, actor, opened ? `${how}, in its own worktree on ${opened.branch}` : how, ws.now());
  ws.save(task);
  return opened;
}

/** What a start says about the worktree it made or found, under the brief. */
function worktreeNote(task: Item, opened: Opened, p: Paint): string {
  const where = path.relative(task.spool.root, opened.dir);
  const links = opened.linked.length ? ` · ${opened.linked.join(', ')} linked from the checkout, not copied` : '';
  return p.dim(opened.made ? `worktree        made at ${where}, on the branch ${opened.branch}${links}` : `worktree        its own from before, at ${where}, on ${opened.branch}${links}`);
}

/** Take a thread's worktree and branch away, and say what went with them, for its log and for the screen. */
function removeWorktree(task: Item): string {
  const gone = closeWorktree(task);
  if (!gone) return '';
  const lost = gone.lost ? `, with ${gone.lost.commits} commit(s) that never landed (it was at ${gone.lost.tip.slice(0, 7)})` : '';
  return `worktree and branch ${gone.branch} removed${lost}${gone.problem ? `; ${gone.problem}` : ''}`;
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
    name: 'brief',
    group: 'you',
    usage: 'brief [--since <8h | yesterday | a date>] [-P <project>]',
    summary: 'The morning brief: what shipped, what is worth a look, and what needs you, on one screen',
    options: { since: { type: 'string' }, ...PROJECT },
    run({ ws, p, opts }) {
      const b = morning(ws, { since: str(opts.since), project: str(opts.project) });
      return { text: morningText(ws, b, p), data: b };
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
      const { reverted, skipped, voided } = undoWork(ws, t, actor, why);
      // A worktree it still has holds nothing that landed, so it goes too.
      const gone = removeWorktree(t);

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
      addLog(t, actor, `reverted ${reverted.length} commit(s)${why ? `: ${why}` : ''}${gone ? `; ${gone}` : ''}`, ws.now());
      ws.save(t);

      const out: string[] = [];
      if (reverted.length) {
        out.push(`${p.bold(t.id)} reverted — ${reverted.length} commit(s) undone in one new commit.`);
      } else {
        out.push(`${p.bold(t.id)} ${call.opts.drop ? 'dropped' : 'reopened'}. ${root ? 'No commits were tied to it' : 'This is not a git repository'}, so no code was changed.`);
      }
      for (const s of skipped) out.push(p.dim(`  left ${s.sha.slice(0, 7)} alone: ${s.why}`));
      if (gone) out.push(p.dim(`  ${gone}`));
      for (const d of voided) out.push(p.dim(`  dropped the assumption behind it: ${d.id} ${oneLine(d.choice ?? d.title, 60)}`));
      if (orphans.length) out.push(p.dim(`  dropped ${orphans.length} unstarted ${t.type === 'plan' ? 'part(s)' : 'finding(s)'} that came from it`));
      if (!call.opts.drop) out.push(`It is back in the queue at p${t.priority}${why ? ' with your reason attached' : ''}.`);
      // The human's reason outlives the thread: every agent here reads it from now on. An agent's own revert keeps none.
      const lesson = why && actor === 'human' ? keepLesson(t, why, ws.now()) : undefined;
      if (lesson) {
        const n = lessons(ws).findIndex((l) => l.spool === lesson.spool && l.line === lesson.line) + 1;
        out.push(`Your reason is kept as a lesson every agent here reads first. To forget it: spool lessons --drop ${n}`);
      }
      return {
        text: out.join('\n'),
        data: { task: itemJson(ws, t), reverted, skipped, voided: voided.map((d) => d.id), orphans: orphans.map((k) => k.id), lesson: lesson?.words },
      };
    },
  },

  {
    name: 'lessons',
    group: 'you',
    usage: 'lessons [--drop <n>]',
    summary: 'What you undid and why, as every agent reads it; --drop <n> forgets one',
    human: true,
    write: true,
    options: { drop: { type: 'string' } },
    run({ ws, p, opts }) {
      const drop = str(opts.drop);
      if (drop) {
        const gone = dropLesson(ws, Number(drop));
        return { text: `Forgotten: ${lessonLine(ws, gone)}`, data: { dropped: gone.words, thread: gone.thread } };
      }
      const all = lessons(ws);
      if (!all.length) return { text: 'Nothing has been undone here with a reason.', data: { lessons: [] } };
      const width = String(all.length).length;
      const text = [
        ...all.map((l, i) => `${String(i + 1).padStart(width)}  ${lessonLine(ws, l)}`),
        p.dim(`Kept in each project's .spool/policy.md: edit a line there, or spool lessons --drop <n>.`),
      ].join('\n');
      return { text, data: { lessons: all.map((l) => ({ words: l.words, thread: l.thread, date: l.date, project: l.spool.name })) } };
    },
  },
  {
    name: 'goals',
    group: 'you',
    usage: 'goals [--edit <text>|-] [-P <project>]',
    summary: 'Where the project is going, as every agent reads it; --edit replaces it',
    human: true,
    write: true,
    options: { edit: { type: 'string' }, ...PROJECT },
    run(call) {
      const { ws, p, opts } = call;
      const spool = ws.project(str(opts.project));
      const file = goalsFile(spool);
      const where = path.relative(spool.root, file);
      if (typeof opts.edit === 'string') {
        const text = (opts.edit === '-' ? call.ctx.stdin() : opts.edit).trim();
        if (!text) throw new SpoolError('the goals are missing', 'spool goals --edit - with the page on stdin');
        fs.writeFileSync(file, `${text}\n`);
      }
      const goals = goalsOf(spool);
      const text = goalsText(spool);
      const data = { project: spool.name, file, text, set: !!goals, for: goals?.for ?? '', towards: goals?.towards ?? [] };
      if (!goals) {
        return { text: `No goals yet in ${spool.name}. Ask what it is for and where it is heading, then: spool goals --edit -`, data };
      }
      return { text: `${typeof opts.edit === 'string' ? `Goals kept in ${where}:\n\n` : ''}${text}\n${p.dim(`\n${where} · agents read it first · spool goals --edit - replaces it`)}`, data };
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
      byTheHuman(call, tasks.map((t) => t.spool), 'release');
      for (const t of tasks) if (!t.hold) throw new SpoolError(`${t.id} is not on hold`);
      for (const t of tasks) {
        addLog(t, actor, `released from hold (was: ${t.hold})`, ws.now());
        t.hold = undefined;
        ws.save(t);
      }
      return { text: `Released:\n${tasks.map((t) => `  ${itemLine(ws, t, p)}`).join('\n')}`, data: { released: tasks.map((t) => itemJson(ws, t)) } };
    },
  },

  {
    name: 'archive',
    group: 'you',
    usage: 'archive <t-id…> [--undo]',
    summary: 'Put backlog work out of sight, not dropped: off the board and the lists, never built, until you bring it back with --undo or move it to build',
    human: true,
    write: true,
    options: { undo: { type: 'boolean' } },
    run({ ws, args, actor, p, opts }) {
      if (!args.length) throw new SpoolError(`what to ${opts.undo ? 'bring back' : 'archive'} is missing`, opts.undo ? 'See what is archived: spool list --archived' : 'spool archive <t-id>');
      const tasks = args.map((ref) => ws.get(ref, 'task'));
      for (const t of tasks) {
        if (opts.undo) {
          if (!t.archived) throw new SpoolError(`${t.id} is not archived`);
          continue;
        }
        if (isClosed(t)) throw new SpoolError(`${t.id} is already ${t.status}`);
        // Only what is waiting: work being built is stopped first, with its own verb.
        if (t.status === 'active') throw new SpoolError(`${t.id} is being built by ${t.by ?? 'someone'}`, `Stop it first: spool propose --abort ${t.id}`);
      }
      for (const t of tasks) {
        if (opts.undo) {
          t.archived = undefined;
          addLog(t, actor, 'brought back from the archive', ws.now());
        } else {
          if (t.archived) continue;
          t.archived = timestamp(ws.now());
          addLog(t, actor, 'archived', ws.now());
        }
        ws.save(t);
      }
      return {
        text: `${opts.undo ? 'Brought back' : 'Archived'}:\n${tasks.map((t) => `  ${itemLine(ws, t, p)}`).join('\n')}`,
        data: { [opts.undo ? 'restored' : 'archived']: tasks.map((t) => itemJson(ws, t)) },
      };
    },
  },
  {
    name: 'build',
    group: 'you',
    usage: 'build <t-id…> [--abort]',
    summary: 'Move proposed work to build: it may be built now, in its turn. --abort takes it off whoever is building it, back to waiting in build',
    human: true,
    write: true,
    options: { abort: { type: 'boolean' } },
    run(call) {
      const { ws, args, actor, p } = call;
      if (!args.length) throw new SpoolError('what to build is missing', 'spool build <t-id>');
      const tasks = args.map((ref) => ws.get(ref, 'task'));
      byTheHuman(call, tasks.map((t) => t.spool), 'build');
      for (const t of tasks) {
        const state = taskState(ws, t);
        if (state === 'done' || state === 'dropped') throw new SpoolError(`${t.id} is already ${state}`);
        if (state === 'active' && !call.opts.abort) throw new SpoolError(`${t.id} is being built already`, `Take it off whoever has it: spool build --abort ${t.id}`);
      }
      for (const t of tasks) {
        if (t.status === 'active') {
          // Stopped, the work so far kept, its worktree with it: it waits in build for its turn again.
          addLog(t, actor, `stopped while ${t.by ?? 'someone'} was building it; back in build`, ws.now());
          t.status = 'open';
          t.by = undefined;
          ws.save(t);
          continue;
        }
        // Moving something to build is the human saying start: it clears a hold as well, and brings back an archived thread.
        if (t.status !== 'proposed' && !t.hold && !t.archived) continue;
        addLog(t, actor, t.hold ? `moved to build (was on hold: ${t.hold})` : t.archived ? 'moved to build (was archived)' : 'moved to build', ws.now());
        if (t.status === 'proposed') t.status = 'open';
        t.hold = undefined;
        t.archived = undefined;
        ws.save(t);
      }
      return { text: `In build:\n${tasks.map((t) => `  ${itemLine(ws, t, p)}`).join('\n')}`, data: { build: tasks.map((t) => itemJson(ws, t)) } };
    },
  },
  {
    name: 'sprint',
    group: 'agents',
    usage:
      'sprint <name…> [--goal <what it is for>] [--why <why now>] [--done-when <what will be true>] [--serves <a goal, in a few words>] [--vision <their words>|- | --from <n-id>] [--add <t-id…>] [-P <project>]',
    summary: 'Make a sprint, a named set of work to build together with a goal and no dates; or fill one that exists',
    write: true,
    options: {
      goal: { type: 'string' },
      why: { type: 'string' },
      'done-when': { type: 'string' },
      serves: { type: 'string' },
      vision: { type: 'string' },
      from: { type: 'string' },
      add: { type: 'string', multiple: true },
      ...PROJECT,
    },
    run(call) {
      const { ws, p, actor } = call;
      // `--add t-a t-b`: the ids after the first arrive as words of the name, and are taken back out.
      const named: string[] = [];
      const adding = many(call.opts.add);
      for (const arg of call.args) (call.opts.add !== undefined && /^t-[a-z0-9]+$/i.test(arg) && ws.find(arg.toLowerCase())?.kind === 'task' ? adding : named).push(arg);
      const name = oneLine(words(call, named, 'the sprint\'s name', 'spool sprint "Sprint 1"'), 60);
      const spool = str(call.opts.project) ? ws.project(str(call.opts.project)) : ws.home;
      const threads = uniq(adding.map((ref) => ws.get(ref, 'task')));
      const closed = threads.find((t) => t.status === 'done' || t.status === 'dropped');
      if (closed) throw new SpoolError(`${closed.id} is ${closed.status}`, 'A sprint holds the work still to do.');
      if (str(call.opts.vision) && str(call.opts.from)) throw new SpoolError('give the vision once: --vision or --from', 'spool sprint "<name>" --from <note-id>');
      const vision = str(call.opts.vision) === '-' ? call.ctx.stdin().trim() : str(call.opts.vision)?.trim();
      if (str(call.opts.vision) === '-' && !vision) throw new SpoolError('the vision is missing', 'Pipe their words in: spool sprint "<name>" --vision -');
      const note = str(call.opts.from) ? ws.get(str(call.opts.from)!, 'note') : undefined;

      const existing = ws.items.find((i) => i.kind === 'sprint' && i.spool === spool && i.status !== 'dropped' && i.title.toLowerCase() === name.toLowerCase());
      if (existing?.status === 'done') throw new SpoolError(`${existing.title} is finished`, 'Put the work in another sprint, or make one: spool sprint "<name>"');
      const sprint = existing ?? ws.create(spool, 'sprint', { title: name });
      const changed: string[] = [];
      // The human's words for it come first, quoted and signed, the way a thread keeps its note.
      if (note) {
        addQuote(sprint, quoteNote(note));
        sprint.from = uniq([...sprint.from, note.id]);
        if (note.status === 'new') {
          note.status = 'filed';
          ws.save(note);
        }
        changed.push('vision');
      } else if (vision) {
        addQuote(sprint, visionQuote(vision, timestamp(ws.now()).slice(0, 10)));
        changed.push('vision');
      }
      // What the sprint is for is its body, in the same three lines a thread's spec has.
      // And which of the project's goals it serves, in a few words.
      for (const [opt, label] of [['goal', 'Goal'], ['why', 'Why'], ['done-when', 'Done when'], ['serves', 'Serves']] as const) {
        if (!str(call.opts[opt])) continue;
        setLine(sprint, label, oneLine(str(call.opts[opt])!, 300));
        changed.push(label.toLowerCase());
      }
      const added: Item[] = [];
      for (const t of threads) {
        if (t.sprint === sprint.id) continue;
        const moved = sprintOf(ws, t);
        t.sprint = sprint.id;
        addLog(t, actor, moved ? `moved from the sprint ${moved.title} to ${sprint.title}` : `put in the sprint ${sprint.title}`, ws.now());
        ws.save(t);
        added.push(t);
      }
      if (added.length) changed.push(`${added.length} added`);
      if (existing && !changed.length) throw new SpoolError(`there is already a sprint called "${name}"`, `Fill it: spool sprint "${name}" --add <t-id…>`);
      if (existing) addLog(sprint, actor, `edited: ${changed.join(', ')}`, ws.now());
      ws.save(sprint);

      const about = sprintAbout(sprint);
      const out = [existing ? `Sprint ${sprint.title}: ${changed.join(', ')}.` : `Sprint made in ${spool.name}:`, `  ${itemLine(ws, sprint, p, false)}`];
      for (const t of added) out.push(`    ${itemLine(ws, t, p, false)}`);
      if (!about.goal) out.push(p.dim(`  say what it is for: spool sprint "${sprint.title}" --goal "…" --why "…" --done-when "…"`));
      if (!sprintTasks(ws, sprint).length) out.push(p.dim(`  put work in it: spool sprint "${sprint.title}" --add <t-id…>`));
      // A sprint being played takes in new work, and the human's play is still what starts it.
      if (sprint.status === 'running' && added.some((t) => t.status === 'proposed' || t.hold)) {
        out.push(p.dim(`  it is running: what was added waits in the backlog until the human presses play again (spool play ${sprint.id})`));
      } else if (sprint.status === 'planned') out.push(p.dim(`  the human starts it: spool play ${sprint.id}`));
      return { text: out.join('\n'), data: { sprint: itemJson(ws, sprint), added: added.map((t) => t.id), made: !existing } };
    },
  },
  {
    name: 'play',
    group: 'you',
    usage: 'play <sprint>',
    summary: 'Start a sprint: everything in it moves to build',
    human: true,
    write: true,
    run(call) {
      const { ws, args, actor, p } = call;
      if (!args.length) throw new SpoolError('which sprint is missing', 'spool play <sprint id or name>');
      const sprint = sprintBy(ws, args.join(' '));
      byTheHuman(call, [sprint.spool], 'play');
      if (sprint.status === 'done') throw new SpoolError(`${sprint.title} is finished`);
      const inIt = sprintTasks(ws, sprint);
      if (!inIt.length) throw new SpoolError(`${sprint.title} is empty`, `Put work in it first: spool edit <t-id> --sprint ${sprint.id}`);
      const moved: Item[] = [];
      for (const t of inIt) {
        // Playing a sprint is the human saying start, for each thing in it: the same as moving each to build.
        if (t.status !== 'proposed' && !t.hold) continue;
        addLog(t, actor, `moved to build with the sprint ${sprint.title}`, ws.now());
        if (t.status === 'proposed') t.status = 'open';
        t.hold = undefined;
        ws.save(t);
        moved.push(t);
      }
      if (sprint.status !== 'running') {
        sprint.status = 'running';
        addLog(sprint, actor, `started: ${inIt.length} in it`, ws.now());
        ws.save(sprint);
      }
      const out = [`${p.bold(sprint.title)} is running: ${moved.length} moved to build.`, ...moved.map((t) => `  ${itemLine(ws, t, p)}`)];
      return { text: out.join('\n'), data: { sprint: itemJson(ws, sprint), build: moved.map((t) => t.id) } };
    },
  },
  {
    name: 'checks',
    group: 'setup',
    usage: 'checks [<command…> | --none] [-P <project>]',
    summary: 'Name the command that must pass before a change can be finished here (your tests, a build); kept on your machine',
    human: true,
    options: { none: { type: 'boolean' }, ...PROJECT },
    run({ ws, ctx, args, opts }) {
      const spool = str(opts.project) ? ws.project(str(opts.project)) : ws.home;
      const now = userConfig(ctx).checks?.[spool.root];
      if (!args.length && !opts.none) {
        return {
          text: now
            ? `${spool.name} is checked with: ${now}\n  It runs before every spool done on a change there, and a failure refuses it.`
            : `${spool.name} has no check: a change is done when the agent says so.\n  Name one: spool checks "npm test"`,
          data: { project: spool.name, check: now ?? null },
        };
      }
      // An agent may name a check where there is none, on the human's word. Changing or removing one is
      // the human's alone: a check an agent can switch off proves nothing.
      if (now && !ctx.tty && !ctx.human) {
        throw new SpoolError(
          `the check for ${spool.name} is the human's to change`,
          'They type it in their own terminal. If the check is wrong, put it to them with spool ask; do not work round it.',
        );
      }
      const command = opts.none ? '' : args.join(' ').trim();
      const file = saveUserConfig(ctx, (config) => {
        const checks = { ...(config.checks ?? {}) };
        if (command) checks[spool.root] = command;
        else delete checks[spool.root];
        config.checks = checks;
      });
      return {
        text: command
          ? `${spool.name} is now checked with: ${command}\n  Kept in ${file}, on this machine, not in the project.`
          : `${spool.name} has no check any more.`,
        data: { project: spool.name, check: command || null },
      };
    },
  },
  {
    name: 'builder',
    group: 'setup',
    usage: 'builder [headless | chat] [--at-once <n>] [-P <project>]',
    summary: 'Say who builds here: the page, starting agents (headless), or a Claude Code chat running the loop; --at-once sets how many threads at the same time. With nothing after it, says what is set',
    human: true,
    options: { 'at-once': { type: 'string' }, ...PROJECT },
    run(call) {
      const { ws, ctx, args, opts } = call;
      if (args.length > 1) throw new SpoolError('too many words', 'spool builder [headless | chat] [--at-once <n>]');
      const spool = str(opts.project) ? ws.project(str(opts.project)) : ws.home;
      return builderCommand(ctx, spool, args[0], str(opts['at-once']), () => byTheHuman(call, [spool], 'builder'));
    },
  },
  {
    name: 'agents',
    group: 'setup',
    usage: 'agents [on | off] [-P <project>]',
    summary: 'Switch the page\'s agents on or off, the same switch as the one on the page. With nothing after it, says whether a page is up and its agents are on. The human\'s, like spool build',
    human: true,
    options: { ...PROJECT },
    run(call) {
      const { ws, ctx, args, opts } = call;
      if (args.length > 1) throw new SpoolError('too many words', 'spool agents [on | off]');
      const spool = str(opts.project) ? ws.project(str(opts.project)) : ws.home;
      return agentsCommand(ctx, spool, args[0], () => byTheHuman(call, [spool], 'agents on'));
    },
  },
  {
    name: 'doctor',
    group: 'setup',
    usage: 'doctor',
    summary: 'Check what a run needs (a git repository, an agent, a check, the skills) and say exactly what is missing; changes nothing',
    bare: (call) => doctor(call),
  },
  {
    name: 'propose',
    group: 'you',
    usage: 'propose <t-id…> [--abort] [--undo]',
    summary:
      'Take work back to proposed: nothing builds it until you say. --abort takes it off whoever is building it, and removes its worktree; --undo also undoes its commits, even once it is done',
    human: true,
    write: true,
    options: { abort: { type: 'boolean' }, undo: { type: 'boolean' } },
    run({ ws, args, actor, p, opts }) {
      if (!args.length) throw new SpoolError('what to move back is missing', 'spool propose <t-id>');
      const tasks = args.map((ref) => ws.get(ref, 'task'));
      // Undoing a thread's work takes it off whoever has it, as aborting does.
      const abort = opts.abort || opts.undo;
      for (const t of tasks) {
        if (t.status === 'dropped') throw new SpoolError(`${t.id} is already dropped`);
        if (t.status === 'done' && !opts.undo) throw new SpoolError(`${t.id} is already done`, `Undo it and move it back: spool propose --undo ${t.id}`);
        if (t.status === 'active' && !abort) {
          throw new SpoolError(`${t.id} is being built by ${t.by ?? 'someone'}`, `Let it finish, or abort it: spool propose --abort ${t.id}`);
        }
      }
      const undone: Record<string, string[]> = {};
      const removed: string[] = [];
      for (const t of tasks) {
        // The commits come off first: if they will not, the thread is left where it was.
        const reverted = opts.undo ? undoWork(ws, t, actor, 'moved back to the backlog').reverted : [];
        if (opts.undo) undone[t.id] = reverted;
        // Work in a worktree of its own never landed: taken off its builder, it goes with the worktree.
        const gone = abort ? removeWorktree(t) : '';
        if (gone) removed.push(p.dim(`  ${t.id}: ${gone}`));
        const was = t.status;
        if (was === 'proposed' && !reverted.length && !gone) {
          if (opts.undo) ws.save(t);
          continue;
        }
        // Aborting: whoever was building it is off it, and it waits in the backlog for a yes.
        const by = was === 'active' ? (t.by ?? 'someone') : undefined;
        t.status = 'proposed';
        t.by = undefined;
        t.place = undefined;
        if (was === 'done') {
          t.summary = undefined;
          t.reviewed = undefined;
        }
        const how = by ? `aborted while ${by} was building it; moved back to proposed` : was === 'proposed' ? 'still proposed' : 'moved back to proposed';
        addLog(t, actor, [reverted.length ? `${how}; reverted ${reverted.length} commit(s)` : how, gone].filter(Boolean).join('; '), ws.now());
        ws.save(t);
      }
      const notes = Object.entries(undone)
        .filter(([, shas]) => shas.length)
        .map(([id, shas]) => p.dim(`  ${id}: ${shas.length} commit(s) undone in one new commit`));
      return {
        text: [`Proposed:`, ...tasks.map((t) => `  ${itemLine(ws, t, p)}`), ...notes, ...removed].join('\n'),
        data: { proposed: tasks.map((t) => itemJson(ws, t)), reverted: undone },
      };
    },
  },
  {
    name: 'order',
    group: 'you',
    usage: 'order <t-id> --first | --last | --before <t-id> | --after <t-id>',
    summary: 'Say where work in build is in line: the top of Build is built next',
    human: true,
    write: true,
    options: { first: { type: 'boolean' }, last: { type: 'boolean' }, before: { type: 'string' }, after: { type: 'string' } },
    run(call) {
      const { ws, p, actor, opts } = call;
      const usage = 'spool order <t-id> --first | --last | --before <t-id> | --after <t-id>';
      const t = first(call, 'which thread', 'task');
      const before = str(opts.before);
      const after = str(opts.after);
      if ([opts.first, opts.last, before, after].filter(Boolean).length !== 1) throw new SpoolError('say where it goes, once', usage);
      const state = taskState(ws, t);
      if (!IN_BUILD.includes(state)) {
        if (state === 'proposed' || state === 'held') throw new SpoolError(`${t.id} is not in build`, `Move it there first: spool build ${t.id}`);
        if (state === 'active') throw new SpoolError(`${t.id} is being built already`);
        throw new SpoolError(`${t.id} is already ${state}`);
      }
      const line = buildLine(ws, t.spool);
      const rest = line.filter((x) => x !== t);
      const placed = rest.filter((x) => x.place !== undefined).length;
      let at = opts.first ? 0 : rest.length;
      let where = opts.first ? 'first' : 'last';
      const ref = before ?? after;
      if (ref) {
        const other = ws.get(ref, 'task');
        if (other === t) throw new SpoolError('a thread cannot go next to itself', usage);
        const i = rest.indexOf(other);
        if (i < 0) throw new SpoolError(`${other.id} is not in build${other.spool === t.spool ? '' : ` in ${t.spool.name}`}`, 'Place it next to work in the same Build column');
        at = before ? i : i + 1;
        where = `${before ? 'before' : 'after'} ${other.id}`;
      }
      rest.splice(at, 0, t);
      // Everything above it keeps the order it had, now as places of its own; what was placed below it stays placed.
      const upto = Math.max(placed, at) + 1;
      for (const [i, x] of rest.entries()) {
        const want = i < upto ? i + 1 : undefined;
        if (x !== t && x.place === want) continue;
        x.place = want;
        if (x === t) addLog(t, actor, `placed ${where} in build`, ws.now());
        ws.save(x);
      }
      const out = [`${p.bold(t.id)} is ${at + 1} of ${rest.length} in build.`];
      const waits = blockers(ws, t);
      if (waits.length) out.push(p.dim(`  It waits on ${waits.map((b) => b.id).join(', ')}, and takes its place once that is settled.`));
      out.push('In the order it will be built:', ...rest.map((x, i) => `  ${i + 1}. ${itemLine(ws, x, p)}`));
      return { text: out.join('\n'), data: { task: itemJson(ws, t), order: rest.map((x) => x.id) } };
    },
  },

  // ---- the agents' side ----------------------------------------------------
  {
    name: 'prime',
    group: 'agents',
    usage: 'prime [worker|recorder] [--context]',
    summary: 'What a role needs before it starts: its rules, and this project now (--context: just the project)',
    options: { context: { type: 'boolean' } },
    run({ ws, args, opts }) {
      const role = (args[0] ?? 'worker') as Role;
      if (role !== 'worker' && role !== 'recorder') throw new SpoolError(`no role "${args[0]}"`, 'spool prime worker   or   spool prime recorder');
      const text = prime(ws, role, !!opts.context);
      return { text, data: { role, protocol: text } };
    },
  },
  {
    name: 'next',
    group: 'agents',
    usage: 'next [--claim [--worktree]] [-P <project>]',
    summary: 'The most important ready task, with all its context; --claim --worktree gives it a git worktree of its own to be built in',
    write: true,
    options: { claim: { type: 'boolean', short: 'c' }, worktree: { type: 'boolean' }, ...PROJECT },
    run(call) {
      const { ws, p } = call;
      if (call.opts.worktree && !call.opts.claim) throw new SpoolError('--worktree goes with --claim', 'spool next --claim --worktree');
      const project = str(call.opts.project);
      const list = ready(ws, project);
      const task = list[0];
      if (!task) return { text: nothingReady(ws, project), data: { task: null, ready: 0 } };
      const opened = call.opts.claim ? claim(call, task, true, !!call.opts.worktree) : undefined;
      const out = [brief(ws, task, p)];
      if (opened) out.push(worktreeNote(task, opened, p));
      if (!call.opts.claim) out.push(p.dim(`claim it        spool start ${task.id}`));
      if (list.length > 1) out.push(p.dim(`${list.length - 1} more ready behind it`));
      return { text: out.join('\n'), data: { task: itemJson(ws, task, true), brief: brief(ws, task, p), ready: list.length } };
    },
  },
  {
    name: 'start',
    group: 'agents',
    usage: 'start <t-id> [--worktree] [--force]',
    summary: 'Claim a specific task; --worktree gives it a git worktree of its own, so several can be built at once',
    write: true,
    options: { force: { type: 'boolean' }, worktree: { type: 'boolean' } },
    run(call) {
      const t = first(call, 'which task', 'task');
      const opened = claim(call, t, !!call.opts.force, !!call.opts.worktree);
      const out = [brief(call.ws, t, call.p)];
      if (opened) out.push(worktreeNote(t, opened, call.p));
      return { text: out.join('\n'), data: { task: itemJson(call.ws, t, true) } };
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
    usage: 'done <t-id> -m <what changed> [--steps <step>…|-] [--report <file>|-] [--commit <ref>…] [--skill <name>…]',
    summary: 'Finish a task: record how to undo a change, or hand in the report of an audit or plan; work in a worktree of its own is landed on the checkout first',
    write: true,
    options: {
      ...MESSAGE,
      commit: { type: 'string', multiple: true },
      skill: { type: 'string', multiple: true },
      report: { type: 'string' },
      steps: { type: 'string', multiple: true },
    },
    reads: 'report',
    before: beforeDone,
    after: (before) => (before as Finishing | undefined)?.landing?.release(),
    run(call) {
      const { ws, p, actor } = call;
      const { checked, landing } = (call.before as Finishing | undefined) ?? {};
      const t = first(call, 'which task', 'task');
      if (isClosed(t)) throw new SpoolError(`${t.id} is already ${t.status}`);
      // Taken back to the backlog while it was being built: the human said stop, so it is not finished by whoever was on it.
      if (t.status === 'proposed') throw new SpoolError(`${t.id} was moved back to the backlog`, 'Leave it: nothing builds it until the human moves it to build again');
      const type = t.type ?? 'change';
      const summary = summaryOf(call);
      if (!summary) {
        throw new SpoolError(
          'the summary is missing',
          `The human reads it in their review: spool done ${t.id} -m "<what changed, and how to see it>"`,
        );
      }
      // Its work is in a worktree, and was not landed a moment ago: finishing now would throw it away.
      if (t.worktree && !landing) throw new SpoolError(`${t.id} changed while it was being finished`, 'Run spool done again');

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
        if (raw(call.opts.steps).join() === '-') throw new SpoolError('only one of --report and --steps can be read from stdin', 'Give the steps with --steps "<step>", once each');
      } else if (type !== 'change' && !fs.existsSync(reportPath)) {
        throw new SpoolError(
          `${type === 'audit' ? 'an audit' : 'a plan'} is finished by its report`,
          `spool done ${t.id} -m "<the headline>" --report - <<'EOF' … EOF      (or --report <file>)`,
        );
      }

      const steps = stepsOf(call);
      const root = repoRoot(t.spool.root);
      const commits = new Set(t.commits);
      for (const ref of many(call.opts.commit)) {
        if (!root) throw new SpoolError(`${t.spool.name} is not a git repository, so --commit means nothing here`);
        const sha = resolveCommit(root, ref);
        if (!sha) throw new SpoolError(`no commit "${ref}" in ${root}`);
        commits.add(sha);
      }
      if (root) for (const sha of trailerCommits(root, t.id)) if (!isReverted(root, sha)) commits.add(sha);
      // What came off its own branch is its work, trailer or no trailer.
      for (const sha of landing?.commits ?? []) commits.add(sha);

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
      t.place = undefined;
      t.checked = checked?.command;
      if (checked) addLog(t, actor, `check passed: ${checked.command} (${checked.seconds}s)`, ws.now());
      t.summary = summary;
      if (steps) t.steps = steps;
      t.commits = [...commits];
      t.skills = uniq([...t.skills, ...used]);
      addLog(t, actor, `done: ${summary}`, ws.now());
      ws.save(t);
      // Landed and on record, so the worktree holds nothing the checkout lacks: it goes, and its branch with it.
      const gone = landing ? removeWorktree(t) : '';
      if (gone) ws.save(t);
      const finished = settleSprint(ws, t, actor);

      const kids = children(ws, t).filter((k) => k.status !== 'dropped');
      const gated = kids.filter((k) => k.needs.includes(t.id) && k.status === 'open');
      const ready = uniq([...dependents(ws, t), ...kids]).filter((r) => taskState(ws, r) === 'ready');
      const out = [`${p.bold(t.id)} done.`];
      if (checked) out.push(p.green(`  check passed: ${checked.command} (${checked.seconds}s)${landing ? ', in its worktree' : ''}`));
      if (landing) {
        out.push(
          landing.commits.length
            ? p.green(`  landed ${landing.commits.length} commit(s) on ${landing.onto}`)
            : p.dim(`  nothing to land: its worktree had no commits ${landing.onto} lacks`),
          p.dim(`  ${gone}: work from ${t.spool.root} now`),
        );
      }
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
      if (type === 'change' && !t.steps.length) out.push(p.yellow(noSteps(t.id)));
      if (commits.size) out.push(p.dim(`  ${commits.size} commit(s) on record — spool revert ${t.id} would undo them`));
      else if (root && type === 'change') {
        out.push(p.yellow(`  No commits found for it. Without the "Spool: ${t.id}" trailer or --commit, it cannot be reverted.`));
      }
      if (finished) {
        out.push(
          p.green(`  Sprint finished: ${finished.title}. Everything in it is done.`),
          `  A sprint reached is a version: cut it now, the changelog led by its name and goal, then spool edit ${finished.id} --version <x.y.z>`,
        );
      }
      if (ready.length) out.push('Now ready:', ...ready.map((r) => `  ${itemLine(ws, r, p)}`));
      // The third time the same steps are finished with no skill is the moment to say so: this agent still knows them.
      const again = suggestSkills(ws, ws.home).find((c) => c.tasks.includes(t));
      const before = again?.tasks.filter((x) => x !== t).map((x) => x.id) ?? [];
      if (again) out.push(`  The same steps as ${before.join(', ')}, with no skill for them. Offer one: spool skills --suggest`);
      else out.push(p.dim('  A procedure worth keeping? spool skill add <name> -d "<when to use it>" --from ' + t.id + ' -b -'));
      return {
        text: out.join('\n'),
        data: {
          task: itemJson(ws, t),
          unblocked: ready.map((r) => r.id),
          children: kids.map((k) => k.id),
          notified: told,
          repeats: before,
          sprintFinished: finished?.id ?? null,
          ...(landing ? { landed: landing.commits, onto: landing.onto } : {}),
        },
      };
    },
  },
  {
    name: 'task',
    aliases: ['add'],
    group: 'agents',
    usage: 'task <title…> [-s xs|s|m|l|xl] [-p 0-3] [-t change|audit|plan] [--hold <why>] [--suggested <why>] [--sprint <sprint>] [--from <id>…] [--needs <id>…] [-b <body>] [-P <project>]',
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
    usage: 'edit <id> [--title <t>] [-p 0-3] [-s size] [-t type] [--model <m>|none] [--effort <e>|none] [--tag <tag>…|none] [--version <v>|none] [--sprint <sprint>|none] [--steps <step>…|-|none] [-b <body>] [--needs <id>…|none] [--reopen]',
    summary: 'Change an item',
    write: true,
    options: {
      title: { type: 'string' },
      priority: { type: 'string', short: 'p' },
      size: { type: 'string', short: 's' },
      type: { type: 'string', short: 't' },
      model: { type: 'string' },
      effort: { type: 'string' },
      needs: { type: 'string', multiple: true },
      reopen: { type: 'boolean' },
      tag: { type: 'string', multiple: true },
      version: { type: 'string' },
      sprint: { type: 'string' },
      steps: { type: 'string', multiple: true },
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
      const model = modelOf(call.opts.model);
      const effort = effortOf(call.opts.effort);
      if ((model !== undefined || effort !== undefined) && item.kind !== 'task') throw new SpoolError('only tasks have a model and an effort');
      if (model !== undefined) {
        item.model = model || undefined;
        changed.push(model ? `model ${model}` : 'model left to Fable, or its size');
      }
      if (effort !== undefined) {
        item.effort = effort || undefined;
        changed.push(effort ? `effort ${effort}` : 'effort left to Fable, or its size');
      }
      const tags = tagsOf(call.opts.tag);
      const version = versionOf(call.opts.version);
      if (tags && item.kind !== 'task') throw new SpoolError('only tasks have tags');
      // A sprint reached is a version: it records the one it became.
      if (version !== undefined && item.kind !== 'task' && item.kind !== 'sprint') throw new SpoolError('only tasks and sprints have a version');
      if (tags) {
        item.tags = tags;
        changed.push(tags.length ? `tags ${tags.join(', ')}` : 'tags cleared');
      }
      if (version !== undefined) {
        item.version = version || undefined;
        changed.push(version ? `version ${version}` : 'version cleared');
        // Its finished threads shipped in that version too, unless one already says otherwise.
        const stamped = item.kind === 'sprint' && version ? sprintTasks(ws, item).filter((t) => t.status === 'done' && !t.version) : [];
        for (const t of stamped) {
          t.version = version;
          addLog(t, actor, `version ${version}, with the sprint ${item.title}`, ws.now());
          ws.save(t);
        }
        if (stamped.length) changed.push(`${stamped.length} of its threads stamped`);
      }
      if (str(call.opts.sprint)) {
        if (item.kind !== 'task') throw new SpoolError('only tasks go in a sprint');
        if (str(call.opts.sprint) === 'none') {
          item.sprint = undefined;
          changed.push('out of its sprint');
        } else {
          const sprint = sprintBy(ws, str(call.opts.sprint)!);
          if (sprint.status === 'done') throw new SpoolError(`${sprint.title} is finished`, 'Put it in another sprint, or make one: spool sprint "<name>"');
          item.sprint = sprint.id;
          changed.push(`sprint ${sprint.title}`);
        }
      }
      if (raw(call.opts.steps).join() === '-' && call.opts.body === '-') throw new SpoolError('only one of --body and --steps can be read from stdin');
      const steps = stepsOf(call);
      if (steps) {
        if (item.kind !== 'task') throw new SpoolError('only tasks have steps to check them by');
        item.steps = steps;
        changed.push(steps.length ? `${steps.length} step(s) to check it by` : 'steps cleared');
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
        // Reopened work is new work as far as the gate goes: it waits to be moved to build again.
        item.status = item.kind === 'task' ? (item.spool.config.gate ? 'proposed' : 'open') : 'new';
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
        if (item.kind === 'task') {
          item.by = undefined;
          item.place = undefined;
        }
        // Abandoned, so the work in a worktree of its own is abandoned with it.
        const gone = item.kind === 'task' ? removeWorktree(item) : '';
        addLog(item, actor, `dropped${why ? `: ${why}` : ''}${gone ? `; ${gone}` : ''}`, ws.now());
        ws.save(item);
        if (gone) out.push(`  ${item.id}: ${gone}`);
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
        // On hold sits with the backlog, out of Build's line.
        t.place = undefined;
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
    run({ ws, ctx, p, opts }) {
      const project = str(opts.project);
      const spools = project ? [ws.project(project)] : ws.spools;
      const queue = review(ws, project);
      const standing = new Map(spools.map((spool) => [spool, standingOf(ctx, ws, spool)]));
      return {
        text: statusText(ws, p, project, (spool) => standingLines(standing.get(spool)!)),
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
              board: standing.get(spool),
            };
          }),
          waiting: Object.fromEntries(Object.entries(queue).map(([key, items]) => [key, (items as Item[]).length])),
        },
      };
    },
  },
  {
    name: 'overview',
    aliases: ['ov'],
    group: 'see',
    usage: 'overview [<project>] [--brief | --table]',
    summary: 'A project\'s whole spool 🧶, each thread 🧵 under its colour; --brief is a few lines for a chat, --table the numbered list',
    options: { ...PROJECT, table: { type: 'boolean' }, brief: { type: 'boolean' } },
    run({ ws, p, args, opts }) {
      const ref = str(opts.project) ?? str(args.join(' ').trim());
      const spools = ref ? [ws.project(ref)] : ws.spools;
      const json = (items: Item[]) => items.map((i) => itemJson(ws, i));
      return {
        // --table is the loop's list: every thread numbered, as markdown for a chat.
        // --brief is the spool in a few lines, for a chat; the page has the rest.
        text: opts.brief ? overviewTable(ws, spools, true) : opts.table ? overviewTable(ws, spools) : overviewText(ws, spools, p),
        data: {
          workspace: ws.home.name,
          projects: spools.map((spool) => {
            const d = docket(ws, spool);
            return {
              rows: tableRows(ws, d).map((r) => ({ n: r.n, id: r.item.id, title: r.item.title, mark: r.mark, note: r.note })),
              name: spool.name,
              path: spool.root,
              needsYou: json(d.needsYou),
              breakDown: json(d.breakDown),
              blocked: json(d.blocked),
              active: json(d.active),
              ready: json(d.ready),
              proposed: json(d.proposed),
              suggested: json(d.suggested),
              held: json(d.held),
              done: d.done,
              also: d.also,
            };
          }),
        },
      };
    },
  },
  {
    name: 'list',
    aliases: ['ls'],
    group: 'see',
    usage: 'list [-k <kind>] [-s <state>] [-t <type>] [--size <sizes>] [--search <words>] [-P <project>] [--all | --archived | --alike]',
    summary: 'Find items; closed ones too with --all or --search; only the archived threads with --archived; open threads that look alike with --alike',
    options: {
      kind: { type: 'string', short: 'k' },
      status: { type: 'string', short: 's' },
      type: { type: 'string', short: 't' },
      size: { type: 'string' },
      search: { type: 'string' },
      all: { type: 'boolean', short: 'a' },
      archived: { type: 'boolean' },
      alike: { type: 'boolean' },
      ...PROJECT,
    },
    run({ ws, p, opts }) {
      const spool = str(opts.project) ? ws.project(str(opts.project)) : undefined;
      if (opts.alike) {
        const pairs = alikeIn(ws, spool);
        return { text: alikeLines(ws, pairs, p).join('\n'), data: { pairs: pairs.map((m) => ({ a: itemJson(ws, m.a), b: itemJson(ws, m.b), score: Math.round(m.score * 100) / 100, words: m.words })) } };
      }
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
      if (opts.archived) items = items.filter((i) => stateOf(ws, i) === 'archived');
      else if (status) items = items.filter((i) => stateOf(ws, i) === status || (i.status === status && stateOf(ws, i) !== 'archived'));
      else if (search) items = items.filter((i) => i.status !== 'dropped');
      // Archived threads are out of sight: they are listed when asked for, by --archived or --all.
      else if (!opts.all) items = items.filter((i) => !isClosed(i) && stateOf(ws, i) !== 'archived');
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
    usage: 'show <id> [--report]',
    summary: 'One item in full; --report gives the text of its report, for an agent that cannot open the file',
    options: { report: { type: 'boolean' } },
    run(call) {
      const item = first(call, 'which item');
      if (call.opts.report) {
        let report: string;
        try {
          report = fs.readFileSync(reportFile(item), 'utf8').trim();
        } catch {
          throw new SpoolError(`${item.id} has no report`, 'An audit or plan has one once it is done');
        }
        return { text: report, data: { id: item.id, report } };
      }
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
    usage: 'skills [--suggest [-P <project>]]',
    summary: 'Every skill in the workspace: where it came from, how often it is used; --suggest lists steps finished tasks keep repeating with no skill',
    options: { suggest: { type: 'boolean' }, ...PROJECT },
    run({ ws, p, opts }) {
      if (opts.suggest) {
        const found = suggestSkills(ws, ws.project(str(opts.project)));
        return {
          text: suggestText(ws, found, p),
          data: { candidates: found.map(candidateJson), needs: { tasks: SUGGEST.minTasks, terms: SUGGEST.minTerms } },
        };
      }
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
        sprint: (t) => `[/"${t}"/]`,
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
          // The human agrees to work by its reason, so an open thread with none is worth a word. An idea an agent
          // suggested carries its reason with it.
          if (!isClosed(item) && !item.archived && !whyOf(item) && !item.suggested) {
            warnings.push(`${item.id} has no Why: line in its spec, so nobody can see why it exists`);
          }
          if (taskState(ws, item) === 'stale') warnings.push(`${item.id} was claimed by ${item.by ?? 'someone'} and has gone quiet`);
          if (item.priority !== undefined && (item.priority < 0 || item.priority > 3)) errors.push(`${item.id} has priority ${item.priority}`);
        }
        // Once a project has goals, each sprint says which one it is for, so the work stays on them.
        if (item.kind === 'sprint' && (item.status === 'planned' || item.status === 'running') && goalsOf(item.spool) && !sprintAbout(item).serves) {
          warnings.push(`${item.id} (${item.title}) names no goal it serves: spool sprint "${item.title}" --serves "<a goal, in a few words>"`);
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
    usage: 'init [<folder>] [--name <name>] [--about <one line>] [--gate | --lock] [--share] [--no-agents-file] [--refresh]',
    summary: 'Start a spool here, or in a folder named here, ignored by git unless --share; does nothing where one exists',
    options: {
      name: { type: 'string' },
      about: { type: 'string' },
      'no-agents-file': { type: 'boolean' },
      refresh: { type: 'boolean' },
      share: { type: 'boolean' },
      gate: { type: 'boolean' },
      lock: { type: 'boolean' },
    },
    bare({ ctx, args, opts, p }) {
      // A folder may be named the way a person says it: "sky hop" finds games/sky_hop.
      const named = args.length ? findFolder(ctx.cwd, args.join(' ')) : ctx.cwd;
      // Inside a thread's worktree, the project is the one the worktree belongs to: its copy of the queue is never set up or read.
      const root = worktreeOwner(named) ?? named;
      const dir = path.join(root, SPOOL_DIR);
      const where = path.relative(ctx.cwd, root);
      const wrote: string[] = [];
      const write = (file: string, text: string, overwrite = false): void => {
        if (!overwrite && fs.existsSync(file)) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        wrote.push(path.relative(root, file));
      };

      const fresh = !fs.existsSync(path.join(dir, 'config.json'));
      // Run by accident where a spool exists, this changes nothing. --refresh is the deliberate version:
      // after an upgrade, it brings the agents' pointer up to date and puts back anything missing.
      if (!fresh && !opts.refresh && !opts.share && !opts.gate && !opts.lock) {
        const name = readConfig(root).name ?? path.basename(root);
        return {
          text: [
            `Spool is already set up in ${p.bold(name)}${where ? p.dim(`  · ${where}`) : ''}. Nothing was changed.`,
            p.dim(`  see where it stands: spool overview${where ? ` -C ${where}` : ''}`),
          ].join('\n'),
          data: { root, created: false, wrote },
        };
      }
      const parent = findHome(path.dirname(root));
      if (fresh) {
        const config: Config = { version: 1, name: str(opts.name) ?? path.basename(root) };
        if (str(opts.about)) config.about = str(opts.about);
        if (opts.gate) config.gate = true;
        if (opts.lock) config.gate = 'locked';
        write(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
      } else if ((opts.lock && readConfig(root).gate !== 'locked') || (opts.gate && !readConfig(root).gate)) {
        // Turning the gate on, or locking it, for a project that has a spool: one key, nothing else touched.
        // --gate never loosens a lock; taking a lock off is done by hand, in the file, by a person.
        write(path.join(dir, 'config.json'), `${JSON.stringify({ ...readConfig(root), gate: opts.lock ? 'locked' : true }, null, 2)}\n`, true);
      }
      write(path.join(dir, 'policy.md'), DEFAULT_POLICY);
      write(path.join(dir, 'goals.md'), GOALS_STARTER);
      // An existing .gitignore is someone's choice and is kept; --share is the one thing that rewrites it.
      write(path.join(dir, '.gitignore'), opts.share ? QUEUE_SHARED : QUEUE_LOCAL, !!opts.share);
      fs.mkdirSync(path.join(dir, 'items'), { recursive: true });
      const config = readConfig(root);
      const spool: Spool = { root, dir, name: config.name ?? path.basename(root), home: true, config };

      if (!opts['no-agents-file']) {
        const present = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(root, f)));
        for (const name of present.length ? present : ['AGENTS.md']) {
          const file = path.join(root, name);
          const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
          const after = upsertBlock(before);
          if (after !== before) write(file, after, true);
        }
      }

      const out = [
        fresh
          ? `Spool is set up in ${p.bold(spool.name)}${where ? p.dim(`  · ${where}`) : ''}.`
          : `${p.bold(spool.name)}: ${wrote.length ? 'refreshed.' : 'already up to date.'}`,
      ];
      if (wrote.length) out.push(...wrote.map((f) => p.dim(`  wrote ${f}`)));
      if (fresh && parent) out.push(`It sits under ${path.basename(parent)} and shows up there as a project.`);
      const local = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').includes('*');
      if (config.gate && (fresh || opts.gate || opts.lock)) {
        out.push('The build gate is on: new work starts as proposed, and nothing is built until you move it to build.');
      }
      if (config.gate === 'locked' && (fresh || opts.lock)) {
        out.push('It is locked: moving work to build takes you, on the Spool page or at your own terminal. An agent is refused.');
      }
      if (fresh || opts.share) {
        out.push(
          local
            ? `The queue stays on this machine: git ignores ${SPOOL_DIR}/.  ${p.dim('(spool init --refresh --share keeps it in git)')}`
            : `The queue is kept in git with the rest of the project: ${SPOOL_DIR}/ is not ignored.`,
        );
      }
      const skills = installedAnywhere(ctx, root);
      if (!skills) out.push('', 'The Spool skills are not installed for your agent yet. Once per machine:  spool install');
      if (fresh) {
        out.push(
          '',
          'Next, in your agent. You should not need this command line again.',
          '  /spool-page       the board: every thread, and where you move the ones you want built into build',
          '  /spool-loop       the loop: it builds what is in build, thread after thread, and tells you when it needs you',
          '  /spool-record     put it in front of anything you type or say, and that message is filed as threads',
          `  ${path.join(SPOOL_DIR, 'policy.md')} says what agents may decide without you — worth two minutes.`,
          `  ${path.join(SPOOL_DIR, 'goals.md')} says where the project is heading: your agent asks you, in one question.`,
        );
      }
      return { text: out.join('\n'), data: { root, created: fresh, wrote, skills, shared: !local } };
    },
  },
  {
    name: 'demo',
    group: 'setup',
    usage: 'demo [<folder>] [--open]',
    summary: 'Make a throwaway sample project with threads in its spool, to try the page and the loop on; --open opens its board',
    options: { open: { type: 'boolean' } },
    bare: (call) => demo(call),
  },
  {
    name: 'install',
    group: 'setup',
    usage: 'install [--for claude|codex|cursor|gemini|all] [--here | --dir <skills directory>] [--force]',
    summary: 'Put the Spool skills where your agent finds them (Claude Code unless --for names another); run it again after upgrading',
    options: { for: { type: 'string' }, here: { type: 'boolean' }, dir: { type: 'string' }, force: { type: 'boolean' } },
    bare({ ctx, opts, p }) {
      if (opts.here && str(opts.dir)) throw new SpoolError('--here and --dir both say where', 'Use one of them');
      // Default: Claude Code, in the person's own skills, seen from every project. --here: this project's, to check in for a team.
      const asked = str(opts.for) ?? 'claude';
      const all = asked.toLowerCase() === 'all';
      if (all && str(opts.dir)) throw new SpoolError('--dir names one folder, and --for all is several harnesses', 'Name one harness with --for, or leave --dir out');
      // All is Claude Code and every other harness found here: Spool does not make folders for an agent you do not have.
      const targets = all ? [harness('claude'), ...others(ctx)] : [harness(asked)];
      const done = targets.map((h) => installFor(ctx, h, { here: !!opts.here, dir: str(opts.dir), force: !!opts.force }));
      const out = targets.flatMap((h, i) => [...(i ? [''] : []), ...describe(ctx, h, done[i]!, p)]);
      if (all) {
        const missing = HARNESSES.filter((h) => !targets.includes(h));
        if (missing.length) out.push('', p.dim(`Not found on this machine: ${missing.map((h) => h.label).join(', ')}. --for <name> installs for one anyway.`));
      } else if (!str(opts.for)) {
        const seen = others(ctx);
        if (seen.length) {
          out.push('', 'Also on this machine:');
          for (const h of seen) out.push(`  ${h.label.padEnd(12)}  spool install --for ${h.name}`);
        }
      }
      const data = done.length === 1 && !all ? { dir: done[0]!.dir, skills: done[0]!.skills, harness: done[0]!.harness } : { harnesses: done };
      return { text: out.join('\n'), data };
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
  {
    name: 'page',
    group: 'setup',
    usage: 'page [-d | --status | --stop] [--run] [--agent <command>] [--port <n>] [--no-open] [-P <project>]',
    summary: 'Open the Spool page: the board where the human moves work to build; --run has the page build it too, with no chat; -d runs it in the background',
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      run: { type: 'boolean' },
      agent: { type: 'string' },
      detach: { type: 'boolean', short: 'd' },
      status: { type: 'boolean' },
      stop: { type: 'boolean' },
      ...PROJECT,
    },
    bare: (call) => servePage(call),
  },
  {
    name: 'watch',
    group: 'setup',
    usage: 'watch [--interval <ms>] [-P <project>]',
    summary: 'Stay up and print a line when work lands in build, the human replies on a thread, or a note arrives',
    options: { interval: { type: 'string' }, ...PROJECT },
    bare: (call) => watch(call),
  },
  {
    name: 'mcp',
    group: 'setup',
    usage: 'mcp',
    summary: 'Serve the verbs as MCP tools over stdio, for agents with no shell',
    bare: (call) => serve(call),
  },
];
