/**
 * An overview of the whole project: where it is going, what to build together next, and in what
 * order the sprint being played is built.
 *
 * A tidy (manage.ts) looks at threads one by one. An overview looks at all of it at once: the goals,
 * what shipped, the sprints and the backlog. It is a manager's run like a tidy, opened with
 * `spool manage --start --overview`, but it changes nothing itself. Everything it would do goes on
 * its thread as a numbered proposal (proposals.ts), for the user's yes or no:
 *
 *   goals    a new goals page                    a yes keeps it, as `spool goals --edit`
 *   sprint   a sprint drafted, with its threads   a yes makes it, planned, as `spool sprint`
 *   order    an order for a running sprint        a yes puts its threads in Build in that order, as `spool order`
 *
 * Spool gathers the facts here, in plain code; the agent judges.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMANDS, type Call } from './commands.ts';
import { goalsOf, goalsText } from './goals.ts';
import { lessons } from './lessons.ts';
import { handsOffIn } from './manage.ts';
import { type Item, type Spool, SpoolError, isRun, oneLine } from './model.ts';
import type { Proposal, SprintDraft } from './proposals.ts';
import { type Paint, itemLine, paint } from './render.ts';
import { IN_BUILD, buildLine, sprintOf, sprintTasks, taskState, tasks } from './schedule.ts';
import type { Workspace } from './store.ts';

export const OVERVIEW = {
  /** Versions of the changelog shown, newest first. */
  versions: 3,
  /** Finished threads shown, and how far back. */
  finished: 12,
  finishedDays: 30,
  /** Backlog threads listed one by one; past this, only counted. */
  listed: 60,
  /** Sprints an overview may draft. */
  sprints: 3,
} as const;

const DAY = 86_400_000;

export const OVERVIEW_SPEC = `What: an overview of the whole project. From the code, the goals, what shipped, the sprints and the backlog, it proposes where the project goes next, drafts sprints, and suggests the order of each running sprint.
Why: so the direction is set from the whole picture, and the user only says yes or no.
Done when: its proposals are on this thread, each answered yes or no, and undoing this thread takes back what the run itself changed.`;

interface Ref {
  id: string;
  title: string;
  state: string;
  size: string | null;
  priority: number;
  tags: string[];
}

export interface Direction {
  run: string;
  project: string;
  goals: { set: boolean; text: string };
  shipped: {
    versions: { version: string; headlines: string[]; lines: number }[];
    finished: { id: string; title: string; when: string; summary: string | null }[];
  };
  sprints: { id: string; title: string; status: string; goal: string; threads: Ref[]; build: string[] }[];
  backlog: { count: number; bySize: Record<string, number>; byTag: Record<string, number>; loose: Ref[] };
  lessons: { words: string; thread: string | null; date: string | null }[];
  handsOff: { id: string; title: string; why: string }[];
}

/** The changelog's newest versions: each heading, its bold headlines, and how many lines it has. */
function versionsOf(spool: Spool): Direction['shipped']['versions'] {
  const file = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md'].map((name) => path.join(spool.root, name)).find((f) => fs.existsSync(f));
  if (!file) return [];
  const out: Direction['shipped']['versions'] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(raw);
    if (heading) {
      if (out.length === OVERVIEW.versions) break;
      out.push({ version: heading[1]!.trim(), headlines: [], lines: 0 });
      continue;
    }
    const v = out.at(-1);
    if (!v) continue;
    const bold = /^\*\*(.+?)\*\*/.exec(raw.trim());
    if (bold) v.headlines.push(bold[1]!.replace(/:$/, ''));
    if (/^\s*[-*]\s+/.test(raw)) v.lines++;
  }
  return out;
}

/** Everything the overview says, as data. Reads the spool and the changelog; writes nothing. */
export function gatherDirection(ws: Workspace, spool: Spool, run: Item): Direction {
  const now = ws.now().getTime();
  const mine = tasks(ws, spool).filter((t) => !isRun(t));
  const state = (t: Item) => taskState(ws, t);
  const ref = (t: Item): Ref => ({ id: t.id, title: t.title, state: state(t), size: t.size ?? null, priority: t.priority ?? 2, tags: t.tags });
  const line = buildLine(ws, spool);

  const finished = mine
    .filter((t) => t.status === 'done' && now - Date.parse(t.updated) < OVERVIEW.finishedDays * DAY)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, OVERVIEW.finished)
    .map((t) => ({ id: t.id, title: t.title, when: t.updated.slice(0, 10), summary: t.summary ?? null }));

  const sprints = ws.items
    .filter((i) => i.kind === 'sprint' && i.spool === spool && (i.status === 'running' || i.status === 'planned'))
    .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || a.created.localeCompare(b.created))
    .map((s) => {
      const threads = sprintTasks(ws, s);
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        goal: /^Goal:\s*(.*)$/m.exec(s.body)?.[1]?.trim() ?? '',
        threads: threads.map(ref),
        build: line.filter((t) => threads.includes(t)).map((t) => t.id),
      };
    });

  const open = mine.filter((t) => ['proposed', 'held'].includes(state(t)));
  const loose = open.filter((t) => !sprintOf(ws, t)).sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || a.created.localeCompare(b.created));
  const count = (keys: string[]) => keys.reduce<Record<string, number>>((all, k) => ({ ...all, [k]: (all[k] ?? 0) + 1 }), {});

  return {
    run: run.id,
    project: spool.name,
    goals: { set: !!goalsOf(spool), text: goalsText(spool) },
    shipped: { versions: versionsOf(spool), finished },
    sprints,
    backlog: { count: open.length, bySize: count(open.map((t) => t.size ?? 'no size')), byTag: count(open.flatMap((t) => t.tags)), loose: loose.map(ref) },
    lessons: lessons(ws)
      .filter((l) => l.spool === spool)
      .map((l) => ({ words: l.words, thread: l.thread ?? null, date: l.date ?? null })),
    handsOff: handsOffIn(ws, spool),
  };
}

/** What an overview may propose, and how: printed at the top of its worksheet. */
export const OVERVIEW_RULES = [
  'An overview proposes, and changes nothing itself. Read the code and the README as well as what follows, then put each proposal on this thread for the user\'s yes or no:',
  '  Direction  at most one:   spool manage --propose goals --edit - -m "<why>"          the whole goals page on stdin: what it is for, and what it heads towards next',
  `  Sprints    up to ${OVERVIEW.sprints}:      spool manage --propose sprint "<name>" --goal "<goal>" --why "<why now>" --done-when "<what will be true>" --add <t-id…> -m "<why>"`,
  '  Order      one for each running sprint with two or more threads in Build:   spool manage --propose order <sprint> <t-id…> -m "<why>"   first built first',
  'Draft a sprint only from threads in no sprint, and never one hands off. Each proposal names what it builds on: a goal, a thread, what shipped. A yes runs it as the user; a no leaves things as they are.',
  'End with: spool manage --end -m "<the headline: what you propose, in numbers>" --report -',
];

/** The overview's worksheet as an agent reads it. */
export function directionText(ws: Workspace, d: Direction, p: Paint): string {
  const head = (title: string, note = '') => `${p.bold(title)}${note ? p.dim(`  ${note}`) : ''}`;
  const thread = (r: Ref) => {
    const item = ws.find(r.id);
    const off = d.handsOff.find((h) => h.id === r.id);
    return `${item ? itemLine(ws, item, paint(false), false).replace(r.id, p.bold(r.id)) : `${p.bold(r.id)}  ${oneLine(r.title, 78)}`}${off ? p.dim(`  · hands off: ${off.why}`) : ''}`;
  };
  const tally = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ') || 'none';
  const out: string[] = [`SPOOL_RUN=${d.run}`, `Set it on every command of this run, so one undo takes back all of it:  export SPOOL_RUN=${d.run}`, ''];
  out.push(...OVERVIEW_RULES.map((l, i) => (i === 0 ? p.bold(l) : l)), '');
  out.push(`${p.bold(`An overview of ${d.project}`)}${p.dim('  facts, gathered the same way every time. The judgment is yours.')}`, '');

  out.push(head('GOALS', d.goals.set ? 'as kept now' : 'none set yet: propose them'));
  out.push(...(d.goals.set ? d.goals.text.split('\n').map((l) => `  ${l}`) : ['  (no goals page)']), '');

  out.push(head('SHIPPED LATELY'));
  if (!d.shipped.versions.length && !d.shipped.finished.length) out.push('  Nothing yet.');
  for (const v of d.shipped.versions) {
    out.push(`  ${v.version}${p.dim(`  ${v.lines} lines`)}`);
    for (const h of v.headlines) out.push(`    ${oneLine(h, 100)}`);
  }
  if (d.shipped.finished.length) {
    out.push(`  Finished in the last ${OVERVIEW.finishedDays} days, ${d.shipped.finished.length}:`);
    for (const f of d.shipped.finished) out.push(`    ${f.id}  ${f.when}  ${oneLine(f.summary ?? f.title, 90)}`);
  }
  out.push('');

  out.push(head('SPRINTS', 'running first, then planned'));
  if (!d.sprints.length) out.push('  None open.');
  for (const s of d.sprints) {
    out.push(`  ${p.bold(s.id)}  ${s.title}  · ${s.status}${s.goal ? ` · ${oneLine(s.goal, 80)}` : ''}`);
    for (const t of s.threads) out.push(`    ${thread(t)}`);
    if (s.status === 'running') out.push(p.dim(`    in Build now, first built first: ${s.build.join(', ') || 'none'}`));
  }
  out.push('');

  const b = d.backlog;
  out.push(head('THE BACKLOG', `${b.count} proposed or on hold · ${b.loose.length} in no sprint`));
  out.push(`  by size  ${tally(b.bySize)}`, `  by tag   ${tally(b.byTag)}`);
  if (b.loose.length) out.push('  In no sprint, most urgent first:');
  for (const t of b.loose.slice(0, OVERVIEW.listed)) out.push(`    ${thread(t)}`);
  if (b.loose.length > OVERVIEW.listed) out.push(p.dim(`    and ${b.loose.length - OVERVIEW.listed} more: spool list -s proposed`));
  out.push('');

  out.push(head('UNDONE, AND WHY', 'hold every proposal against these'));
  out.push(...(d.lessons.length ? d.lessons.map((l) => `  "${l.words}"${l.thread ? p.dim(`  (${[l.thread, l.date].filter(Boolean).join(', ')})`) : ''}`) : ['  Nothing yet.']));
  return out.join('\n');
}

// --------------------------------------------------------------- proposals

const ID = /^t-[a-z0-9]+$/i;

/** A sprint by its id or its name. */
function sprintIn(ws: Workspace, spool: Spool, ref: string): Item {
  const named = ws.items.filter((i) => i.kind === 'sprint' && i.spool === spool && i.status !== 'dropped' && i.title.toLowerCase() === ref.trim().toLowerCase());
  if (named.length === 1) return named[0]!;
  return ws.get(ref, 'sprint');
}

function threadsIn(ws: Workspace, spool: Spool, refs: string[]): Item[] {
  const out = [...new Set(refs.flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean))].map((r) => ws.get(r, 'task'));
  for (const t of out) {
    if (t.spool !== spool) throw new SpoolError(`${t.id} is in another project`);
    if (isRun(t)) throw new SpoolError(`${t.id} is a manager's run, not a thread`);
    if (t.status === 'done' || t.status === 'dropped') throw new SpoolError(`${t.id} is already ${t.status}`);
  }
  return out;
}

/** What an overview proposes, read from `spool manage --propose goals|sprint|order …`: checked now, and run only on a yes. */
export function proposeWhole(call: Call, run: Item, verb: 'goals' | 'sprint' | 'order', args: string[]): Omit<Proposal, 'n' | 'reason'> {
  const { ws, opts, ctx } = call;
  const spool = run.spool;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (verb === 'goals') {
    if (args.length) throw new SpoolError('new goals are the whole page, given with --edit', 'spool manage --propose goals --edit - -m "<why>", the page on stdin');
    const page = text(opts.edit) === '-' ? ctx.stdin().trim() : text(opts.edit);
    if (!page) throw new SpoolError('the goals are missing', 'spool manage --propose goals --edit - -m "<why>", the page on stdin');
    return { verb, id: '', title: 'The goals', goals: page };
  }
  if (verb === 'sprint') {
    // `--add t-a t-b`: the ids after the first arrive as words of the name, and are taken back out.
    const adding = [opts.add].flat().filter((x): x is string => typeof x === 'string');
    const named: string[] = [];
    for (const a of args) (ID.test(a) && ws.find(a.toLowerCase())?.kind === 'task' ? adding : named).push(a);
    const name = oneLine(named.join(' '), 60);
    if (!name) throw new SpoolError("the sprint's name is missing", 'spool manage --propose sprint "<name>" --goal "<goal>" --add <t-id…> -m "<why>"');
    const goal = text(opts.goal);
    if (!goal) throw new SpoolError('a sprint drafted needs its goal', `spool manage --propose sprint "${name}" --goal "<what it is for>"`);
    if (ws.items.some((i) => i.kind === 'sprint' && i.spool === spool && i.status !== 'dropped' && i.title.toLowerCase() === name.toLowerCase())) {
      throw new SpoolError(`there is already a sprint called "${name}"`, 'Name the new one something else');
    }
    const threads = threadsIn(ws, spool, adding);
    const inBuild = threads.find((t) => !['proposed', 'held'].includes(taskState(ws, t)));
    if (inBuild) throw new SpoolError(`${inBuild.id} is not in the backlog: a drafted sprint takes threads still to be moved to build`);
    const sprint: SprintDraft = { name, goal, why: text(opts.why), doneWhen: text(opts['done-when']), threads: threads.map((t) => t.id) };
    return { verb, id: '', title: name, sprint };
  }
  const [ref, ...rest] = args;
  if (!ref) throw new SpoolError('which sprint, and in what order?', 'spool manage --propose order <sprint> <t-id…> -m "<why>"');
  const sprint = sprintIn(ws, spool, ref);
  if (sprint.status !== 'running') throw new SpoolError(`${sprint.title} is ${sprint.status}: an order is for a sprint being played`);
  const threads = threadsIn(ws, spool, rest);
  if (threads.length < 2) throw new SpoolError('an order needs two threads or more', 'spool manage --propose order <sprint> <t-id> <t-id…> -m "<why>"');
  const stray = threads.find((t) => t.sprint !== sprint.id);
  if (stray) throw new SpoolError(`${stray.id} is not in ${sprint.title}`);
  return { verb, id: sprint.id, title: sprint.title, order: threads.map((t) => t.id) };
}

/** A yes to an order: the sprint's threads in Build take it, after whatever is above them, by `spool order`. */
export function applyOrder(call: Call, x: Proposal): string {
  const { ws } = call;
  const sprint = ws.get(x.id, 'sprint');
  const order = COMMANDS.find((c) => c.name === 'order')!;
  const line = buildLine(ws, sprint.spool);
  const want = (x.order ?? []).map((id) => ws.find(id)).filter((t): t is Item => !!t && IN_BUILD.includes(taskState(ws, t)) && line.includes(t));
  if (want.length < 2) return `nothing to order: ${want.length ? 'only one' : 'none'} of its threads is in Build now`;
  const top = [...want].sort((a, b) => line.indexOf(a) - line.indexOf(b))[0]!;
  if (top !== want[0]) order.run!({ ...call, args: [want[0]!.id], opts: { before: top.id } });
  for (let i = 1; i < want.length; i++) order.run!({ ...call, args: [want[i]!.id], opts: { after: want[i - 1]!.id } });
  return `${want.length} of ${sprint.title}'s threads put in that order in Build`;
}
