/**
 * The ideation worksheet: the facts a pass for new ideas starts from, and the rules for a good one.
 *
 * Coming up with where a project could go is judgment, and Spool calls no model. What it does is
 * gather what that judgment needs, the same way every time, so the agent starts from the project's
 * goals, what shipped, what is already in the spool and what was said no to, and not from whatever
 * it happened to read:
 *
 *   1  what the project is for: the goals page
 *   2  what shipped lately: finished threads, and the changelog's newest version
 *   3  what is already there: every open thread, so no idea repeats one
 *   4  what the user said: their notes, newest first, unfiled ones marked
 *   5  what was said no to: drops with their reasons, the lessons, and earlier AI ideas' fate
 *   6  where the code is: the folder, its README and docs
 *
 * `spool ideate` writes nothing. Each idea is filed by the agent with `spool task --suggested`, as
 * proposed and marked AI suggested, and waits there until the user moves it to Build. Dropping
 * one is all it takes to say no.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Call, Result } from './commands.ts';
import { finishedAt } from './brief.ts';
import { goalsOf, goalsText } from './goals.ts';
import { lessons } from './lessons.ts';
import { type Item, type Spool, SpoolError, isRun, oneLine } from './model.ts';
import { type Paint, age, itemLine } from './render.ts';
import { tasks, taskState } from './schedule.ts';
import { droppedBecause } from './similar.ts';
import type { Workspace } from './store.ts';

/** The numbers, in one place so they are easy to change. */
export const IDEATE = {
  /** New ideas a pass may file, unless the user named a number. */
  ideas: 5,
  /** With this many AI ideas still unanswered, a pass files none: the user has enough to answer. */
  waiting: 10,
  /** Finished threads shown, newest first. */
  shipped: 12,
  /** The user's notes shown, newest first. */
  said: 12,
  /** Drops shown, newest first. */
  dropped: 12,
} as const;

/** Open: waiting in the backlog, in Build, or being built. */
const OPEN = ['proposed', 'ready', 'blocked', 'stale', 'held', 'active'];

export interface Ideas {
  project: string;
  /** Ideas this pass may file, and how many earlier AI ideas still wait for an answer. */
  cap: number;
  unanswered: number;
  goals: string;
  shipped: { id: string; title: string; summary: string | null; when: string }[];
  changelog: { version: string; lines: string[] } | null;
  open: { id: string; title: string; state: string; suggested: boolean }[];
  said: { id: string; text: string; when: string; unfiled: boolean }[];
  saidNo: {
    dropped: { id: string; title: string; why: string | null; suggested: boolean }[];
    lessons: string[];
  };
  code: { root: string; readme: string | null; docs: string[] };
}

/** The newest version in the changelog: its heading and its lines. */
function newestVersion(root: string): Ideas['changelog'] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+\S/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s+\S/.test(l));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
  return { version: lines[start]!.replace(/^##\s+/, '').trim(), lines: body };
}

function docsOf(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, 'docs'))
      .filter((f) => /\.(md|txt)$/i.test(f))
      .sort()
      .map((f) => `docs/${f}`);
  } catch {
    return [];
  }
}

/** Everything the worksheet says, as data. Reads the spool, the changelog and the folder; writes nothing. */
export function gatherIdeas(ws: Workspace, spool: Spool, max?: number): Ideas {
  const mine = tasks(ws, spool).filter((t) => !isRun(t));
  const state = (t: Item) => taskState(ws, t);
  const unanswered = mine.filter((t) => t.suggested && ['proposed', 'held'].includes(state(t))).length;
  const newest = <T>(list: T[], at: (x: T) => number, n: number) => list.sort((a, b) => at(b) - at(a)).slice(0, n);
  const notes = ws.items.filter((i) => i.kind === 'note' && i.spool === spool);
  const dropped = newest(
    mine.filter((t) => t.status === 'dropped'),
    (t) => Date.parse(t.updated),
    IDEATE.dropped,
  );
  const readme = ['README.md', 'readme.md', 'README'].find((f) => fs.existsSync(path.join(spool.root, f))) ?? null;
  return {
    project: spool.name,
    // The user's own number stands, whatever is waiting.
    cap: max ?? (unanswered >= IDEATE.waiting ? 0 : IDEATE.ideas),
    unanswered,
    goals: goalsOf(spool) ? goalsText(spool) : '',
    shipped: newest(
      mine.filter((t) => t.status === 'done'),
      finishedAt,
      IDEATE.shipped,
    ).map((t) => ({ id: t.id, title: t.title, summary: t.summary ?? null, when: new Date(finishedAt(t)).toISOString() })),
    changelog: newestVersion(spool.root),
    open: mine
      .filter((t) => OPEN.includes(state(t)) && !t.archived)
      .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || a.created.localeCompare(b.created))
      .map((t) => ({ id: t.id, title: t.title, state: state(t), suggested: !!t.suggested })),
    said: newest(notes, (n) => Date.parse(n.created), IDEATE.said).map((n) => ({
      id: n.id,
      text: n.title,
      when: n.created,
      unfiled: n.status === 'new',
    })),
    saidNo: {
      dropped: dropped.map((t) => ({ id: t.id, title: t.title, why: droppedBecause(t) ?? null, suggested: !!t.suggested })),
      lessons: lessons(ws)
        .filter((l) => l.spool === spool)
        .map((l) => l.words),
    },
    code: { root: spool.root, readme, docs: docsOf(spool.root) },
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The worksheet as an agent reads it: the facts under their numbers, then the rules and the command. */
export function ideasText(ws: Workspace, w: Ideas, p: Paint): string {
  const now = ws.now();
  const ago = (at: string) => (age(at, now) === 'now' ? 'just now' : `${age(at, now)} ago`);
  const head = (n: number, title: string, note = '') => `${p.bold(`${n}  ${title}`)}${note ? p.dim(`  ${note}`) : ''}`;
  const line = (id: string) => {
    const item = ws.find(id);
    return item ? itemLine(ws, item, p, false) : id;
  };
  const out: string[] = [
    `${p.bold(`New ideas for ${w.project}`)}${p.dim('  this writes nothing: you file each idea')}`,
    'What follows are facts, gathered the same way every time. The ideas are yours.',
    w.cap
      ? `New ideas: ${w.cap} at most this pass. ${w.unanswered ? `${plural(w.unanswered, 'earlier AI idea')} still ${w.unanswered === 1 ? 'waits' : 'wait'} for an answer.` : 'No earlier AI idea is waiting for an answer.'}`
      : `New ideas: none this pass. ${w.unanswered} earlier AI ideas still wait for an answer, and at ${IDEATE.waiting} the user has enough to read. Say so, and file nothing.`,
    '',
  ];

  out.push(head(1, 'WHAT IT IS FOR', 'every idea serves one of these'));
  if (w.goals) out.push(...w.goals.split('\n').map((l) => `  ${l}`));
  else out.push('  No goals yet. Ask the user what it is for and where it is heading, in one question, and keep it: spool goals --edit -');

  out.push('', head(2, 'WHAT SHIPPED', w.shipped.length ? `the last ${plural(w.shipped.length, 'thread')}, newest first: the follow-ups they make obvious` : ''));
  if (!w.shipped.length) out.push('  Nothing finished yet.');
  for (const t of w.shipped) out.push(`  ${p.bold(t.id)}  ${oneLine(t.title, 70)}${p.dim(`  · ${ago(t.when)}${t.summary ? `: ${oneLine(t.summary, 90)}` : ''}`)}`);
  if (w.changelog) {
    out.push(`  The changelog's newest, ${w.changelog.version}:`);
    for (const l of w.changelog.lines.slice(0, 8)) out.push(p.dim(`    - ${oneLine(l, 100)}`));
  }

  out.push('', head(3, 'ALREADY THERE', `${plural(w.open.length, 'open thread')}: an idea already here is no idea`));
  if (!w.open.length) out.push('  Nothing open.');
  for (const t of w.open) out.push(`  ${line(t.id)}`);

  out.push('', head(4, 'WHAT THEY SAID', w.said.length ? 'their own words, newest first: what they keep coming back to' : ''));
  if (!w.said.length) out.push('  Nothing captured yet.');
  for (const n of w.said) out.push(`  ${p.bold(n.id)}  "${oneLine(n.text, 100)}"${p.dim(`  · ${ago(n.when)}${n.unfiled ? ' · unfiled: file it by the spool-record skill, it is theirs and not an idea' : ''}`)}`);

  out.push('', head(5, 'SAID NO TO', 'never suggest these again, in other words'));
  const no = w.saidNo;
  if (!no.dropped.length && !no.lessons.length) out.push('  Nothing yet.');
  for (const d of no.dropped) out.push(`  ✗ ${p.bold(d.id)}  ${oneLine(d.title, 70)}${p.dim(`  · ${d.suggested ? 'an AI idea, ' : ''}${d.why ? `dropped: ${oneLine(d.why, 90)}` : 'dropped, no reason given'}`)}`);
  for (const l of no.lessons) out.push(`  undone: "${oneLine(l, 110)}"`);

  out.push('', head(6, 'THE CODE', 'read it before you suggest: what is missing, what is rough, what will break'));
  out.push(`  ${w.code.root}`);
  if (w.code.readme) out.push(`  ${w.code.readme}`);
  for (const d of w.code.docs) out.push(`  ${d}`);

  out.push(
    '',
    p.bold('A GOOD IDEA'),
    '  - serves a goal above, and says which in its Why',
    '  - is something a user meets: a gap they will hit, the follow-up a finished thread makes obvious, something that will break',
    '  - is new: not in 3, not said no to in 5, not a chore for yourself',
    '  - is one thread: sized, with a What, a Why and a Done when',
    '',
    p.bold('FILE EACH'),
    '  spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "What: …\\nWhy: …\\nDone when: …"',
    p.dim('  It is proposed and marked AI suggested: nobody builds it, you included, until the user moves it to Build.'),
    p.dim('  Says "This looks like a thread already there"? It is a repeat: spool drop <its id> -m "already there".'),
    p.dim('  Then say in a line how many you filed; the board shows them in the backlog.'),
  );
  return out.join('\n');
}

/** `spool ideate`: print the worksheet for a pass of new ideas. */
export function ideate(call: Call): Result {
  const { ws, opts, p } = call;
  const spool = typeof opts.project === 'string' && opts.project ? ws.project(opts.project) : ws.home;
  let max: number | undefined;
  if (typeof opts.max === 'string') {
    max = Number(opts.max);
    if (!Number.isInteger(max) || max < 0 || max > 20) throw new SpoolError(`--max takes a number of ideas, 0 to 20, not "${opts.max}"`, 'spool ideate --max 8');
  }
  const sheet = gatherIdeas(ws, spool, max);
  return { text: ideasText(ws, sheet, p), data: sheet };
}
