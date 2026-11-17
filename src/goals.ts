/**
 * Goals: one short page on where a project is going, kept beside its policy in
 * `.spool/goals.md`. It is the user's in the end: agents write it on their word
 * and keep it true, and every agent reads it before it works.
 *
 * The page is plain markdown. A `For:` line says what the project is for, and
 * each item of a list is a thing it is heading towards. A line in brackets is
 * the starter's blank still to fill in, and counts as nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Spool } from './model.ts';

export const GOALS_STARTER = `# Goals

<!-- Where this project is going, in plain words: what it is for, and the two or three things
it is heading towards. Agents read it before they work, and keep it true with you. -->

For: (what this project is for, in one line)

- (something it is heading towards, in a few words)
`;

export function goalsFile(spool: Spool): string {
  return path.join(spool.dir, 'goals.md');
}

/** The page as it is, without the notes in comments; empty where there is none. */
export function goalsText(spool: Spool): string {
  try {
    return fs.readFileSync(goalsFile(spool), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

export interface Goals {
  /** What the project is for, in a line. */
  for: string;
  /** The things it is heading towards. */
  towards: string[];
}

const blank = (s: string) => !s || /^\(.*\)$/.test(s);

/** What the page says, or nothing while it is missing or still the starter. */
export function goalsOf(spool: Spool): Goals | undefined {
  const text = goalsText(spool);
  let purpose = '';
  const towards: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const label = /^\**for\**:\s*(.*)$/i.exec(line);
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (label) purpose = blank(label[1]!.trim()) ? '' : label[1]!.trim();
    else if (item && !blank(item[1]!.trim())) towards.push(item[1]!.trim());
    // A page written without the label: its first plain line says what the project is for.
    else if (!purpose && !item && line && !line.startsWith('#') && !blank(line)) purpose = line;
  }
  return purpose || towards.length ? { for: purpose, towards } : undefined;
}
