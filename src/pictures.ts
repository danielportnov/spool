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
 * told by their first bytes rather than their names. A thread keeps files the same way, for what a
 * picture cannot show: a PDF, told by its first bytes too, and plain text (a log, notes, a CSV, JSON)
 * where the name says text and the bytes are text. Text is only ever served as plain text, so
 * nothing kept can run as a page. The thread's log says who attached what, and
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
  /** The file's name in the thread's folder, as Spool named it: `3.png`, `4-before.webp`, `5.server-log.txt`. */
  name: string;
  /** Where it is on this machine. */
  path: string;
  as: As | null;
  /** A picture is shown; a file (a PDF, some text) is opened from a link. */
  kind: 'picture' | 'file';
  /** Who attached it, when, and what they said with it, read from the thread's log. */
  by: string;
  at: string;
  caption: string;
}

/** What the page serves each kind as. Text of every kind is plain text, never a page. */
export const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
} as const;
type Ext = keyof typeof TYPES;
const IMAGES = new Set<Ext>(['png', 'jpg', 'gif', 'webp']);
const TEXTS = ['txt', 'md', 'csv', 'json', 'log'] as const;

/** A name Spool gave: nothing else in the folder is kept, and nothing else is ever served. */
const NAME = /^(\d{1,4})(?:-(before|after))?(?:\.([a-z0-9][a-z0-9-]{0,39}))?\.(png|jpg|gif|webp|pdf|txt|md|csv|json|log)$/;

/** The log line an attach writes. The names are Spool's own, so they can be read back out of it. */
const LINE = /^attached (?:pictures?|files?) ((?:\d{1,4}(?:-before|-after)?(?:\.[a-z0-9][a-z0-9-]{0,39})?\.(?:png|jpg|gif|webp|pdf|txt|md|csv|json|log)(?:, )?)+)(?:: (.*))?$/;

/** Whether a name Spool gave is a picture's, to show, or a file's, to open. */
export const isPicture = (name: string): boolean => /\.(png|jpg|gif|webp)$/.test(name);

/** Read the names and the caption out of an attach line of a thread's log; null for any other line. */
export function attachLine(what: string): { names: string[]; caption: string } | null {
  const m = LINE.exec(what);
  return m ? { names: m[1]!.split(', ').filter((n) => NAME.test(n)), caption: m[2] ?? '' } : null;
}

/**
 * What kind of file the bytes are: a picture or a PDF by the way each format begins, text when the
 * name it came with says text and the bytes are UTF-8 with no NULs. Null for anything else.
 */
export function kindOf(bytes: Buffer, given = ''): Ext | null {
  const known = imageKind(bytes);
  if (known) return known;
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const ext = /\.([a-z0-9]+)$/i.exec(path.basename(given))?.[1]?.toLowerCase() ?? '';
  const asText = (TEXTS as readonly string[]).includes(ext) ? (ext as Ext) : null;
  if (!asText || !bytes.length || bytes.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return asText;
}

function imageKind(bytes: Buffer): Ext | null {
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
    const m = /^- (\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?Z) (.+?): (.*)$/.exec(line);
    const read = m && attachLine(m[3]!);
    if (read) for (const name of read.names) said.set(name, { by: m[2]!, at: m[1]!, caption: read.caption });
  }
  return names.map((name) => ({
    name,
    path: path.join(folderOf(task), name),
    as: (NAME.exec(name)![2] as As | undefined) ?? null,
    kind: isPicture(name) ? 'picture' : 'file',
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
  const ext = NAME.exec(name)![4] as Ext;
  // Read again as it is now: a file is served as the kind its name says only while its bytes still are that kind.
  const kind = kindOf(fs.readFileSync(file), name);
  return kind === ext ? { file, type: TYPES[kind] } : null;
}

/**
 * A file keeps what it was called, made safe: `Server Log (2).txt` is kept as `<n>.server-log-2.txt`,
 * so the human and the agent both know which it is. A picture needs no name; one pasted has none.
 */
function stem(shown: string): string {
  const base = path.basename(shown).replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return base && base !== 'pasted' ? `.${base}` : '';
}

/** Rounded up, so a file just over the limit never reads as the limit. */
function megabytes(n: number): string {
  return `${String(Math.ceil((n / 1024 / 1024) * 10) / 10)} MB`;
}

/** The refusal for a picture over the limit, said the same wherever it is found out. */
export function tooBig(shown: string, size: number): SpoolError {
  const picture = /\.(png|jpe?g|gif|webp)$/i.test(shown);
  return new SpoolError(
    `${shown} is ${megabytes(size)}: a ${picture ? 'picture' : 'file'} can be ${megabytes(MAX_BYTES)} at most`,
    picture ? 'Crop it to what matters, or save it as a JPEG' : 'Attach the part that matters',
  );
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
    const kind = kindOf(bytes, shown);
    if (!kind) {
      throw new SpoolError(
        `${shown} is not a picture or a file Spool keeps`,
        'It takes PNG, JPEG, GIF and WebP pictures, PDFs, and plain text (.txt .md .csv .json .log), told by what is in the file',
      );
    }
    return kind;
  });
  const have = namesIn(task);
  if (have.length + files.length > MAX_PICTURES) {
    throw new SpoolError(
      `${task.id} has ${have.length} ${have.length === 1 ? 'picture or file' : 'pictures and files'}, and a thread keeps ${MAX_PICTURES} at most`,
      'Attach the few that show it best',
    );
  }
  const dir = path.join(runDir(task.spool.dir, task.id), 'files');
  fs.mkdirSync(dir, { recursive: true });
  let n = Math.max(0, ...have.map((name) => Number(NAME.exec(name)![1])));
  const names = kinds.map((kind, i) => {
    const name = `${++n}${as ? `-${as}` : ''}${IMAGES.has(kind) ? '' : stem(files[i]!.shown)}.${kind}`;
    // Written aside and moved in, so the page never serves half a picture.
    const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(temp, files[i]!.bytes);
    fs.renameSync(temp, path.join(dir, name));
    return name;
  });
  const said = caption.replace(/\s+/g, ' ').trim();
  // Pictures and files are told apart in the line, so it reads right; the page and the brief go by the names.
  const what = names.every(isPicture) ? 'picture' : 'file';
  addLog(task, actor, `attached ${what}${names.length === 1 ? '' : 's'} ${names.join(', ')}${said ? `: ${said}` : ''}`, now);
  return picturesOf(task).filter((p) => names.includes(p.name));
}
