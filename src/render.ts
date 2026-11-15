/**
 * Output, written for two readers: an agent paying per token and a human
 * glancing at a phone. Both want the same thing — the one screen that matters,
 * with the next command spelled out. Every view has a `--json` twin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, isPlan, isSettled, oneLine, reportFile, splitBody } from './model.ts';
import { type Review, blockers, children, dependents, ready, review, stateOf, taskState, tasks } from './schedule.ts';
import { BUILT_IN, fileFor, ledgerFor, matchSkills } from './skills.ts';
import type { Workspace } from './store.ts';

export interface Paint {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
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
    cyan: wrap(36, 39),
  };
}

const MARK: Record<string, string> = {
  ready: '○',
  active: '▶',
  stale: '▷',
  blocked: '◌',
  held: '⏸',
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
    if (state === 'held') notes.push(`on hold: ${oneLine(item.hold ?? '', 60)}`);
    if (state === 'active') notes.push(`${item.by ?? 'someone'}, ${age(item.updated, ws.now())}`);
    if (state === 'stale') notes.push(`${item.by ?? 'someone'} went quiet ${age(item.updated, ws.now())} ago`);
    if (state === 'done' || state === 'dropped') notes.push(awaitsGoAhead(ws, item) ? 'awaiting go-ahead' : state);
    const made = progress(ws, item);
    if (made) notes.push(made.text);
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
    p.dim(`${task.spool.name} · work in ${task.spool.root}`),
  ];
  if (task.hold) out.push(p.yellow(`ON HOLD — ${task.hold}. Do not start it; only the human releases it.`));
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
    out.push(`  ${source.id}  ${source.title}${source.summary ? ` — ${source.summary}` : ''}`);
    const made = progress(ws, source);
    const report = reportOf(source);
    if (made) out.push(p.dim(`      ${made.text}`));
    if (report) out.push(p.dim(`      read ${path.relative(task.spool.root, path.join(source.spool.root, report))}`));
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
    for (const t of after) out.push(`  ${t.id}  ${t.title}  (${stateOf(ws, t)})${t.summary ? ` — ${t.summary}` : ''}`);
  }

  const skills = matchSkills(ws, task);
  if (skills.length) {
    out.push('', 'SKILLS THAT MAY HELP');
    for (const s of skills) {
      out.push(`  ${s.name} — ${oneLine(s.description, 100)}`);
      out.push(p.dim(`      ${path.join(path.relative(task.spool.root, s.dir), 'SKILL.md')}`));
    }
  }
  if (log.length) out.push('', 'LOG', ...log.slice(-8).map((l) => `  ${l}`));
  if (type === 'change') out.push('', p.dim(`commit trailer  Spool: ${task.id}      finish  spool done ${task.id} -m "<what changed>"`));
  return out.join('\n');
}

export function statusText(ws: Workspace, p: Paint, project?: string): string {
  const spools = project ? [ws.project(project)] : ws.spools;
  const out: string[] = [];
  if (ws.spools.length > 1) out.push(p.bold(ws.home.name) + p.dim(` · ${plural(ws.spools.length, 'project')}`));

  const queue = review(ws, project);
  const waiting: string[] = [];
  if (queue.questions.length) {
    const held = new Set(queue.questions.flatMap((d) => dependents(ws, d).filter((t) => !isSettled(t)).map((t) => t.id)));
    waiting.push(p.yellow(`${plural(queue.questions.length, 'question')} blocking ${plural(held.size, 'task')}`));
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
      out.push('', `${p.bold(spool.name)}  ${p.dim('no tasks yet')}`);
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

export function reviewText(ws: Workspace, queue: Review, p: Paint): string {
  const out: string[] = [];
  const where = (i: Item) => (ws.spools.length > 1 ? p.dim(`  · ${i.spool.name}`) : '');

  if (queue.questions.length) {
    out.push(p.bold(p.yellow('NEEDS YOU')) + p.dim('  work is stopped on these'));
    for (const d of queue.questions) {
      const held = dependents(ws, d).filter((t) => !isSettled(t));
      out.push(`  ${p.bold(d.id)}  ${d.title}${held.length ? p.dim(`  · blocks ${plural(held.length, 'task')}`) : ''}${where(d)}`);
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
      if (t.summary) out.push(`      ${oneLine(t.summary, 110)}`);
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
      if (t.summary) out.push(`      ${oneLine(t.summary, 110)}`);
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
  if (item.summary) out.push(`  ${item.summary}`);
  if (item.body) out.push('', item.body);
  const held = dependents(ws, item);
  if (held.length) out.push('', p.dim(`needed by ${held.map((t) => t.id).join(', ')}`));
  const kids = item.kind === 'task' ? children(ws, item) : [];
  if (kids.length) out.push('', item.type === 'plan' ? 'PARTS' : 'CAME OUT OF IT', ...kids.map((k) => `  ${itemLine(ws, k, p, false)}`));
  return out.join('\n');
}

export function skillsText(ws: Workspace, p: Paint): string {
  // Spool's own two skills are in every project; listing them would bury the ones that matter.
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
          ...(progress(ws, item) ? { progress: { done: progress(ws, item)!.done, total: progress(ws, item)!.total } } : {}),
        }
      : {}),
    ...(full ? { body, file: ws.file(item) } : {}),
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
  const inbox = review(ws, project).inbox.length;
  if (inbox) out.push(`  ${inbox} unfiled in the inbox — spool inbox`);
  if (out.length === 1 && !ready(ws, project).length) out.push('  The queue is empty.');
  return out.join('\n');
}
