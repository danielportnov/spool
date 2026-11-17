/**
 * Work that landed on no thread: commits on the project's branch that no thread owns, and files in
 * the project folder that git does not know about. Undo and lineage only reach what is on a thread,
 * so `spool status`, the brief and `spool doctor` name these, and `spool adopt` puts a commit on one.
 *
 * A commit is on a thread when its message carries a `Spool:` trailer, a `Spool-Revert:` trailer
 * (the commit that undid one), or a `Spool-Restore:` trailer (work put back after an undo), or when
 * some thread lists it in its `commits:`, which is how many older commits are linked. A version
 * commit is on no thread by design: it carries `Spool-Version:`, and one titled `Version x.y.z`
 * without it is taken as one too.
 *
 * It looks no further back than the oldest commit already on a thread: history from before Spool
 * landed anything is not its business. Only the newest few are named; the rest are a count.
 */

import * as path from 'node:path';
import type { Command } from './commands.ts';
import { git, real, repoRoot, resolveCommit } from './git.ts';
import { type Item, SpoolError, addLog, oneLine } from './model.ts';
import type { Spool } from './model.ts';
import type { Workspace } from './store.ts';

/** How far back it reads at most, so a long history costs one bounded call. */
const DEPTH = 500;
/** How many it names; the rest are a count. */
export const SHOWN = 3;
/**
 * Top-level folders an agent harness or an editor keeps its own settings and skills in. They are
 * the user's tooling, not work, so an untracked one is left out.
 */
export const TOOLING = ['.claude', '.codex', '.cursor', '.gemini', '.agents', '.vscode', '.idea', '.zed', '.fleet'];

const VERSION_TITLE = /^Version v?\d+\.\d+\.\d+\S*\s*$/;

export interface Stray {
  sha: string;
  short: string;
  subject: string;
}

export interface Strays {
  /** Commits on no thread, newest first: all of them, for --json; the text names the first few. */
  commits: Stray[];
  /** Version commits in the same span, which are on no thread by design. */
  versions: number;
  /** Untracked files and folders in the project folder, as git shows them (a new folder is one line). */
  untracked: string[];
  /** The oldest commit on a thread: nothing older is looked at. Null when nothing has landed on one yet. */
  from: string | null;
}

/** Every sha the workspace's threads list in their `commits:`. */
function listed(ws: Workspace): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const i of ws.items) for (const sha of i.commits ?? []) out.set(sha, i);
  return out;
}

/** The thread that lists `sha`: a list may hold it whole or by a short prefix. */
function listing(lists: Map<string, Item>, sha: string): Item | undefined {
  const whole = lists.get(sha);
  if (whole) return whole;
  for (const [full, item] of lists) if (full.length < 40 && sha.startsWith(full)) return item;
  return undefined;
}

/** The thread a commit is already on, by its trailer or a thread's list; undefined when none. */
function ownerOf(ws: Workspace, sha: string, trailer: string): string | undefined {
  return trailer || listing(listed(ws), sha)?.id;
}

/** The pathspec for a spool's own folder within its repository, leaving out the spool directory and any project inside it. */
function scope(ws: Workspace, spool: Spool, top: string): string[] {
  const rel = (dir: string) => path.relative(top, real(dir)).split(path.sep).join('/');
  const own = rel(spool.root);
  const inner = ws.spools.filter((s) => s !== spool && real(s.root).startsWith(real(spool.root) + path.sep)).map((s) => rel(s.root));
  return ['--', own ? `:(top)${own}` : ':(top)', `:(top,exclude)${rel(spool.dir)}`, ...inner.map((r) => `:(top,exclude)${r}`)];
}

/** What landed on no thread in this spool's folder. Null where it is not in a git repository with a commit. */
export function straysOf(ws: Workspace, spool: Spool): Strays | null {
  const top = repoRoot(spool.root);
  if (!top || !git(spool.root, ['rev-parse', '--verify', '-q', 'HEAD']).ok) return null;
  const spec = scope(ws, spool, top);
  const FIELDS = '%H%x1f%s%x1f%(trailers:key=Spool,valueonly,separator=%x2C)%(trailers:key=Spool-Revert,valueonly,separator=%x2C)%(trailers:key=Spool-Restore,valueonly,separator=%x2C)%x1f%(trailers:key=Spool-Version,valueonly)%x1e';
  const log = git(spool.root, ['log', '--no-merges', `-n${DEPTH}`, `--format=${FIELDS}`, 'HEAD', ...spec]);
  const rows = (log.ok ? log.raw : '')
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha = '', subject = '', trailer = '', version = ''] = r.split('\x1f');
      return { sha, subject, trailer: trailer.trim(), version: version.trim() };
    });
  const lists = listed(ws);
  const onThread = (sha: string, trailer: string) => !!trailer || !!listing(lists, sha);
  // History is newest first: the oldest commit on a thread is the last one that is.
  let end = -1;
  rows.forEach((r, i) => {
    if (onThread(r.sha, r.trailer)) end = i;
  });
  const span = end < 0 ? [] : rows.slice(0, end);
  const version = (r: (typeof rows)[number]) => !!r.version || VERSION_TITLE.test(r.subject);
  const commits = span
    .filter((r) => !onThread(r.sha, r.trailer) && !version(r))
    .map((r) => ({ sha: r.sha, short: r.sha.slice(0, 7), subject: r.subject }));

  const status = git(spool.root, ['status', '--porcelain', '-z', '--untracked-files=normal', ...spec]);
  const here = path.relative(top, real(spool.root)).split(path.sep).join('/');
  const untracked = (status.ok ? status.raw : '')
    .split('\0')
    .filter((e) => e.startsWith('?? '))
    .map((e) => e.slice(3))
    .map((p) => (here ? p.slice(here.length + 1) : p))
    .filter((p) => !TOOLING.includes(p.split('/')[0]!));
  return { commits, versions: span.filter(version).length, untracked, from: end < 0 ? null : rows[end]!.sha };
}

/** The few lines that say it, for status and the brief: a head line a kind, then the newest few under it. */
export function strayLines(s: Strays | null, width = 64): string[] {
  if (!s) return [];
  const out: string[] = [];
  const more = (n: number) => (n > SHOWN ? [`  … and ${n - SHOWN} more`] : []);
  if (s.commits.length) {
    out.push(`${s.commits.length === 1 ? 'a commit' : `${s.commits.length} commits`} landed on no thread:`);
    out.push(...s.commits.slice(0, SHOWN).map((c) => `  ${c.short} ${oneLine(c.subject, width)}`), ...more(s.commits.length));
  }
  if (s.untracked.length) {
    out.push(`${s.untracked.length === 1 ? 'a file' : `${s.untracked.length} files`} in the project folder on no thread, not in git:`);
    out.push(...s.untracked.slice(0, SHOWN).map((f) => `  ${f}`), ...more(s.untracked.length));
  }
  return out;
}

/** What puts each right, one line a kind. */
export function strayFixes(s: Strays | null): string[] {
  if (!s) return [];
  return [
    ...(s.commits.length ? ['spool adopt <sha> --for <t-id> puts a commit on its thread'] : []),
    ...(s.untracked.length ? ['commit a file on a thread, delete it, or add it to .gitignore'] : []),
  ];
}

export const ADOPT: Command = {
  name: 'adopt',
  group: 'agents',
  usage: 'adopt <sha…> --for <t-id>',
  summary: 'Put a commit that landed on no thread on the thread it belongs to, so it is undone and traced with it',
  write: true,
  options: { for: { type: 'string' } },
  run(call) {
    const { ws, args, opts, actor, p } = call;
    const ref = typeof opts.for === 'string' ? opts.for : '';
    if (!args.length) throw new SpoolError('which commit?', 'spool adopt <sha> --for <t-id>');
    if (!ref) throw new SpoolError('which thread it goes on is missing', `spool adopt ${args[0]} --for <t-id>`);
    const task = ws.get(ref, 'task');
    const root = repoRoot(task.spool.root);
    if (!root) throw new SpoolError(`${task.spool.root} is not a git repository`);
    const adopted: Stray[] = [];
    for (const given of args) {
      const sha = resolveCommit(root, given);
      if (!sha) throw new SpoolError(`there is no commit ${given}`, 'Name one from git log, or from spool status');
      if (!git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok) {
        throw new SpoolError(`${sha.slice(0, 7)} is not on this branch`, 'Only work that landed is put on a thread');
      }
      const trailer = git(root, ['log', '-1', '--format=%(trailers:key=Spool,valueonly,separator=%x2C)', sha]).out.trim();
      const owner = ownerOf(ws, sha, trailer);
      if (owner === task.id) throw new SpoolError(`${sha.slice(0, 7)} is on ${task.id} already`);
      if (owner) throw new SpoolError(`${sha.slice(0, 7)} is on ${owner} already`, `spool show ${owner}`);
      const subject = git(root, ['log', '-1', '--format=%s', sha]).out;
      task.commits = [...(task.commits ?? []), sha];
      adopted.push({ sha, short: sha.slice(0, 7), subject });
    }
    addLog(task, actor, `adopted ${adopted.map((c) => `${c.short} “${oneLine(c.subject, 60)}”`).join(', ')}: landed on no thread, now on this one`, ws.now());
    ws.save(task);
    return {
      text: [
        `${adopted.length === 1 ? `${adopted[0]!.short} is` : `${adopted.length} commits are`} on ${p.bold(task.id)} now: spool revert ${task.id} takes ${adopted.length === 1 ? 'it' : 'them'} back with the rest.`,
      ].join('\n'),
      data: { id: task.id, adopted: adopted.map((c) => c.sha) },
    };
  },
};
