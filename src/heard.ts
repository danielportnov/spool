/**
 * What an agent said on a thread's run, read back from its transcript, by line number.
 *
 * A run's stream is kept whole under `.spool/runs/<thread>/`, one file a run (`stream.ts`,
 * `session.ts`). The page's runner keeps only the newest few lines of a run in memory, for a
 * card; a face that shows a whole session wants what came before those too, and then only what
 * is new each time it asks. So the lines are numbered from 0 as they were heard, and a caller
 * asks from a number on. The transcript is only ever added to, so a line's number never changes.
 *
 * The lines are the same ones the runner heard: each line of the file goes through `hearLine`.
 * A file is read once and then only where it has grown, since a transcript can be many megabytes
 * and is asked about every second while someone watches.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { hearLine } from './stream.ts';

export interface HeardRun {
  /** Which run this is: the name of its transcript, which is when it began. Empty where the thread was never run by a page. */
  run: string;
  /** The number of the first line given. */
  from: number;
  /** The number to ask from next time: one past the last line given. */
  next: number;
  lines: string[];
}

/** The most lines one answer carries. A caller that is further behind asks again from `next`. */
const MOST = 2000;
/** How many transcripts are kept read. More than the agents that run at once, so each watched one stays. */
const KEPT = 8;

/** A transcript as far as it has been read: how many bytes, the half line left at the end, and the lines heard. */
interface Read {
  bytes: number;
  rest: Buffer;
  lines: string[];
}

const read = new Map<string, Read>();

/** The lines one line of a transcript was heard as. What the agent printed on stderr is kept as an event of its own, and was heard as the text it is. */
function heard(raw: string): string[] {
  let line = raw;
  if (raw.startsWith('{"type":"stderr"')) {
    try {
      const event = JSON.parse(raw) as { text?: unknown };
      if (typeof event.text === 'string') line = event.text;
    } catch {
      // Not the event it looked like: heard as it is.
    }
  }
  return hearLine(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).lines.map((l) => l.slice(0, 400));
}

/** Every line heard in a transcript so far. Only whole lines count: the end of a line still being written waits for the rest of it. */
function linesOf(file: string): string[] {
  let kept = read.get(file) ?? { bytes: 0, rest: Buffer.alloc(0), lines: [] };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // Shorter than it was: not the file that was read. Start again.
    if (size < kept.bytes) kept = { bytes: 0, rest: Buffer.alloc(0), lines: [] };
    if (size > kept.bytes) {
      const more = Buffer.alloc(size - kept.bytes);
      const got = fs.readSync(fd, more, 0, more.length, kept.bytes);
      kept.bytes += got;
      // Cut at the last line break, which is never inside a letter, so no letter is read in halves.
      const data = Buffer.concat([kept.rest, more.subarray(0, got)]);
      const end = data.lastIndexOf(0x0a);
      kept.rest = end < 0 ? data : data.subarray(end + 1);
      if (end >= 0) for (const line of data.subarray(0, end).toString('utf8').split('\n')) kept.lines.push(...heard(line));
    }
  } finally {
    fs.closeSync(fd);
  }
  // The one just asked about is the last to be let go of.
  read.delete(file);
  read.set(file, kept);
  for (const old of [...read.keys()].slice(0, Math.max(0, read.size - KEPT))) read.delete(old);
  return kept.lines;
}

/**
 * A transcript's name: when its run began. Other things are kept in a thread's folder under
 * `runs/` (the journal of a run of changes to the queue, `journal.ts`), and are nothing an agent said.
 */
const TRANSCRIPT = /^\d{4}-\d\d-\d\dT[\d-]+Z\.jsonl$/;

/** The transcript of a thread's newest run, or nothing where it has none. Their names are the times they began, so the last by name is the newest. */
function newest(spoolDir: string, id: string): string | undefined {
  const dir = path.join(spoolDir, 'runs', id);
  try {
    const name = fs.readdirSync(dir).filter((f) => TRANSCRIPT.test(f)).sort().at(-1);
    return name ? path.join(dir, name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lines heard on a thread's current run, or its last one, from line `from` on. A negative
 * `from` counts from the end: -200 is the last 200. `run` is the run the caller's number belongs
 * to; where the newest run is another one, all of it is new to the caller, and it is given from
 * its start.
 */
export function heardRun(spoolDir: string, id: string, from = 0, run = ''): HeardRun {
  const file = newest(spoolDir, id);
  if (!file) return { run: '', from: 0, next: 0, lines: [] };
  const name = path.basename(file, '.jsonl');
  const all = linesOf(file);
  let first = run && run !== name ? 0 : Number.isInteger(from) ? from : 0;
  if (first < 0) first = Math.max(0, all.length + first);
  first = Math.min(first, all.length);
  const lines = all.slice(first, first + MOST);
  return { run: name, from: first, next: first + lines.length, lines };
}
