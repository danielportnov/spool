/**
 * A sprint's words. What it is for is kept in its body as labelled lines (Goal, Why, Done when,
 * Serves), the same shape a thread's spec has. The human's own words for it, the vision it was
 * made from, are quoted above them, the way a thread keeps the note it came from.
 */

import { type Item, setMain, splitBody } from './model.ts';

/**
 * A sprint's goal, reason and done-when, read from the three lines of its body, the project goal
 * it serves, and the vision it was made from, in the human's words; and, once it is reached, the
 * version it became. Whatever else is in its body, and not quoted, is the goal.
 */
export function sprintAbout(sprint: Item): { goal: string; why: string; doneWhen: string; serves: string; vision: string; version: string } {
  const lines = splitBody(sprint.body).main.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('>'));
  const take = (label: string) => {
    const at = lines.findIndex((l) => l.toLowerCase().startsWith(`${label}:`));
    return at < 0 ? '' : lines.splice(at, 1)[0]!.slice(label.length + 1).trim();
  };
  const [why, doneWhen, serves, goal] = [take('why'), take('done when'), take('serves'), take('goal')];
  return { goal: goal || lines.join(' '), why, doneWhen, serves, vision: visionOf(sprint), version: sprint.version ?? '' };
}

const LOG = /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d(?::\d\d)?)Z ([^:]+): (.*)$/;

/** An item's log, a line at a time: when, who, and what. */
export function logOf(item: Item): { at: string; who: string; what: string }[] {
  return splitBody(item.body)
    .log.map((line) => LOG.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ at: `${m[1]}T${m[2]!.padEnd(8, ':00')}Z`, who: m[3]!, what: m[4]! }));
}

/** When a sprint was pressed play on, and when its last thread was done: from its own log. */
export function sprintDates(sprint: Item): { started: string; reached: string } {
  const log = logOf(sprint);
  const started = log.find((e) => e.what.startsWith('started: '))?.at ?? '';
  const reached = sprint.status === 'done' ? (log.filter((e) => e.what.startsWith('done: ')).at(-1)?.at ?? sprint.updated) : '';
  return { started, reached };
}

/** Set one labelled line of a sprint's body: in place where it has one, else after the rest. */
export function setLine(sprint: Item, label: string, value: string): void {
  const lines = splitBody(sprint.body).main.split('\n');
  const at = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`));
  const line = `${label}: ${value}`;
  if (at >= 0) lines[at] = line;
  else {
    // A line straight after a quote would be read as part of it.
    if (lines[lines.length - 1]?.startsWith('>')) lines.push('');
    lines.push(line);
  }
  setMain(sprint, lines.join('\n').trim());
}

/** Words quoted above the sprint's own lines, signed with where they came from. */
export function addQuote(sprint: Item, quote: string): void {
  setMain(sprint, [quote, splitBody(sprint.body).main].filter(Boolean).join('\n\n'));
}

/** Words the human gave as they are, as a quote signed as the vision. */
export function visionQuote(text: string, date: string): string {
  const quoted = text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return `${quoted}\n> — the vision, ${date}`;
}

/** The quoted words in a sprint's body, without their signatures: the vision it was made from. */
export function visionOf(sprint: Item): string {
  return splitBody(sprint.body)
    .main.split('\n')
    .filter((l) => l.startsWith('>') && !/^>\s*— /.test(l))
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
}
