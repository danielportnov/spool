/**
 * Output, written for two readers: an agent paying per token and a human
 * glancing at a phone. Both want the same thing — the one screen that matters,
 * with the next command spelled out. Every view has a `--json` twin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, type Spool, firstLine, isPlan, isSettled, oneLine, reportFile, splitBody, whyOf } from './model.ts';
import { type Docket, type Review, blockers, children, dependents, docket, ready, review, sprintOf, sprintTasks, stateOf, taskState, tasks } from './schedule.ts';
import { lessonLine, lessonsFor } from './lessons.ts';
import { BUILT_IN, fileFor, ledgerFor, matchSkills } from './skills.ts';
import { sprintAbout } from './sprints.ts';
import { goalsOf } from './goals.ts';
import { type Picture, picturesOf } from './pictures.ts';
import { type Candidate, SUGGEST, addLine, offerLine } from './suggest.ts';
import type { Workspace } from './store.ts';
import { workDir } from './worktree.ts';
import { handoffBrief, handoffOf } from './handoff.ts';

// Where the page and the commands have always found it.
export { sprintAbout };

export interface Paint {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
}

export function paint(on: boolean): Paint {
  const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
  };
}

const MARK: Record<string, string> = {
  proposed: '◇',
  planned: '▫',
  running: '▸',
  ready: '○',
  active: '▶',
  stale: '▷',
  blocked: '◌',
  held: '⏸',
  archived: '▪',
  done: '✓',
  dropped: '✗',
  open: '?',
  assumed: '≈',
  decided: '✓',
  new: '✎',
  filed: '·',
};

export function age(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 90) return 'now';
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129_600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The report of an audit or plan, relative to its project, if one has been handed in. */
export function reportOf(item: Item): string | null {
  const file = reportFile(item);
  return fs.existsSync(file) ? path.relative(item.spool.root, file) : null;
}

/** How far the work that came out of an audit or plan has got. */
export function progress(ws: Workspace, item: Item): { done: number; total: number; text: string } | null {
  if (item.kind !== 'task' || !item.type) return null;
  const kids = children(ws, item).filter((k) => k.status !== 'dropped');
  if (!kids.length) return null;
  const done = kids.filter((k) => k.status === 'done').length;
  return { done, total: kids.length, text: `${done}/${kids.length} ${item.type === 'plan' ? 'parts' : 'findings'} done` };
}

/** A plan that is written and waiting on the human before its parts may start. */
function awaitsGoAhead(ws: Workspace, item: Item): boolean {
  return isPlan(item) && item.status === 'done' && !item.reviewed && dependents(ws, item).some((t) => t.status === 'open');
}

function tag(task: Item): string {
  return `p${task.priority ?? 2}${task.size ? ` ${task.size.toUpperCase()}` : ''}`;
}

export function itemLine(ws: Workspace, item: Item, p: Paint, showProject = true): string {
  const state = stateOf(ws, item);
  const head = [`${item.kind === 'skill' ? '◆' : (MARK[state] ?? '·')} ${p.bold(item.id)}`];
  if (item.kind === 'task') head.push(tag(item));
  head.push(`${item.kind === 'task' && item.type ? `${item.type}: ` : ''}${oneLine(item.title, 78)}`);
  const notes: string[] = [];
  if (item.kind === 'task') {
    if (state === 'blocked') notes.push(`needs ${blockers(ws, item).map((b) => b.id).join(', ')}`);
    if (state === 'proposed') notes.push(item.suggested ? 'proposed · AI suggested' : 'proposed');
    if (state === 'held') notes.push(`on hold: ${oneLine(item.hold ?? '', 60)}`);
    if (state === 'archived') notes.push(age(item.archived!, ws.now()) === 'now' ? 'archived just now' : `archived ${age(item.archived!, ws.now())} ago`);
    if (state === 'active') notes.push(`${item.by ?? 'someone'}, ${age(item.updated, ws.now())}`);
    if (state === 'stale') notes.push(`${item.by ?? 'someone'} went quiet ${age(item.updated, ws.now())} ago`);
    const handed = item.status === 'open' ? handoffOf(item) : null;
    if (handed) notes.push(`handed off${handed.to ? ` to ${handed.to}` : ''} by ${handed.by}`);
    if (state === 'done' || state === 'dropped') notes.push(awaitsGoAhead(ws, item) ? 'awaiting go-ahead' : state);
    const made = progress(ws, item);
    if (made) notes.push(made.text);
    const sprint = sprintOf(ws, item);
    if (sprint) notes.push(sprint.title);
    if (item.version) notes.push(`v${item.version}`);
    if (item.tags.length) notes.push(item.tags.map((t) => `#${t}`).join(' '));
  } else if (item.kind === 'sprint') {
    const inIt = sprintTasks(ws, item);
    notes.push(item.status, `${inIt.filter((t) => t.status === 'done').length} of ${inIt.length} done`);
    const serves = sprintAbout(item).serves;
    if (serves) notes.push(`serves ${oneLine(serves, 60)}`);
    if (item.version) notes.push(`v${item.version}`);
  } else if (item.kind === 'decision') {
    notes.push(item.choice ? `${item.status}: ${oneLine(item.choice, 48)}` : item.status);
  } else if (item.status !== 'new' && item.status !== 'active') {
    notes.push(item.status);
  }
  if (showProject && ws.spools.length > 1) notes.push(item.spool.name);
  return `${head.join('  ')}${notes.length ? p.dim(`  · ${notes.join(' · ')}`) : ''}`;
}

/** Everything a worker needs to do one task, and nothing else. */
export function brief(ws: Workspace, task: Item, p: Paint): string {
  const { main, log } = splitBody(task.body);
  const type = task.type ?? 'change';
  const out = [
    `${p.bold(task.id)}  ${tag(task)}  ${p.bold(`${task.type ? `${task.type}: ` : ''}${task.title}`)}`,
    p.dim(`${task.spool.name} · work in ${workDir(task)}`),
  ];
  // The agent is told where its desk is: a worktree looks like the project, and so does the project.
  if (task.worktree) {
    out.push(`WORKTREE — this thread has a checkout of its own there, on the branch ${task.branch}. Work and commit only in it; spool done lands it on the project's branch.`);
  }
  if (task.status === 'proposed') out.push(p.yellow('PROPOSED — not in build. Do not start it; only the human moves it to build.'));
  if (task.hold) out.push(p.yellow(`ON HOLD — ${task.hold}. Do not start it; only the human releases it.`));
  // Handed off by an agent that ran out of usage: the one carrying it on reads where it stopped first.
  out.push(...handoffBrief(task).map((line) => p.yellow(line)));
  if (main) out.push('', main);

  // What finishing means depends on the type of work, so the brief says it outright.
  if (type === 'audit') {
    out.push(
      '',
      'THIS IS AN AUDIT — look, think, report. Do not fix things here.',
      `  each finding     spool task "<the finding>" --from ${task.id} --size <xs|s|m|l|xl> [-p 0-3]`,
      `  then the report  spool done ${task.id} -m "<the headline>" --report - <<'EOF' … EOF`,
    );
  } else if (type === 'plan') {
    out.push(
      '',
      'THIS IS A PLAN — work out how. Do not build it here.',
      `  each part        spool task "<the part>" --from ${task.id} --size <xs|s|m|l> [--needs <an earlier part>]`,
      '                   Smallest pieces that can ship on their own, in the order they should land.',
      `                   If the policy says the human should see this first, add --needs ${task.id} to every part.`,
      `  then the plan    spool done ${task.id} -m "<the approach, in a sentence>" --report - <<'EOF' … EOF`,
    );
  } else if (task.size === 'l' || task.size === 'xl') {
    out.push('', `THIS IS LARGE. If it will not fit in one sitting, do not start building: spool edit ${task.id} --type plan, and split it.`);
  }

  for (const source of task.from.map((id) => ws.find(id))) {
    if (!source || source.kind !== 'task') continue;
    out.push('', isPlan(source) ? 'PART OF' : 'CAME FROM');
    out.push(`  ${source.id}  ${source.title}${source.summary ? ` — ${firstLine(source.summary)}` : ''}`);
    const made = progress(ws, source);
    const report = reportOf(source);
    if (made) out.push(p.dim(`      ${made.text}`));
    if (report) out.push(p.dim(`      read ${path.relative(task.spool.root, path.join(source.spool.root, report))}`));
  }

  // The human undid this work, or the work it came from, and said why: the brief says it again.
  const undone = lessonsFor(ws, task);
  if (undone.length) {
    out.push('', 'UNDONE BEFORE, AND WHY — do not do it again');
    for (const l of undone) out.push(`  ${lessonLine(ws, l)}`);
  }

  const needs = task.needs.map((id) => ws.find(id)).filter((i): i is Item => !!i);
  const decisions = needs.filter((i) => i.kind === 'decision');
  if (decisions.length) {
    out.push('', 'DECISIONS');
    for (const d of decisions) {
      if (d.status === 'open') out.push(`  ${d.id}  ${d.title}  — unanswered; this task waits on it`);
      else if (d.status === 'assumed') {
        out.push(`  ${d.id}  ${d.title}  → ${d.choice}  (an agent's call; the human may still overrule it)`);
      } else if (d.status === 'decided') out.push(`  ${d.id}  ${d.title}  → ${d.choice}`);
    }
  }
  const after = needs.filter((i) => i.kind === 'task');
  if (after.length) {
    out.push('', 'COMES AFTER');
    for (const t of after) out.push(`  ${t.id}  ${t.title}  (${stateOf(ws, t)})${t.summary ? ` — ${firstLine(t.summary)}` : ''}`);
  }

  const skills = matchSkills(ws, task);
  if (skills.length) {
    out.push('', 'SKILLS THAT MAY HELP');
    for (const s of skills) {
      out.push(`  ${s.name} — ${oneLine(s.description, 100)}`);
      out.push(p.dim(`      ${path.join(path.relative(task.spool.root, s.dir), 'SKILL.md')}`));
    }
  }
  // What the human pasted to show what he means: the agent opens these to see it.
  const kept = picturesOf(task);
  const pictures = kept.filter((k) => k.kind === 'picture');
  const files = kept.filter((k) => k.kind === 'file');
  if (pictures.length) out.push('', 'PICTURES — open each one: they show what is meant', ...pictures.map((pic) => `  ${pictureLine(pic)}`));
  if (files.length) out.push('', 'FILES — read each one: they were added for this', ...files.map((f) => `  ${pictureLine(f)}`));
  if (log.length) out.push('', 'LOG', ...log.slice(-8).map((l) => `  ${l}`));
  if (type === 'change') out.push('', p.dim(`commit trailer  Spool: ${task.id}      finish  spool done ${task.id} -m "<what changed>"`));
  return out.join('\n');
}

/** A picture as a brief or `spool show` lists it: where it is, and who attached it with what words. */
function pictureLine(pic: Picture): string {
  const about = [pic.as, pic.by, pic.caption && `“${pic.caption}”`].filter(Boolean).join(' · ');
  return `${pic.path}${about ? `  (${about})` : ''}`;
}

/** `under` gives the lines to print beneath a project's count: where its board stands. */
export function statusText(ws: Workspace, p: Paint, project?: string, under: (spool: Spool) => string[] = () => []): string {
  const spools = project ? [ws.project(project)] : ws.spools;
  const out: string[] = [];
  if (ws.spools.length > 1) out.push(p.bold(ws.home.name) + p.dim(` · ${plural(ws.spools.length, 'project')}`));

  const queue = review(ws, project);
  const waiting: string[] = [];
  if (queue.questions.length) {
    const held = new Set(queue.questions.flatMap((d) => dependents(ws, d).filter((t) => !isSettled(t)).map((t) => t.id)));
    waiting.push(p.yellow(`${plural(queue.questions.length, 'question')} blocking ${plural(held.size, 'thread')}`));
  }
  if (queue.plans.length) waiting.push(p.yellow(`${plural(queue.plans.length, 'plan')} awaiting your go-ahead`));
  if (queue.assumptions.length) waiting.push(plural(queue.assumptions.length, 'assumption'));
  if (queue.shipped.length) waiting.push(`${queue.shipped.length} shipped`);
  if (queue.skills.length) waiting.push(plural(queue.skills.length, 'new skill'));
  if (queue.inbox.length) waiting.push(`${queue.inbox.length} unfiled`);
  out.push(waiting.length ? `for you: ${waiting.join(' · ')}  ${p.dim('→ spool review')}` : p.dim('nothing is waiting on you'));

  const order = ['active', 'ready', 'blocked'];
  const turn = new Map(ready(ws, project).map((t, i) => [t.id, i]));
  for (const spool of spools) {
    const mine = tasks(ws).filter((t) => t.spool === spool);
    if (!mine.length) {
      out.push('', `${p.bold(spool.name)}  ${p.dim('no threads yet')}`, ...under(spool).map((line) => `  ${p.dim(line)}`));
      continue;
    }
    const count = (state: string) => mine.filter((t) => taskState(ws, t) === state).length;
    const counts = [
      `${count('ready') + count('stale')} ready`,
      `${count('active')} active`,
      `${count('blocked')} blocked`,
      ...(count('held') ? [`${count('held')} on hold`] : []),
      `${count('done')} done`,
    ];
    out.push('', `${p.bold(spool.name)}  ${p.dim(counts.join(' · '))}`);
    for (const line of under(spool)) out.push(`  ${line.startsWith('Build is not moving') || line.includes('on no thread') ? p.yellow(line) : p.dim(line)}`);
    // Ready work is listed in the order it will be picked, so the top of the list is what happens next.
    const rank = (t: Item) => order.indexOf(taskState(ws, t).replace('stale', 'ready')) * 10_000 + (turn.get(t.id) ?? 9_999);
    const open = mine
      .filter((t) => order.includes(taskState(ws, t).replace('stale', 'ready')))
      .sort((a, b) => rank(a) - rank(b) || (a.priority ?? 2) - (b.priority ?? 2) || a.created.localeCompare(b.created));
    for (const t of open.slice(0, 6)) out.push(`  ${itemLine(ws, t, p, false)}`);
    if (open.length > 6) out.push(p.dim(`  … ${open.length - 6} more — spool list -P ${spool.name}`));
    // Large work stays in view after its plan is written: its progress is its parts.
    const underway = mine.filter((t) => isPlan(t) && t.status === 'done' && (progress(ws, t)?.done ?? 0) < (progress(ws, t)?.total ?? 0));
    for (const t of underway.slice(0, 4)) {
      const note = awaitsGoAhead(ws, t) ? `${progress(ws, t)!.total} parts awaiting your go-ahead` : progress(ws, t)!.text;
      out.push(`  ◧ ${p.bold(t.id)}  ${t.size ? `${t.size.toUpperCase()}  ` : ''}${oneLine(t.title, 70)}${p.dim(`  · ${note}`)}`);
    }
  }
  return out.join('\n').replace(/^\n/, '');
}

/** Why a blocked task is waiting, in words a person can act on. */
export function waitingOn(ws: Workspace, task: Item): string {
  const reasons = blockers(ws, task).map((b) => {
    const what = `“${oneLine(b.title, 48)}”`;
    if (b.kind === 'decision') return `waiting on your answer: ${what}`;
    if (isPlan(b)) return b.status === 'done' ? `waiting on your go-ahead for ${what}` : `waiting for the plan ${what}`;
    return `after ${what}`;
  });
  return reasons.slice(0, 2).join('; ') + (reasons.length > 2 ? `; and ${reasons.length - 2} more` : '');
}

const OVERVIEW_MAX = 8;

/**
 * One project's spool 🧶 as a short list of threads 🧵 under six coloured dots.
 * A spool holds threads: that is the picture people are given, so it is what
 * this prints. The dots and marks are emoji on purpose: an agent relaying this
 * into a chat gets no terminal colours, and the colour is what lets a person
 * read the list at a glance. A question is not a thread, and is marked ❓.
 * Threads an agent thought of by itself sit apart, under ✨, until the human
 * says yes to them.
 */
function docketText(ws: Workspace, d: Docket, p: Paint): string {
  const open = d.breakDown.length + d.blocked.length + d.active.length + d.ready.length;
  const facts = [
    `${plural(open, 'thread')} open`,
    ...(d.proposed.length ? [`${d.proposed.length} proposed`] : []),
    ...(d.suggested.length ? [`${d.suggested.length} suggested`] : []),
    ...(d.held.length ? [`${d.held.length} on hold`] : []),
    `${d.done} done`,
  ];
  const out = [`🧶 ${p.bold(d.spool.name)}  ${p.dim(facts.join(' · '))}`];
  // A thread an agent thought of keeps saying so after the human takes it up.
  const tagOf = (t: Item) => (t.kind === 'task' ? [...(t.suggested && !t.hold ? ['✨ AI suggested'] : []), tag(t)] : []);
  const row = (item: Item, notes: string[], lead = '') =>
    `  ${lead}${item.kind === 'task' ? '🧵' : '❓'} ${item.kind === 'task' && item.type ? `${item.type}: ` : ''}${oneLine(item.title, 84)}${p.dim(`  · ${[...notes, ...tagOf(item), item.id].join(' · ')}`)}`;
  const group = (dot: string, title: string, items: Item[], line: (item: Item, i: number) => string, more: string) => {
    if (!items.length) return;
    out.push('', `${dot} ${p.bold(title)}  ${p.dim(String(items.length))}`);
    out.push(...items.slice(0, OVERVIEW_MAX).map(line));
    if (items.length > OVERVIEW_MAX) out.push(p.dim(`  … ${items.length - OVERVIEW_MAX} more — ${more}`));
  };
  const list = (state: string) => `spool list -P ${d.spool.name} -s ${state}`;

  group('🔴', p.red('NEEDS YOU'), d.needsYou, (i) => {
    if (i.kind === 'decision') {
      const held = dependents(ws, i).filter((t) => !isSettled(t)).length;
      return row(i, [held ? `a question · blocks ${plural(held, 'thread')}` : 'a question']);
    }
    const parts = children(ws, i).filter((k) => k.status !== 'dropped').length;
    return row(i, [`${plural(parts, 'part')} ${parts === 1 ? 'waits' : 'wait'} for your go-ahead`]);
  }, 'spool review');
  group('🟣', p.magenta('BREAK DOWN'), d.breakDown, (t) => {
    const state = taskState(ws, t);
    if (state === 'blocked') return row(t, [waitingOn(ws, t)]);
    if (t.type !== 'plan') return row(t, ['too big to build in one go: needs a plan']);
    if (state === 'active') return row(t, [`being planned now by ${t.by ?? 'someone'}`]);
    return row(t, ['not planned yet: an agent will plan it, or talk it through first']);
  }, `spool list -P ${d.spool.name} -t plan`);
  group('🟡', p.yellow('BLOCKED'), d.blocked, (t) => row(t, [waitingOn(ws, t)]), list('blocked'));
  group('🔵', p.blue('IN PROGRESS'), d.active, (t) => {
    const who = t.by ?? 'someone';
    const when = age(t.updated, ws.now());
    return row(t, [taskState(ws, t) === 'stale' ? `${who} went quiet ${when} ago` : `${who}, ${when}`]);
  }, list('active'));
  group('🟢', p.green('READY'), d.ready, (t, i) => row(t, [], `${i + 1}. `), list('ready'));
  group('🟠', 'PROPOSED', d.proposed, (t) => row(t, [...(t.suggested ? [`✨ AI suggested: “${oneLine(t.suggested, 60)}”`] : []), 'move it to build to start it']), list('proposed'));
  group('✨', 'AI SUGGESTED', d.suggested, (t) => row(t, [`“${oneLine(t.suggested ?? '', 70)}”`, 'say yes and it joins the list']), list('held'));
  group('⚪', 'ON HOLD', d.held, (t) => row(t, [`“${oneLine(t.hold ?? '', 60)}”`]), list('held'));

  if (out.length === 1) out.push(p.dim('  no threads open'));
  const also = [
    ...(d.also.assumptions ? [plural(d.also.assumptions, 'call') + ' agents made'] : []),
    ...(d.also.shipped ? [`${d.also.shipped} shipped`] : []),
    ...(d.also.skills ? [plural(d.also.skills, 'new skill')] : []),
    ...(d.also.inbox ? [`${d.also.inbox} unfiled`] : []),
  ];
  if (also.length) out.push('', p.dim(`also for you to look over: ${also.join(' · ')}  → spool review -P ${d.spool.name}`));
  return out.join('\n');
}

const DIFFICULTY = { xs: 'Tiny', s: 'Small', m: 'Medium', l: 'Large', xl: 'Huge' } as const;
const URGENCY = ['Urgent', 'High', 'Normal', 'Someday'] as const;

export interface TableRow {
  n: number;
  item: Item;
  /** A mark for where it stands when it is not simply next: 🔵 🔴 🟡 ✨ ⚪. */
  mark: string;
  note: string;
}

/** Why a thread cannot move, said to the human: the question with its options, or what it waits on. */
function waitNote(ws: Workspace, task: Item): { mark: string; note: string } {
  const [first] = blockers(ws, task);
  if (!first) return { mark: '🟡', note: 'Blocked' };
  if (first.kind === 'decision') {
    const letter = (i: number) => String.fromCharCode(97 + i);
    const options = first.options.map((o, i) => `**${letter(i)}** ${oneLine(o, 70)}`).join(' · ');
    const pick = first.recommend && first.options[first.recommend - 1] ? ` I'd pick **${letter(first.recommend - 1)}**.` : '';
    return { mark: '🔴', note: `Needs you: ${oneLine(first.title, 110)}${options ? ` ${options}.` : ''}${pick}` };
  }
  const what = `“${oneLine(first.title, 60)}”`;
  if (isPlan(first)) {
    return first.status === 'done'
      ? { mark: '🔴', note: `Needs you: your go-ahead for the plan ${what}` }
      : { mark: '🟡', note: `Waiting for the plan ${what}` };
  }
  return { mark: '🟡', note: `Waiting on ${what}` };
}

/**
 * Every open thread of one project as numbered rows: what is being built, then
 * what comes next in the order it will be taken, then what cannot move and why.
 * Every row has a number, so the human can point at any of them: "do 6 first".
 */
export function tableRows(ws: Workspace, d: Docket): TableRow[] {
  const mine = tasks(ws, d.spool);
  const state = (t: Item) => taskState(ws, t);
  const say = (t: Item, ...notes: string[]) => [...(t.suggested ? ['✨ AI suggested'] : []), ...notes.filter(Boolean)].join(' · ');
  const rows: Omit<TableRow, 'n'>[] = [];
  for (const t of mine.filter((t) => state(t) === 'active')) {
    rows.push({ item: t, mark: '🔵', note: say(t, `Being built now${t.by && t.by !== 'agent' ? ` by ${t.by}` : ''}`) });
  }
  for (const t of ready(ws, d.spool)) {
    const why = state(t) === 'stale' ? `${t.by ?? 'Someone'} went quiet on it; picked up again` : t.type === 'plan' ? 'I write the plan, not the build' : '';
    rows.push({ item: t, mark: '', note: say(t, why) });
  }
  const waiting = mine.filter((t) => state(t) === 'blocked').map((t) => ({ item: t, ...waitNote(ws, t) }));
  rows.push(...waiting.filter((r) => r.mark === '🔴'), ...waiting.filter((r) => r.mark !== '🔴'));
  for (const t of d.proposed) {
    const sprint = sprintOf(ws, t);
    const where = sprint ? `Proposed · in ${sprint.title}` : 'Proposed';
    rows.push({ item: t, mark: '🟠', note: t.suggested ? `${where} · ✨ AI suggested: ${oneLine(t.suggested, 100)}` : where });
  }
  for (const t of d.suggested) rows.push({ item: t, mark: '✨', note: `AI suggested: ${oneLine(t.suggested ?? '', 110)}. Say yes and it joins the order.` });
  for (const t of d.held) rows.push({ item: t, mark: '⚪', note: `On hold: “${oneLine(t.hold ?? '', 80)}”` });
  return rows.map((r, i) => ({ n: i + 1, ...r }));
}

/**
 * The loop's list, as markdown ready to put in a chat: one header line, one
 * table, one line for what else waits. It is printed here, and not drawn by
 * each agent, so it is the same every time it is shown.
 */
/** Where a project stands, in one line: the head of the loop's list, and of its short summary. */
function standing(d: Docket, rows: TableRow[]): string {
  const needs = rows.filter((r) => r.mark === '🔴').length;
  const facts = [
    `${plural(rows.length - d.proposed.length - d.suggested.length - d.held.length, 'thread')} in build`,
    ...(d.proposed.length ? [`${d.proposed.length} proposed`] : []),
    ...(needs ? [`${needs} ${needs === 1 ? 'needs' : 'need'} you`] : []),
    ...(d.suggested.length ? [`${d.suggested.length} AI suggested`] : []),
    ...(d.held.length ? [`${d.held.length} on hold`] : []),
    `${d.done} done`,
  ];
  return `**🧶 ${d.spool.name}** · ${facts.join(' · ')}`;
}

/**
 * The spool in a few lines, for a chat: where it stands, what is being built, what is next, and
 * what needs the human, each on a line. Everything longer belongs on the page.
 */
function briefText(ws: Workspace, d: Docket): string {
  const rows = tableRows(ws, d);
  // Each name carries why the thread exists, so the human can agree to it without opening it.
  const named = (t: Item) => `${oneLine(t.title, 60)}${whyOf(t) ? ` (${oneLine(whyOf(t), 60)})` : ''}`;
  const names = (list: TableRow[], most: number): string =>
    list.slice(0, most).map((r) => named(r.item)).join(' · ') + (list.length > most ? ` · +${list.length - most} more` : '');
  const building = rows.filter((r) => r.mark === '🔵');
  const next = rows.filter((r) => r.mark === '');
  const asking = rows.filter((r) => r.mark === '🔴');
  const out = [standing(d, rows)];
  // The sprint being played is the plan right now: its goal, and how far along it is.
  for (const s of openSprints(ws, d.spool).filter((s) => s.status === 'running')) out.push(sprintLine(ws, s));
  if (building.length) out.push(`Building: ${names(building, 2)}`);
  if (next.length) out.push(`Next in build: ${names(next, 3)}`);
  for (const r of asking.slice(0, 3)) out.push(`❓ ${r.note.replace(/^Needs you: /, '')}`);
  if (asking.length > 3) out.push(`❓ +${asking.length - 3} more on the page`);
  if (!building.length && !next.length) out.push(d.proposed.length ? 'Nothing is in build.' : 'Nothing is open.');
  return out.join('\n');
}

/** The sprints of a project that are not finished: the one being played first, then the planned ones in the order they were made. */
function openSprints(ws: Workspace, spool: Spool): Item[] {
  const rank = (s: Item) => (s.status === 'running' ? 0 : 1);
  return ws.items
    .filter((i) => i.kind === 'sprint' && i.spool === spool && (i.status === 'planned' || i.status === 'running'))
    .sort((a, b) => rank(a) - rank(b) || a.created.localeCompare(b.created));
}

/** A sprint in one line: its name, where it stands, how far along it is, and what it is for. */
function sprintLine(ws: Workspace, s: Item): string {
  const inIt = sprintTasks(ws, s);
  const { goal, vision, serves } = sprintAbout(s);
  // With no goal written yet, the human's own words say what it is for.
  const what = goal ? oneLine(goal, 140) : vision ? `“${oneLine(vision, 140)}”` : '';
  const facts = [
    s.status,
    `${inIt.filter((t) => t.status === 'done').length} of ${inIt.length} done`,
    ...(serves ? [`serves ${oneLine(serves, 60)}`] : []),
    ...(s.version ? [`v${s.version}`] : []),
  ];
  return `🏁 **${s.title}** · ${facts.join(' · ')}${what ? ` — ${what}` : ''}`;
}

export interface ListGroup {
  /** The sprint these threads are in; none for the loose threads. */
  sprint?: Item;
  rows: TableRow[];
}

/**
 * The list's rows under the plan they serve: each unfinished sprint with its threads, the one
 * being played first, then the threads in no sprint. A row keeps the number its place in line
 * gave it, so a number means the same thread wherever it is shown, here or on the page.
 */
export function listGroups(ws: Workspace, d: Docket, rows: TableRow[] = tableRows(ws, d)): ListGroup[] {
  const groups: ListGroup[] = openSprints(ws, d.spool).map((sprint) => ({ sprint, rows: [] }));
  const loose: TableRow[] = [];
  for (const r of rows) {
    const sprint = sprintOf(ws, r.item);
    (groups.find((g) => g.sprint === sprint)?.rows ?? loose).push(r);
  }
  return [...groups, ...(loose.length ? [{ rows: loose }] : [])];
}

/** Where the project is going, in two lines at most: what it is for, and what it is heading towards. */
function goalLines(spool: Spool): string[] {
  const goals = goalsOf(spool);
  if (!goals) return [];
  return [
    `🎯 ${goals.for ? `**${oneLine(goals.for, 120)}**` : '**Goals**'}`,
    ...(goals.towards.length ? [`Heading towards: ${goals.towards.map((g) => oneLine(g, 60)).join(' · ')}`] : []),
  ];
}

function tableText(ws: Workspace, d: Docket): string {
  const rows = tableRows(ws, d);
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const lead = goalLines(d.spool);
  const out = [...lead, ...(lead.length ? [''] : []), standing(d, rows), ''];
  const groups = listGroups(ws, d, rows);
  if (!rows.length) {
    // Nothing open, and the plan is still worth a line: what each unfinished sprint is for.
    for (const g of groups) out.push(sprintLine(ws, g.sprint!));
    return `${out.join('\n').trimEnd()}\n\nNothing is open.`;
  }
  const table = (list: TableRow[]) => {
    out.push('| # | 🧵 Thread | Difficulty | Priority | Note |', '| --- | --- | --- | --- | --- |');
    for (const r of list) {
      const t = r.item;
      const name = `${t.type === 'plan' ? 'Plan: ' : t.type === 'audit' ? 'Audit: ' : ''}${oneLine(t.title, 70)}`;
      // Why it exists rides with its name, in one line, so the human can agree to it without opening it.
      const why = whyOf(t) ? ` — ${cell(oneLine(whyOf(t), 90))}` : '';
      const difficulty = t.size ? DIFFICULTY[t.size] : '—';
      out.push(`| ${r.n} | **${cell(name)}**${why} | ${difficulty} | ${URGENCY[t.priority ?? 2] ?? 'Normal'} | ${cell(`${r.mark} ${r.note}`.trim())} |`);
    }
  };
  // With no sprint there is nothing to group by: one table, as it has always been.
  if (groups.length === 1 && !groups[0]!.sprint) table(rows);
  else {
    groups.forEach((g, i) => {
      if (i) out.push('');
      out.push(g.sprint ? sprintLine(ws, g.sprint) : '🧵 **Loose threads** · in no sprint');
      if (g.rows.length) out.push('');
      if (g.rows.length) table(g.rows);
    });
  }
  const also = [
    ...(d.also.assumptions ? [plural(d.also.assumptions, 'call') + ' agents made on their own'] : []),
    ...(d.also.skills ? [plural(d.also.skills, 'new skill')] : []),
    ...(d.also.inbox ? [`${d.also.inbox} unfiled`] : []),
  ];
  if (also.length) out.push('', `Also waiting for a look: ${also.join(' · ')}.`);
  return out.join('\n');
}

/** The loop's list for one project, or for every project that has anything open. With `brief`, a few lines each. */
export function overviewTable(ws: Workspace, spools: Spool[], brief = false): string {
  const dockets = spools.map((s) => docket(ws, s));
  const shown = dockets.length > 1 ? dockets.filter((d) => tableRows(ws, d).length) : dockets;
  return shown.map((d) => (brief ? briefText(ws, d) : tableText(ws, d))).join('\n\n');
}

/** The spool of one project, or of every project that has anything on it. */
export function overviewText(ws: Workspace, spools: Spool[], p: Paint): string {
  const dockets = spools.map((s) => docket(ws, s));
  const busy = (d: Docket) =>
    d.needsYou.length + d.breakDown.length + d.blocked.length + d.active.length + d.ready.length + d.proposed.length + d.suggested.length + d.held.length > 0 ||
    Object.values(d.also).some(Boolean);
  const shown = dockets.length > 1 ? dockets.filter(busy) : dockets;
  const quiet = dockets.filter((d) => !shown.includes(d));
  const out = shown.map((d) => docketText(ws, d, p));
  if (quiet.length) out.push(p.dim(`nothing open in: ${quiet.map((d) => d.spool.name).join(', ')}`));
  return out.join('\n\n');
}

export function reviewText(ws: Workspace, queue: Review, p: Paint): string {
  const out: string[] = [];
  const where = (i: Item) => (ws.spools.length > 1 ? p.dim(`  · ${i.spool.name}`) : '');

  if (queue.questions.length) {
    out.push(p.bold(p.yellow('NEEDS YOU')) + p.dim('  work is stopped on these'));
    for (const d of queue.questions) {
      const held = dependents(ws, d).filter((t) => !isSettled(t));
      out.push(`  ${p.bold(d.id)}  ${d.title}${held.length ? p.dim(`  · blocks ${plural(held.length, 'thread')}`) : ''}${where(d)}`);
      d.options.forEach((o, i) => out.push(`      ${i + 1}) ${o}${d.recommend === i + 1 ? p.dim('  ← recommended') : ''}`));
      const why = splitBody(d.body).main.split('\n')[0];
      if (why && !why.startsWith('For [[')) out.push(p.dim(`      ${oneLine(why, 110)}`));
      out.push(p.dim(`      spool answer ${d.id} ${d.options.length ? (d.recommend ?? 1) : '"<your call>"'}`));
    }
  }
  if (queue.plans.length) {
    out.push('', p.bold(p.yellow('PLANS')) + p.dim('  the parts wait for your go-ahead'));
    for (const t of queue.plans) {
      const parts = children(ws, t).filter((k) => k.status !== 'dropped');
      out.push(`  ${p.bold(t.id)}  ${t.title}${p.dim(`  · ${plural(parts.length, 'part')}`)}${where(t)}`);
      if (t.summary) out.push(`      ${oneLine(firstLine(t.summary), 110)}`);
      for (const k of parts.slice(0, 6)) out.push(p.dim(`        ${(k.size ?? '·').toUpperCase().padEnd(2)}  ${oneLine(k.title, 90)}`));
      if (parts.length > 6) out.push(p.dim(`        … ${parts.length - 6} more`));
      if (reportOf(t)) out.push(p.dim(`      read ${reportOf(t)}`));
      out.push(p.dim(`      spool approve ${t.id}   ·   spool revert ${t.id} -m "<what to change>"`));
    }
  }
  if (queue.assumptions.length) {
    out.push('', p.bold('WENT AHEAD') + p.dim('  approve, or say what you want instead'));
    for (const d of queue.assumptions) {
      out.push(`  ${p.bold(d.id)}  ${d.title}${where(d)}`);
      out.push(`      chose: ${d.choice}`);
      const why = splitBody(d.body).main.split('\n')[0];
      if (why && !why.startsWith('For [[')) out.push(p.dim(`      ${oneLine(why, 110)}`));
      out.push(p.dim(`      spool approve ${d.id}   ·   spool answer ${d.id} "<what you want>"`));
    }
  }
  if (queue.shipped.length) {
    out.push('', p.bold('SHIPPED') + p.dim('  nothing to do unless you dislike it'));
    for (const t of queue.shipped.slice(0, 10)) {
      const commits = t.commits.length ? p.dim(`  · ${plural(t.commits.length, 'commit')}`) : '';
      out.push(`  ${p.bold(t.id)}  ${t.type ? `${t.type}: ` : ''}${t.title}${commits}${where(t)}`);
      if (t.summary) out.push(`      ${oneLine(firstLine(t.summary), 110)}`);
      t.steps.forEach((s, i) => out.push(p.dim(`        ${i + 1}. ${oneLine(s, 104)}`)));
      const made = progress(ws, t);
      const report = reportOf(t);
      if (report) out.push(p.dim(`      read ${report}${made ? `  · ${made.total} ${t.type === 'plan' ? 'parts' : 'findings'} filed` : ''}`));
    }
    if (queue.shipped.length > 10) out.push(p.dim(`  … ${queue.shipped.length - 10} more`));
    out.push(p.dim('      spool revert <id> -m "<why>"'));
  }
  if (queue.skills.length) {
    out.push('', p.bold('NEW SKILLS') + p.dim('  agents wrote these down to reuse'));
    for (const s of queue.skills) {
      const origin = s.from.length ? ` from ${s.from.join(', ')}` : '';
      out.push(`  ${p.bold(s.id)}  ${s.title}${p.dim(`  · by ${s.by ?? 'an agent'}${origin}`)}${where(s)}`);
      const what = splitBody(s.body).main;
      if (what) out.push(`      ${oneLine(what, 110)}`);
    }
    out.push(p.dim('      spool approve <id>   ·   spool drop <id>'));
  }
  if (queue.inbox.length) {
    out.push('', p.bold('INBOX') + p.dim('  said, not yet filed'));
    for (const n of queue.inbox) out.push(`  ${p.bold(n.id)}  ${oneLine(n.title, 90)}${where(n)}`);
  }
  const clearable = queue.assumptions.length + queue.shipped.length + queue.skills.length;
  if (clearable) out.push('', p.dim(`all good?  spool approve --all   (${plural(clearable, 'item')})`));
  if (!out.length) return 'Nothing is waiting on you.';
  return out.join('\n').replace(/^\n/, '');
}

export function showText(ws: Workspace, item: Item, p: Paint): string {
  const out = [itemLine(ws, item, p)];
  const facts: string[] = [`created ${item.created}`];
  if (item.by) facts.push(`by ${item.by}`);
  if (item.worktree) facts.push(`worktree ${item.worktree}`, `branch ${item.branch}`);
  if (item.from.length) facts.push(`from ${item.from.join(', ')}`);
  if (item.needs.length) facts.push(`needs ${item.needs.join(', ')}`);
  if (item.commits.length) facts.push(`commits ${item.commits.map((c) => c.slice(0, 7)).join(', ')}`);
  if (item.skills.length) facts.push(`skills ${item.skills.join(', ')}`);
  if (item.reviewed) facts.push(`reviewed ${item.reviewed}`);
  if (item.kind === 'skill') facts.push(`used ${item.uses ?? 0}×`, `${item.path}/SKILL.md`);
  if (item.kind === 'task' && reportOf(item)) facts.push(`report ${reportOf(item)}`);
  out.push(p.dim(facts.join(' · ')));
  if (item.kind === 'decision') {
    item.options.forEach((o, i) => out.push(`  ${i + 1}) ${o}${item.recommend === i + 1 ? p.dim('  ← recommended') : ''}`));
    if (item.choice) out.push(`  → ${item.choice}`);
  }
  if (item.summary) out.push(...item.summary.split('\n').map((line) => (line ? `  ${line}` : '')));
  if (item.steps.length) out.push('', 'TO CHECK', ...item.steps.map((s, i) => `  ${i + 1}. ${s}`));
  if (item.body) out.push('', item.body);
  const pictures = item.kind === 'task' ? picturesOf(item) : [];
  const heading = pictures.some((k) => k.kind === 'file') ? 'PICTURES AND FILES' : 'PICTURES';
  if (pictures.length) out.push('', heading, ...pictures.map((pic) => `  ${pictureLine(pic)}`));
  const held = dependents(ws, item);
  if (held.length) out.push('', p.dim(`needed by ${held.map((t) => t.id).join(', ')}`));
  const kids = item.kind === 'task' ? children(ws, item) : [];
  if (kids.length) out.push('', item.type === 'plan' ? 'PARTS' : 'CAME OUT OF IT', ...kids.map((k) => `  ${itemLine(ws, k, p, false)}`));
  const inIt = item.kind === 'sprint' ? sprintTasks(ws, item) : [];
  if (inIt.length) out.push('', 'IN IT', ...inIt.map((t) => `  ${itemLine(ws, t, p, false)}`));
  return out.join('\n');
}

export function skillsText(ws: Workspace, p: Paint): string {
  // Spool's own skills are how it is used; listing them would bury the ones that matter.
  const skills = ws.skills.filter((s) => !BUILT_IN.has(s.name));
  if (!skills.length) return 'No skills yet. Agents add them with: spool skill add';
  const out: string[] = [];
  const width = Math.min(28, Math.max(...skills.map((s) => s.name.length)));
  for (const spool of ws.spools) {
    const mine = skills.filter((s) => s.spool === spool).sort((a, b) => a.name.localeCompare(b.name));
    if (!mine.length) continue;
    out.push(`${p.bold(spool.name)}  ${p.dim(plural(mine.length, 'skill'))}`);
    for (const s of mine) {
      const ledger = ledgerFor(ws, s);
      const notes: string[] = [];
      if (ledger) {
        notes.push(ledger.id);
        if (ledger.by) notes.push(`by ${ledger.by}`);
        if (ledger.from.length) notes.push(`from ${ledger.from.join(', ')}`);
        notes.push(`used ${ledger.uses ?? 0}×`);
        if (!ledger.reviewed) notes.push(p.yellow('new'));
      } else {
        notes.push('untracked');
      }
      out.push(`  ◆ ${p.bold(s.name.padEnd(width))}  ${oneLine(s.description || '(no description)', 70)}`);
      out.push(p.dim(`    ${' '.repeat(width)}  ${notes.join(' · ')} · ${s.rel}`));
    }
    out.push('');
  }
  const lost = ws.items.filter((i) => i.kind === 'skill' && i.status === 'active' && !fileFor(ws, i));
  for (const l of lost) out.push(p.red(`  ${l.id}  ${l.title} is in the ledger but its SKILL.md is gone (${l.path})`));
  return out.join('\n').trimEnd();
}

const SUGGEST_MAX = 5;

/** Procedures that keep recurring, each with the threads it was seen in, the line that offers it and the line that writes it. */
export function suggestText(ws: Workspace, found: Candidate[], p: Paint): string {
  if (!found.length) {
    return `Nothing keeps recurring: no ${SUGGEST.minTasks} finished threads share the same steps without a skill.`;
  }
  const out = [p.bold('WORKED OUT MORE THAN ONCE') + p.dim('  the same steps in finished threads, and no skill for them')];
  found.slice(0, SUGGEST_MAX).forEach((c, i) => {
    const where = ws.spools.length > 1 ? ` · ${c.spool.name}` : '';
    out.push('', `${i + 1}. ${p.bold(c.terms.join(' · '))}${p.dim(`  · in ${plural(c.tasks.length, 'finished thread')}${where}`)}`);
    for (const t of c.tasks) out.push(`     ${p.bold(t.id)}  ${oneLine(t.title, 60)}${t.summary ? p.dim(`  · ${oneLine(firstLine(t.summary), 80)}`) : ''}`);
    out.push(p.dim(`   offer it       ${offerLine(c)}`), p.dim(`   on their yes   ${addLine(c)}`));
  });
  if (found.length > SUGGEST_MAX) out.push('', p.dim(`… ${found.length - SUGGEST_MAX} more, once these are settled`));
  out.push(
    '',
    p.dim('These share words, which is not always a procedure: read the threads first. Offered, it waits in the list for a yes.'),
    p.dim('Not one, or a skill already covers it? Offer it, then spool drop it with the reason: it is not raised again.'),
  );
  return out.join('\n');
}

/** A candidate as data: the same threads, terms and commands the text shows. */
export function candidateJson(c: Candidate): Record<string, unknown> {
  return {
    project: c.spool.name,
    terms: c.terms,
    tasks: c.tasks.map((t) => ({ id: t.id, title: t.title, summary: t.summary ?? null, project: t.spool.name })),
    offer: offerLine(c),
    add: addLine(c),
  };
}

export function itemJson(ws: Workspace, item: Item, full = false): Record<string, unknown> {
  const { spool, extra: _extra, body, ...rest } = item;
  return {
    ...rest,
    state: stateOf(ws, item),
    project: spool.name,
    ...(item.kind === 'task'
      ? {
          type: item.type ?? 'change',
          blockedBy: blockers(ws, item).map((b) => b.id),
          report: reportOf(item),
          // Where to work it, in full, for a thread with a worktree of its own.
          ...(item.worktree ? { workdir: workDir(item) } : {}),
          ...(progress(ws, item) ? { progress: { done: progress(ws, item)!.done, total: progress(ws, item)!.total } } : {}),
        }
      : {}),
    // A sprint says what it is for, and which threads are in it.
    ...(item.kind === 'sprint' ? { ...sprintAbout(item), threads: sprintTasks(ws, item).map((t) => t.id) } : {}),
    ...(full ? { body, file: ws.file(item), ...(item.kind === 'task' ? { pictures: picturesOf(item) } : {}) } : {}),
  };
}

export function nothingReady(ws: Workspace, project?: string): string {
  const all = tasks(ws, project);
  const blocked = all.filter((t) => taskState(ws, t) === 'blocked');
  const active = all.filter((t) => taskState(ws, t) === 'active');
  const onHuman = blocked.filter((t) => blockers(ws, t).some((b) => b.kind === 'decision' || (isPlan(b) && b.status === 'done')));
  const out = ['Nothing is ready.'];
  if (onHuman.length) out.push(`  ${plural(onHuman.length, 'task')} waiting on the human — spool review`);
  if (blocked.length - onHuman.length) out.push(`  ${plural(blocked.length - onHuman.length, 'task')} waiting on other tasks`);
  if (active.length) out.push(`  ${plural(active.length, 'task')} being worked`);
  const held = all.filter((t) => taskState(ws, t) === 'held').length;
  if (held) out.push(`  ${plural(held, 'task')} on hold — spool list -s held`);
  const proposed = all.filter((t) => taskState(ws, t) === 'proposed').length;
  if (proposed) out.push(`  ${plural(proposed, 'task')} proposed — nothing builds them until the human moves them to build`);
  const inbox = review(ws, project).inbox.length;
  if (inbox) out.push(`  ${inbox} unfiled in the inbox — spool inbox`);
  if (out.length === 1 && !ready(ws, project).length) out.push('  The queue is empty.');
  return out.join('\n');
}
