/**
 * The morning brief: what shipped while the human was away, what is worth
 * checking, and what needs them, on one screen.
 *
 * Agents run overnight; the human reads this first, often on a phone. So it
 * leads with one line that says whether anything needs them, then the few
 * finished threads most worth a look and why, then the rest a line each. It
 * reads only what is already on disk and in git: nothing is stored, so it is
 * the same however often it is asked for.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, repoRoot } from './git.ts';
import { type Item, SpoolError, firstLine, isRun, oneLine, splitBody } from './model.ts';
import { type Paint, age } from './render.ts';
import { JOURNAL } from './journal.ts';
import { picturesOf } from './pictures.ts';
import { readProposals, unanswered } from './proposals.ts';
import { type Scope, children, dependents, review, sprintOf, taskState, tasks } from './schedule.ts';
import { hearLine, readTook } from './stream.ts';
import { MOVED } from './takeover.ts';
import { type Strays, strayFixes, strayLines, straysOf } from './strays.ts';
import type { Workspace } from './store.ts';

/** Lines are kept under this, so a phone shows each on one or two rows and a chat never wraps a table. */
const WIDTH = 98;
/** Only the few most worth checking: a list of twelve is no list. */
const WORTH_MAX = 5;
/** Changing this many files is a lot to have done unwatched. */
const MANY_FILES = 8;

export interface Brief {
  /** The --since the brief was narrowed by, as given, and the moment it means. Null: everything not yet reviewed. */
  since: { said: string; from: string } | null;
  headline: string;
  shipped: number;
  /** From the first of them being started to the last being finished, in ms. */
  took: number;
  /** What the shipped threads' runs took, summed from the line each run left on its ticket; null when no run said. `unmeasured`: shipped threads with none (built in chat, where there is no stream). */
  spent: { runs: number; minutes: number; turns: number; usd: number; unmeasured: number } | null;
  needsYou: {
    questions: { id: string; title: string; options: string[]; recommend: number | null; blocks: number; project: string }[];
    plans: { id: string; title: string; summary: string | null; parts: number; project: string }[];
    stopped: { id: string; title: string; why: string; when: string; lastSaid: string | null; project: string }[];
    /** A manager's run with proposals not yet answered: one line, which opens the run's thread, where each is answered. */
    proposals: { id: string; headline: string | null; count: number; project: string }[];
  };
  /** `steps`: how to see each one working, as the agent that finished it wrote them. */
  worthALook: { id: string; title: string; summary: string | null; steps: string[]; size: string | null; files: number; reasons: string[]; project: string; pictures: number }[];
  /** The rest of what shipped, by sprint: threads in no sprint come first, under a null sprint. */
  alsoShipped: { sprint: { id: string; title: string } | null; threads: { id: string; title: string; summary: string | null; project: string }[] }[];
  calls: { id: string; question: string; chose: string; for: string[]; project: string }[];
  /** Work that landed on no thread, by project: only those with some. */
  noThread: (Strays & { project: string })[];
  approve: string | null;
  board: string;
}

/** A line of an item's log: when, who, and what. */
interface Entry {
  at: number;
  actor: string;
  text: string;
}

function entries(item: Item): Entry[] {
  const out: Entry[] = [];
  for (const line of splitBody(item.body).log) {
    const m = /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d(?::\d\d)?)Z ([^:]+): (.*)$/.exec(line);
    if (m) out.push({ at: Date.parse(`${m[1]}T${m[2]}Z`), actor: m[3]!, text: m[4]! });
  }
  return out;
}

/** When a thread was finished: the log's last `done:` line, or failing that its last change. */
export function finishedAt(t: Item): number {
  const done = entries(t).filter((e) => e.text.startsWith('done: ')).at(-1);
  return done?.at ?? Date.parse(t.updated);
}

/** What `--since` means: 8h, 30m, 2d, 1w, today, yesterday, or a date. */
export function sinceOf(said: string, now: Date): Date {
  const text = said.trim().toLowerCase();
  const span = /^(\d+)\s*(m|min|mins|h|hr|hrs|hours?|d|days?|w|weeks?)$/.exec(text);
  if (span) {
    const unit = span[2]!.startsWith('m') ? 60_000 : span[2]!.startsWith('h') ? 3_600_000 : span[2]!.startsWith('d') ? 86_400_000 : 604_800_000;
    return new Date(now.getTime() - Number(span[1]) * unit);
  }
  if (text === 'today' || text === 'yesterday') {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    if (text === 'yesterday') day.setDate(day.getDate() - 1);
    return day;
  }
  const at = Date.parse(said.trim());
  if (Number.isFinite(at)) return new Date(at);
  throw new SpoolError(`"${said}" is not a time to start from`, 'Say how long ago, as in 8h, 30m or 2d; or today, yesterday, or a date such as 2026-11-14');
}

/** The newest transcript of a thread's runs, as text, or empty where it was never run by a page. */
function transcripts(t: Item): string[] {
  const dir = path.join(t.spool.dir, 'runs', t.id);
  try {
    return fs
      .readdirSync(dir)
      // The journal of a run is kept beside the transcripts, and is nothing an agent said.
      .filter((f) => f.endsWith('.jsonl') && f !== JOURNAL)
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    return [];
  }
}

/** How often the project's check refused to let the thread finish: an agent's run shows each refusal. */
function checkFailures(t: Item): number {
  return transcripts(t).reduce((n, text) => n + (text.match(/the check (failed|was stopped|could not run)/g)?.length ?? 0), 0);
}

/** The last thing the agent on a thread said: from its newest run's transcript, or its own last note. */
function lastSaid(t: Item): string | null {
  const newest = transcripts(t).at(-1);
  if (newest) {
    const said = newest
      .split('\n')
      .flatMap((line) => hearLine(line).lines)
      .filter((l) => !/^(→ |✗ |session |denied → |asks → |allowed → |refused → |you: |told to stop )/.test(l));
    if (said.length) return said.at(-1)!;
  }
  const own = entries(t).filter((e) => !['page', 'loop', 'human'].includes(e.actor) && !/^(started|builder model: |built on |handed to|done:|moved to build)/.test(e.text));
  return own.at(-1)?.text ?? null;
}

/** The files a thread's commits changed, as the page's diff finds them. */
export function changedFiles(t: Item, root: string | null): Set<string> {
  const files = new Set<string>();
  if (!root) return files;
  for (const sha of t.commits) {
    const stat = git(root, ['show', '--no-color', '--format=', '--numstat', sha]);
    if (!stat.ok) continue;
    for (const line of stat.out.split('\n')) {
      const file = line.split('\t')[2];
      if (file) files.add(file);
    }
  }
  return files;
}

/** How many files a thread's commits changed, counted the way the page's diff counts them. */
function filesChanged(t: Item, root: string | null): number {
  return changedFiles(t, root).size;
}

/** Why a finished thread is worth a look, and how much: the reasons are said to the human as they are. */
function weigh(ws: Workspace, t: Item): { score: number; reasons: string[]; files: number } {
  const reasons: string[] = [];
  let score = 0;
  if (t.size === 'xl' || t.size === 'l') {
    score += t.size === 'xl' ? 4 : 3;
    reasons.push(t.size === 'xl' ? 'huge' : 'large');
  }
  if (t.type === 'plan' || t.type === 'audit' || t.type === 'research') {
    score += 1;
    reasons.push(`${t.type === 'plan' ? 'a plan' : t.type === 'audit' ? 'an audit' : 'research'}: read its report`);
  }
  const calls = t.needs.map((id) => ws.find(id)).filter((d) => d?.kind === 'decision' && d.status === 'assumed').length;
  if (calls) {
    score += 2 * Math.min(calls, 3);
    reasons.push(`${calls} ${calls === 1 ? 'call' : 'calls'} an agent made`);
  }
  // Taking over the backlog, the chat moved it to Build itself: the human never said go on this one.
  if (entries(t).some((e) => e.text.startsWith(MOVED))) {
    score += 3;
    reasons.push('the chat moved it to Build itself, taking over the backlog');
  }
  const redone = entries(t).some((e) => /reverted \d+ commit/.test(e.text)) || /on reverting the first attempt/.test(t.body);
  if (redone) {
    score += 3;
    reasons.push('redone after a revert');
  }
  const failed = checkFailures(t);
  if (failed) {
    score += 2;
    reasons.push(`the check failed ${failed === 1 ? 'once' : `${failed} times`} first`);
  }
  const root = repoRoot(t.spool.root);
  const files = filesChanged(t, root);
  if (files >= MANY_FILES) {
    score += files >= 2 * MANY_FILES ? 3 : 2;
    reasons.push(`${files} files changed`);
  }
  if (root && !t.type && !t.commits.length) {
    score += 1;
    reasons.push('no commits on record, so it cannot be undone');
  }
  return { score, reasons, files };
}

/** A thread an agent walked away from, or that was stopped, and is waiting in build again. */
const PUT_BACK = /without finishing|back in build|went quiet/;

function stopped(ws: Workspace, t: Item): { why: string; at: number } | null {
  if (taskState(ws, t) === 'stale') return { why: `${t.by ?? 'someone'} went quiet on it`, at: Date.parse(t.updated) };
  if (t.status !== 'open') return null;
  const last = entries(t).at(-1);
  if (!last || !PUT_BACK.test(last.text)) return null;
  return { why: last.text.replace(/; back in build$/, ''), at: last.at };
}

/**
 * How many things wait on the human: an open question, a plan waiting for a go-ahead, and a thread
 * an agent stopped on or walked away from. Each thread is counted once, so a stopped thread with a
 * question on it is one; a question on no thread counts by itself. This is the one number the
 * brief, the list of projects and the board all say, so none of them works out its own.
 */
export function waitingOnYou(ws: Workspace, scope?: Scope): number {
  const queue = review(ws, scope);
  const seen = new Set<string>();
  for (const d of queue.questions) {
    const held = dependents(ws, d).filter((t) => t.status !== 'done' && t.status !== 'dropped');
    for (const id of held.length ? held.map((t) => t.id) : [d.id]) seen.add(id);
  }
  for (const t of queue.plans) seen.add(t.id);
  for (const t of tasks(ws, scope)) if (stopped(ws, t)) seen.add(t.id);
  for (const t of tasks(ws, scope)) if (isRun(t) && unanswered(readProposals(t)).length) seen.add(t.id);
  return seen.size;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Everything the brief says, as data. The text is drawn from this, and a page can be. */
export function morning(ws: Workspace, opts: { since?: string; project?: Scope } = {}): Brief {
  const now = ws.now();
  const from = opts.since ? sinceOf(opts.since, now) : null;
  const queue = review(ws, opts.project);
  const inWindow = (at: number) => !from || at >= from.getTime();
  const shipped = queue.shipped.filter((t) => inWindow(finishedAt(t)));
  const project = (i: Item) => i.spool.name;

  const questions = queue.questions.map((d) => ({
    id: d.id,
    title: d.title,
    options: d.options,
    recommend: d.recommend ?? null,
    blocks: dependents(ws, d).filter((t) => t.status !== 'done' && t.status !== 'dropped').length,
    project: project(d),
  }));
  const plans = queue.plans.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary ?? null,
    parts: children(ws, t).filter((k) => k.status !== 'dropped').length,
    project: project(t),
  }));
  const stops = tasks(ws, opts.project)
    .map((t) => ({ t, stop: stopped(ws, t) }))
    .filter((s): s is { t: Item; stop: { why: string; at: number } } => !!s.stop)
    .sort((a, b) => b.stop.at - a.stop.at)
    .map(({ t, stop }) => ({ id: t.id, title: t.title, why: stop.why, when: new Date(stop.at).toISOString(), lastSaid: lastSaid(t), project: project(t) }));

  const proposals = tasks(ws, opts.project)
    .filter((t) => isRun(t) && unanswered(readProposals(t)).length)
    .sort((a, b) => b.created.localeCompare(a.created))
    .map((t) => ({ id: t.id, headline: t.summary ?? null, count: unanswered(readProposals(t)).length, project: project(t) }));

  // Most worth checking first; a thread with nothing to remark on is simply shipped.
  const weighed = shipped.map((t) => ({ t, ...weigh(ws, t) }));
  const worth = weighed
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score || finishedAt(b.t) - finishedAt(a.t))
    .slice(0, WORTH_MAX);
  const rest = weighed.filter((w) => !worth.includes(w)).map((w) => w.t);
  const groups = new Map<string, { sprint: { id: string; title: string } | null; threads: Brief['alsoShipped'][number]['threads'] }>();
  for (const t of [...rest].sort((a, b) => finishedAt(a) - finishedAt(b))) {
    const sprint = sprintOf(ws, t);
    const key = sprint?.id ?? '';
    if (!groups.has(key)) groups.set(key, { sprint: sprint ? { id: sprint.id, title: sprint.title } : null, threads: [] });
    groups.get(key)!.threads.push({ id: t.id, title: t.title, summary: t.summary ?? null, project: project(t) });
  }
  const alsoShipped = [...groups.values()].sort((a, b) => (a.sprint ? 1 : 0) - (b.sprint ? 1 : 0));

  const calls = queue.assumptions
    .filter((d) => inWindow(Date.parse(d.created)))
    .map((d) => ({ id: d.id, question: d.title, chose: d.choice ?? '', for: dependents(ws, d).map((t) => t.id), project: project(d) }));

  const starts = shipped.map((t) => Date.parse(t.started ?? t.created));
  const ends = shipped.map(finishedAt);
  const took = shipped.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0;
  const runs = shipped.flatMap((t) => entries(t).map((e) => readTook(e.text)).filter((r) => r !== null));
  const spent = runs.length
    ? {
        runs: runs.length,
        minutes: runs.reduce((n, r) => n + r.minutes, 0),
        turns: runs.reduce((n, r) => n + r.turns, 0),
        usd: runs.reduce((n, r) => n + r.usd, 0),
        unmeasured: shipped.filter((t) => !entries(t).some((e) => readTook(e.text))).length,
      }
    : null;
  const needs = waitingOnYou(ws, opts.project);
  // "8h" reads as a span, so it is said as one; "yesterday" and a date are a point to start from.
  const said = opts.since?.trim() ?? '';
  const when = !from ? 'since you last looked' : /^\d+\s*[a-z]+$/i.test(said) ? `in the last ${said}` : `since ${said}`;
  const span = age(new Date(now.getTime() - took).toISOString(), now);
  const headline = [
    shipped.length ? `${plural(shipped.length, 'thread')} shipped ${when}${span === 'now' ? '' : `, over ${span}`}` : `Nothing shipped ${when}`,
    ...(spent && spent.usd > 0 ? [`$${spent.usd.toFixed(2)}`] : []),
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : 'nothing needs you',
  ].join(' · ');
  const projects = !opts.project ? ws.spools : [typeof opts.project === 'string' ? ws.project(opts.project) : opts.project];
  const noThread = projects
    .map((spool) => ({ spool, s: straysOf(ws, spool) }))
    .filter((x): x is { spool: typeof x.spool; s: Strays } => !!x.s && (x.s.commits.length > 0 || x.s.untracked.length > 0))
    .map(({ spool, s }) => ({ ...s, project: spool.name }));
  const clearable = queue.assumptions.length + queue.shipped.length + queue.skills.length;
  return {
    since: from ? { said, from: from.toISOString() } : null,
    headline,
    shipped: shipped.length,
    took,
    spent,
    needsYou: { questions, plans, stopped: stops, proposals },
    worthALook: worth.map(({ t, reasons, files }) => ({
      id: t.id,
      title: t.title,
      summary: t.summary ?? null,
      steps: t.steps,
      size: t.size ?? null,
      files,
      reasons,
      project: project(t),
      // Pictures kept with it, its before and after among them: the quickest look there is.
      pictures: picturesOf(t).length,
    })),
    alsoShipped,
    calls,
    noThread,
    approve: clearable ? 'spool approve --all' : null,
    board: 'spool page',
  };
}

/** The brief as a person reads it: a terminal, or a chat on a phone. No tables, short lines. */
export function morningText(ws: Workspace, b: Brief, p: Paint): string {
  const where = (name: string) => (ws.spools.length > 1 ? ` · ${name}` : '');
  // A lead, the text cut to the room left on the line, and a dim note after it that is never cut.
  const line = (lead: string, text: string, note = ''): string => {
    const tail = note ? `  · ${note}` : '';
    return `${lead}${oneLine(text, Math.max(24, WIDTH - [...lead].length - [...tail].length))}${tail ? p.dim(tail) : ''}`;
  };
  const out = [`🌅 ${p.bold(b.headline)}`, ''];

  const needs = b.needsYou;
  const count = needs.questions.length + needs.plans.length + needs.stopped.length + needs.proposals.length;
  if (!count) out.push('Nothing needs you: no questions, no plans waiting, nothing stopped.');
  else {
    out.push(`🔴 ${p.bold('NEEDS YOU')}  ${p.dim(String(count))}`);
    for (const q of needs.questions) {
      out.push(line('  ❓ ', q.title, `${q.blocks ? `blocks ${plural(q.blocks, 'thread')} · ` : ''}${q.id}${where(q.project)}`));
      if (q.options.length) out.push(line('     ', q.options.map((o, i) => `${i + 1}) ${oneLine(o, 40)}${q.recommend === i + 1 ? ' ← I would pick' : ''}`).join(' · ')));
      out.push(p.dim(`     spool answer ${q.id} ${q.options.length ? (q.recommend ?? 1) : '"<your call>"'}`));
    }
    for (const t of needs.plans) {
      out.push(line('  📋 ', `plan: ${t.title}`, `${plural(t.parts, 'part')} ${t.parts === 1 ? 'waits' : 'wait'} for your go-ahead · ${t.id}${where(t.project)}`));
      if (t.summary) out.push(line('     ', firstLine(t.summary)));
      out.push(p.dim(`     spool approve ${t.id}`));
    }
    for (const m of needs.proposals) {
      out.push(line('  🧹 ', `The manager proposes ${plural(m.count, 'change')}`, `${m.id}${where(m.project)}`));
      if (m.headline) out.push(line('     ', m.headline));
      out.push(p.dim(`     spool show ${m.id}, then spool manage --answer yes|no <n>`));
    }
    for (const s of needs.stopped) {
      out.push(line('  ↺ ', s.title, `${s.id}${where(s.project)}`));
      out.push(p.dim(line('     ', `${s.why}, ${age(s.when, ws.now())} ago`)));
      if (s.lastSaid) out.push(line('     last said: ', `“${oneLine(s.lastSaid, 70)}”`));
    }
  }

  if (b.worthALook.length) {
    out.push('', `🟡 ${p.bold('WORTH A LOOK')}  ${p.dim(String(b.worthALook.length))}`);
    b.worthALook.forEach((t, i) => {
      out.push(line(`  ${i + 1}. `, t.title, `${t.id}${where(t.project)}`));
      // Worth a look shows what changed whole, a list in it line by line.
      if (t.summary) out.push(...t.summary.split('\n').map((l) => (l.trim() ? line('     ', l) : '')));
      out.push(line('     why: ', t.reasons.join(' · ')));
      if (t.steps.length) out.push('     to check:', ...t.steps.map((s, n) => line(`       ${n + 1}) `, s)));
    });
  }

  if (b.spent) {
    const sp = b.spent;
    const bits = [plural(sp.runs, 'run'), `${Math.round(sp.minutes)} min`, ...(sp.turns ? [plural(sp.turns, 'turn')] : []), ...(sp.usd > 0 ? [`$${sp.usd.toFixed(2)}`] : [])];
    out.push('', `⏱ ${p.bold('WHAT IT TOOK')}  ${p.dim(bits.join(' · '))}`);
    if (sp.unmeasured) out.push(p.dim(`  ${plural(sp.unmeasured, 'thread')} built in chat: no stream to read, so only the time from claim to landing is known`));
  }

  const rest = b.alsoShipped.reduce((n, g) => n + g.threads.length, 0);
  if (rest) {
    out.push('', `🟢 ${p.bold(b.worthALook.length ? 'ALSO SHIPPED' : 'SHIPPED')}  ${p.dim(String(rest))}`);
    for (const g of b.alsoShipped) {
      if (g.sprint) out.push(`  🏁 ${g.sprint.title}`);
      const lead = g.sprint ? '    ✓ ' : '  ✓ ';
      for (const t of g.threads) out.push(line(lead, `${oneLine(t.title, 48)}${t.summary ? ` — ${firstLine(t.summary)}` : ''}`, `${t.id}${where(t.project)}`));
    }
  }

  if (b.calls.length) {
    out.push('', `🧾 ${p.bold('CALLS AGENTS MADE')}  ${p.dim(`${b.calls.length} · approve, or say what you want instead`)}`);
    for (const c of b.calls) out.push(line('  ', `${oneLine(c.question, 54)} → ${c.chose}`, `${c.id}${where(c.project)}`));
  }

  if (b.noThread.length) {
    out.push('', `🧶 ${p.bold('ON NO THREAD')}  ${p.dim('work that landed with nothing to undo or trace it by')}`);
    for (const n of b.noThread) {
      if (ws.spools.length > 1) out.push(`  ${n.project}`);
      out.push(...strayLines(n, 70).map((l) => `  ${l}`), ...strayFixes(n).map((l) => p.dim(`  → ${l}`)));
    }
  }

  out.push('', `${b.approve ? `All good? ${b.approve}   ·   ` : ''}The board: ${b.board}, usually at http://127.0.0.1:4747`);
  return out.join('\n');
}
