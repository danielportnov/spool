/**
 * Lessons: what the user undid, and why, kept so no agent has to be told twice.
 *
 * When the user reverts a thread and says why, that reason is the plainest feedback there is.
 * It is kept as a line in the project's own policy file (`.spool/policy.md`), under a heading of
 * its own, newest first: his words, the thread, the date. The policy is already what every worker
 * reads before it starts, and it is plain text he owns, so a lesson needs no new kind of item and
 * he can reword or delete one in any editor. `spool lessons --drop <n>` does it for him.
 *
 * Only the user's words become lessons. A revert with no reason keeps none, and nor does one an
 * agent runs as itself (`--as`, or `SPOOL_ACTOR` as the loop and the page set it).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, type Spool, SpoolError } from './model.ts';
import { DEFAULT_POLICY } from './prime.ts';
import type { Workspace } from './store.ts';

export const HEADING = '## What was undone here, and why';
const INTRO = 'Each line is a thread the user took back, and why, in their words. Agents read these before they\nwork. Reword or delete a line freely, or forget one with `spool lessons --drop <n>`.';
/** How many the worker's rules carry: the newest, since an old lesson may no longer hold. */
export const SHOWN = 10;

export interface Lesson {
  words: string;
  /** The thread it came from, when the line still names one. */
  thread?: string;
  /** YYYY-MM-DD, when the line still has one. */
  date?: string;
  spool: Spool;
  /** Its line in the policy file, 0-based, so it can be dropped. */
  line: number;
}

function policyFile(spool: Spool): string {
  return path.join(spool.dir, 'policy.md');
}

/** Where the lessons section runs in the policy's lines: [heading, end). */
function sectionOf(lines: string[]): [number, number] | undefined {
  const start = lines.findIndex((l) => /^##\s+what was undone here/i.test(l.trim()));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  return [start, end];
}

/** One lesson as it is written: `- "his words" (t-abcd, 2026-11-15)`. */
function lineOf(words: string, thread: string, date: string): string {
  return `- "${words.replace(/\s+/g, ' ').trim()}" (${thread}, ${date})`;
}

function parse(text: string, n: number, spool: Spool): Lesson | undefined {
  const m = /^\s*[-*]\s+(.*)$/.exec(text);
  if (!m) return undefined;
  let body = m[1]!.trim();
  const tail = /\s*\((t-[a-z0-9]+)(?:,\s*(\d{4}-\d{2}-\d{2}))?\)\s*$/.exec(body);
  if (tail) body = body.slice(0, tail.index).trim();
  const words = body.replace(/^["“](.*)["”]$/, '$1').trim();
  if (!words) return undefined;
  return { words, thread: tail?.[1], date: tail?.[2], spool, line: n };
}

/** One project's lessons, in the order its file keeps them: newest first. */
function lessonsIn(spool: Spool): Lesson[] {
  const file = policyFile(spool);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const section = sectionOf(lines);
  if (!section) return [];
  const out: Lesson[] = [];
  for (let i = section[0] + 1; i < section[1]; i++) {
    const lesson = parse(lines[i]!, i, spool);
    if (lesson) out.push(lesson);
  }
  return out;
}

/** Every lesson in the workspace, newest first. Numbered from 1 in this order for `--drop`. */
export function lessons(ws: Workspace): Lesson[] {
  const all = ws.spools.flatMap((s) => lessonsIn(s));
  // A stable sort keeps each file's own order among lessons of the same day, or with no date.
  return all.map((l, i) => ({ l, i })).sort((a, b) => (b.l.date ?? '').localeCompare(a.l.date ?? '') || a.i - b.i).map((x) => x.l);
}

/** The policy as the worker reads it, without the lessons: those are printed on their own, the newest few. */
export function withoutLessons(policy: string): string {
  const lines = policy.split('\n');
  const section = sectionOf(lines);
  if (!section) return policy;
  return [...lines.slice(0, section[0]), ...lines.slice(section[1])].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Keep the user's reason for undoing a thread, at the top of its project's lessons. */
function keepLesson(ws: Workspace, task: Item, words: string): Lesson {
  const file = policyFile(task.spool);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : DEFAULT_POLICY;
  const lines = text.replace(/\s+$/, '').split('\n');
  const line = lineOf(words, task.id, ws.now().toISOString().slice(0, 10));
  const section = sectionOf(lines);
  if (!section) {
    lines.push('', HEADING, '', ...INTRO.split('\n'), '', line);
  } else {
    const [start, end] = section;
    let at = lines.slice(start + 1, end).findIndex((l) => /^\s*[-*]\s/.test(l));
    if (at >= 0) at += start + 1;
    else {
      // No lessons yet under the heading: after whatever text is there, past a blank line.
      at = end;
      while (at > start + 1 && !lines[at - 1]!.trim()) at--;
      lines.splice(at, 0, '');
      at++;
      if (at < lines.length && lines[at]!.trim()) lines.splice(at, 0, '');
    }
    lines.splice(at, 0, line);
  }
  ws.writeQueue(task.spool, 'policy', `${lines.join('\n')}\n`);
  return lessonsIn(task.spool).find((l) => l.thread === task.id)!;
}

/**
 * What an undo does with its reason: kept as a lesson where it is the user's own, with the line
 * that tells them so. An undo with no reason keeps none, and nor does one an agent runs as itself.
 */
export function learn(ws: Workspace, task: Item, actor: string, why: string): { lesson?: Lesson; line?: string } {
  if (!why || actor !== 'human') return {};
  const lesson = keepLesson(ws, task, why);
  const n = lessons(ws).findIndex((l) => l.spool === lesson.spool && l.line === lesson.line) + 1;
  return { lesson, line: `Your reason is kept as a lesson every agent here reads first. To forget it: spool lessons --drop ${n}` };
}

/** Forget lesson n, as `spool lessons` numbers them. */
export function dropLesson(ws: Workspace, n: number): Lesson {
  const all = lessons(ws);
  const lesson = all[n - 1];
  if (!Number.isInteger(n) || !lesson) {
    throw new SpoolError(
      all.length ? `there is no lesson ${n}` : 'there are no lessons to drop',
      all.length ? `spool lessons numbers them 1 to ${all.length}` : undefined,
    );
  }
  const file = policyFile(lesson.spool);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.splice(lesson.line, 1);
  ws.writeQueue(lesson.spool, 'policy', lines.join('\n'));
  return lesson;
}

/** A lesson in one line, his words first. */
export function lessonLine(ws: Workspace, l: Lesson): string {
  const where = [l.thread, l.date, l.spool === ws.home ? '' : `in ${l.spool.name}`].filter(Boolean).join(', ');
  return `"${l.words}"${where ? ` (${where})` : ''}`;
}

/** The worker's section: the newest few, or nothing when nothing has been undone with a reason. */
export function lessonsSection(ws: Workspace): string {
  const shown = lessons(ws).slice(0, SHOWN);
  if (!shown.length) return '';
  return [
    'What was undone here, and why',
    '',
    'The user took these threads back and said why. Read them before you start, and do not do it again.',
    '',
    ...shown.map((l) => `- ${lessonLine(ws, l)}`),
    '',
  ].join('\n');
}

/** The threads a task comes from, itself first: a lesson from any of them is about this work. */
function lineage(ws: Workspace, task: Item): Set<string> {
  const seen = new Set<string>();
  const queue = [task.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = ws.find(id);
    if (item?.kind === 'task') queue.push(...item.from);
  }
  return seen;
}

/** The lessons a thread's brief names: those from itself, or from a thread it came from. */
export function lessonsFor(ws: Workspace, task: Item): Lesson[] {
  const mine = lineage(ws, task);
  return lessons(ws).filter((l) => l.thread && mine.has(l.thread));
}
