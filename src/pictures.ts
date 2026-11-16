/**
 * Pictures kept with a thread: what the human pasted to show what he means, and the before and
 * after an agent took as proof of a change anyone can see.
 *
 * They live beside the thread's run transcripts, under `.spool/runs/<id>/files/`, so they stay on
 * this machine and out of git the way those do (`runDir` in stream.ts keeps `runs/` ignored). The
 * journal of a run (journal.ts) keeps its own files in the same folder and never looks in `files/`,
 * so undoing a run leaves the pictures as they are.
 *
 * A picture is copied in and named by Spool: a number, and `before` or `after` where it is one, so
 * nothing of the path it came from is kept or ever served. Only PNG, JPEG, GIF and WebP are taken,
 * told by their first bytes rather than their names. The thread's log says who attached what, and
 * the caption: that line is where the page draws it in the conversation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Item, SpoolError, addLog, splitBody } from './model.ts';
import { runDir } from './stream.ts';

/** Bigger than this is a photo of a screen, not a screenshot. */
export const MAX_BYTES = 5 * 1024 * 1024;
/** A thread with more than this is a gallery, and an agent's brief would be all paths. */
export const MAX_PICTURES = 20;

export type As = 'before' | 'after';

export interface Picture {
  /** The file's name in the thread's folder, as Spool named it: `3.png`, `4-before.webp`. */
  name: string;
  /** Where it is on this machine. */
  path: string;
  as: As | null;
  /** Who attached it, when, and what they said with it, read from the thread's log. */
  by: string;
  at: string;
  caption: string;
}

/** What the page serves a picture as, by its kind. */
export const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
type Ext = keyof typeof TYPES;

/** A name Spool gave: nothing else in the folder is a picture, and nothing else is ever served. */
const NAME = /^(\d{1,4})(?:-(before|after))?\.(png|jpg|gif|webp)$/;

/** The log line an attach writes. The names are Spool's own, so they can be read back out of it. */
const LINE = /^attached pictures? ((?:\d{1,4}(?:-before|-after)?\.(?:png|jpg|gif|webp)(?:, )?)+)(?:: (.*))?$/;

/** Read the names and the caption out of an attach line of a thread's log; null for any other line. */
export function attachLine(what: string): { names: string[]; caption: string } | null {
  const m = LINE.exec(what);
  return m ? { names: m[1]!.split(', ').filter((n) => NAME.test(n)), caption: m[2] ?? '' } : null;
}

/** What kind of picture the bytes are, by the way each format begins; null for anything else. */
export function kindOf(bytes: Buffer): Ext | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The thread's folder of pictures. Nothing is made by asking. */
function folderOf(task: Item): string {
  return path.join(task.spool.dir, 'runs', task.id, 'files');
}

function namesIn(task: Item): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(folderOf(task));
  } catch {
    return [];
  }
  return names.filter((n) => NAME.test(n)).sort((a, b) => Number(NAME.exec(a)![1]) - Number(NAME.exec(b)![1]));
}

/** A thread's pictures, oldest first: what is on disk, with who attached each and what they said, from the log. */
export function picturesOf(task: Item): Picture[] {
  const names = namesIn(task);
  if (!names.length) return [];
  const said = new Map<string, { by: string; at: string; caption: string }>();
  for (const line of splitBody(task.body).log) {
    const m = /^- (\d{4}-\d\d-\d\d \d\d:\d\dZ) (.+?): (.*)$/.exec(line);
    const read = m && attachLine(m[3]!);
    if (read) for (const name of read.names) said.set(name, { by: m[2]!, at: m[1]!, caption: read.caption });
  }
  return names.map((name) => ({
    name,
    path: path.join(folderOf(task), name),
    as: (NAME.exec(name)![2] as As | undefined) ?? null,
    by: said.get(name)?.by ?? '',
    at: said.get(name)?.at ?? '',
    caption: said.get(name)?.caption ?? '',
  }));
}

/**
 * The file of one of a thread's pictures, and its type, by the name the page asks for. A name that is
 * not one Spool gave, or not in that thread's folder, is nothing: no path from a request ever
 * reaches the disk.
 */
export function pictureFile(task: Item, name: string): { file: string; type: string } | null {
  if (!NAME.test(name) || !namesIn(task).includes(name)) return null;
  const file = path.join(folderOf(task), name);
  const kind = kindOf(fs.readFileSync(file).subarray(0, 16));
  return kind ? { file, type: TYPES[kind] } : null;
}

/** Rounded up, so a file just over the limit never reads as the limit. */
function megabytes(n: number): string {
  return `${String(Math.ceil((n / 1024 / 1024) * 10) / 10)} MB`;
}

/** The refusal for a picture over the limit, said the same wherever it is found out. */
export function tooBig(shown: string, size: number): SpoolError {
  return new SpoolError(`${shown} is ${megabytes(size)}: a picture can be ${megabytes(MAX_BYTES)} at most`, 'Crop it to what matters, or save it as a JPEG');
}

/**
 * Copy pictures in and say so on the thread's log, in one line. Every file is checked before any is
 * copied, so a refusal leaves the thread as it was. `shown` is how each file is named in a refusal.
 */
export function attach(task: Item, files: { bytes: Buffer; shown: string }[], as: As | null, caption: string, actor: string, now: Date): Picture[] {
  if (task.kind !== 'task') throw new SpoolError(`${task.id} is not a thread`, 'Pictures are kept with a thread: spool attach <t-id> <file>');
  if (task.status === 'dropped') throw new SpoolError(`${task.id} was dropped`, 'Attach it to the thread that carries the work on');
  if (!files.length) throw new SpoolError('which picture?', 'spool attach <t-id> <file…>');
  const kinds = files.map(({ bytes, shown }) => {
    if (bytes.length > MAX_BYTES) throw tooBig(shown, bytes.length);
    const kind = kindOf(bytes);
    if (!kind) throw new SpoolError(`${shown} is not a picture Spool keeps`, 'It takes PNG, JPEG, GIF and WebP, told by what is in the file, not its name');
    return kind;
  });
  const have = namesIn(task);
  if (have.length + files.length > MAX_PICTURES) {
    throw new SpoolError(
      `${task.id} has ${have.length} ${have.length === 1 ? 'picture' : 'pictures'}, and a thread keeps ${MAX_PICTURES} at most`,
      'Attach the few that show it best',
    );
  }
  const dir = path.join(runDir(task.spool.dir, task.id), 'files');
  fs.mkdirSync(dir, { recursive: true });
  let n = Math.max(0, ...have.map((name) => Number(NAME.exec(name)![1])));
  const names = kinds.map((kind, i) => {
    const name = `${++n}${as ? `-${as}` : ''}.${kind}`;
    // Written aside and moved in, so the page never serves half a picture.
    const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(temp, files[i]!.bytes);
    fs.renameSync(temp, path.join(dir, name));
    return name;
  });
  const said = caption.replace(/\s+/g, ' ').trim();
  addLog(task, actor, `attached ${names.length === 1 ? 'picture' : 'pictures'} ${names.join(', ')}${said ? `: ${said}` : ''}`, now);
  return picturesOf(task).filter((p) => names.includes(p.name));
}
