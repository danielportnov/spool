/** Read the same record for the CLI and the ticket, without writing to Git or the spool. */

import * as path from 'node:path';
import { git, real, repoRoot } from './git.ts';
import { type Item, SpoolError, splitBody } from './model.ts';
import type { Workspace } from './store.ts';

const HISTORY_LIMIT = 500;
const READ_LIMITS = { maxBuffer: 4 * 1024 * 1024, timeout: 3000 };
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RECORDED_ID = /^[a-f0-9]{4,64}$/;
const THREAD_ID = /^t-?[a-z0-9]+$/i;

interface Commit {
  sha: string;
  subject: string;
  author: string;
  agent?: string;
  model?: string;
  version?: string;
  coauthors: string[];
  threads: string[];
  reverts: string[];
  restores: string[];
  undoes: string[];
}

interface Source {
  id: string;
  kind: Item['kind'];
  title: string;
  by?: string;
  words?: string;
}

interface Call {
  id: string;
  title: string;
  by?: string;
  status: string;
  choice?: string;
  reason: string;
  activity: string[];
}

export interface Lineage {
  target?: { ref: string; commit: Commit };
  thread?: { id: string; title: string; state: string; project: string; by?: string; summary?: string; version?: string; checked?: string };
  sources: Source[];
  calls: Call[];
  activity: string[];
  commits: Commit[];
  reverts: Commit[];
  undo?: { command: string; label: string };
  notice?: string;
}

interface Section {
  title: string;
  groups: string[];
}

function readGit(root: string, args: string[], input?: Buffer) {
  return git(root, ['--no-pager', '--literal-pathspecs', ...args], input, { GIT_NO_LAZY_FETCH: '1' }, READ_LIMITS);
}

function gitDirectory(root: string): string {
  const result = readGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return result.ok ? real(result.out) : '';
}

const LOG_FORMAT = '%H%x00%s%x00%an%x00%(trailers:only,unfold)%x00%b';

function readLog(root: string, args: string[], input?: Buffer): Commit[] {
  const result = readGit(root, ['log', '--no-patch', '--no-color', '--no-show-signature', '-z', '--format=' + LOG_FORMAT, ...args], input);
  // HEAD may be unborn, and an old recorded object may have disappeared.
  if (!result.ok) {
    if (/ETIMEDOUT|ENOBUFS/.test(result.err)) throw new SpoolError('Git history exceeded the lineage read limit');
    return [];
  }
  const fields = result.raw.split('\0');
  const commits: Commit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [sha, subject, author, rawTrailers, body] = fields.slice(i, i + 5) as [string, string, string, string, string];
    if (!OBJECT_ID.test(sha)) continue;
    const trailers = new Map<string, string[]>();
    for (const line of rawTrailers.split('\n')) {
      const match = /^([^:]+):\s*(.+)$/.exec(line);
      if (!match) continue;
      const key = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      trailers.set(key, [...(trailers.get(key) ?? []), value]);
    }
    commits.push({
      sha, subject, author,
      agent: trailers.get('spool-agent')?.[0],
      model: trailers.get('spool-model')?.[0],
      version: trailers.get('spool-version')?.[0],
      coauthors: trailers.get('co-authored-by') ?? [],
      threads: trailers.get('spool') ?? [],
      reverts: trailers.get('spool-revert') ?? [],
      restores: trailers.get('spool-restore') ?? [],
      undoes: Array.from(body.matchAll(/^This reverts commit ([a-f0-9]{40}|[a-f0-9]{64})\./gm), (match) => match[1]!),
    });
  }
  return commits;
}

function resolveTarget(root: string, cwd: string, ref: string): Commit {
  const location = /^(.+):(\d+)$/s.exec(ref);
  let sha: string | undefined;
  if (location) {
    const line = Number(location[2]);
    const file = path.relative(root, path.resolve(cwd, location[1]!));
    if (!file || file === '..' || file.startsWith('..' + path.sep)) throw new SpoolError('the file is outside this repository');
    if (!Number.isSafeInteger(line) || line <= 0) throw new SpoolError('line numbers start at 1');
    const blamed = readGit(root, ['blame', '--porcelain', '--no-textconv', '-L', `${line},${line}`, 'HEAD', '--', file]);
    sha = blamed.ok ? blamed.out.split(' ', 1)[0] : undefined;
    if (!sha || !OBJECT_ID.test(sha)) throw new SpoolError(`no committed line at ${ref}`, 'Give a file and line number as they appear in HEAD');
  } else {
    const resolved = readGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    if (resolved.ok && OBJECT_ID.test(resolved.out)) sha = resolved.out;
    if (!sha) throw new SpoolError(`no Git commit "${ref}"`);
  }
  const commit = readLog(root, ['-1', sha, '--'])[0];
  if (!commit) throw new SpoolError(`could not read Git commit ${sha}`);
  return commit;
}

function recordedCommits(root: string, refs: string[]): Commit[] {
  if (!refs.length) return [];
  // Ignore missing or ambiguous old shas individually, without losing the others in the batch.
  const checked = readGit(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], Buffer.from(refs.join('\n') + '\n'));
  if (!checked.ok) return [];
  const shas = checked.out.split('\n')
    .filter((line) => line.endsWith(' commit'))
    .map((line) => line.split(' ')[0]!)
    .filter((sha) => OBJECT_ID.test(sha));
  if (!shas.length) return [];
  return readLog(root, ['--no-walk=unsorted', '--stdin', '--'], Buffer.from(shas.join('\n') + '\n'));
}

function undoingCommits(root: string, shas: string[]): Commit[] {
  if (!shas.length) return [];
  const originals = new Set(shas);
  const pattern = `^This reverts commit (${shas.join('|')})[.]`;
  return readLog(root, ['-E', `--grep=${pattern}`, `--max-count=${HISTORY_LIMIT + 1}`, 'HEAD', '--'])
    .filter((commit) => commit.undoes.some((sha) => originals.has(sha)));
}

function linkedCommits(root: string, task: Item, selected?: Commit): { commits: Commit[]; reverts: Commit[]; cut: boolean } {
  const refs = [...new Set([...task.commits, ...task.reverted, ...(task.revert ? [task.revert] : [])])].filter((ref) => RECORDED_ID.test(ref));
  const matches = readLog(root, [
    `--max-count=${HISTORY_LIMIT + 1}`, '-E', `--grep=^Spool(-Revert|-Restore)?: ${task.id}[[:space:]]*$`, 'HEAD', '--',
  ]);
  const cut = matches.length > HISTORY_LIMIT || refs.length > HISTORY_LIMIT;
  const linked = new Map(matches.slice(0, HISTORY_LIMIT).map((c) => [c.sha, c]));
  const old = refs.slice(0, HISTORY_LIMIT).filter((ref) => !linked.has(ref));
  for (const c of recordedCommits(root, old)) linked.set(c.sha, c);
  if (selected) linked.set(selected.sha, selected);

  const reverts = new Map([...linked.values()]
    .filter((c) => c.reverts.includes(task.id) || c.restores.includes(task.id) || c.sha === task.revert)
    .map((c) => [c.sha, c]));
  // Old single-thread reverts cleared the originals. Shared reverts keep each thread's own list.
  const originals = new Set([...reverts.values()]
    .filter((c) => !c.restores.includes(task.id) && c.reverts.length <= 1)
    .flatMap((c) => c.undoes));
  const recovered = [...originals].filter((sha) => !linked.has(sha));
  for (const c of recordedCommits(root, recovered.slice(0, HISTORY_LIMIT))) linked.set(c.sha, c);
  const commits = [...linked.values()].filter((c) => !reverts.has(c.sha) && (
    c.threads.includes(task.id) || refs.some((ref) => c.sha.startsWith(ref)) ||
    (originals.has(c.sha) && !c.threads.length) || c.sha === selected?.sha
  ));
  const manual = undoingCommits(root, commits.map((c) => c.sha).slice(0, HISTORY_LIMIT));
  for (const c of manual.slice(0, HISTORY_LIMIT)) reverts.set(c.sha, c);
  return {
    commits: commits.filter((c) => !reverts.has(c.sha)),
    reverts: [...reverts.values()],
    cut: cut || recovered.length > HISTORY_LIMIT || manual.length > HISTORY_LIMIT || commits.length > HISTORY_LIMIT,
  };
}

function sourcesOf(ws: Workspace, task: Item): Source[] {
  const sources: Source[] = [];
  const seen = new Set([task.id]);
  const pending = [...task.from];
  for (const id of pending) {
    if (seen.has(id)) continue;
    seen.add(id);
    const source = ws.find(id);
    if (!source) continue;
    sources.push({
      id, kind: source.kind, title: source.title, by: source.by,
      words: source.kind === 'note' ? source.body : undefined,
    });
    pending.push(...source.from);
  }
  return sources;
}

function callsOf(ws: Workspace, task: Item, activity: string[]): Call[] {
  const logged = activity.flatMap((line) => Array.from(line.matchAll(/\b(?:waiting on|assumed|answered) (d-[a-z0-9]+)\b/g), (match) => match[1]!));
  const ids = new Set([...task.needs, ...task.from, ...logged]);
  // A reverted assumption is no longer a dependency, but the original call remains in the record.
  const calls: Call[] = [];
  for (const id of ids) {
    const item = ws.find(id);
    if (item?.kind !== 'decision') continue;
    const { main, log } = splitBody(item.body);
    const reason = main.split('\n').filter((line) => !line.startsWith(`For [[${task.id}]]`)).join('\n').trim();
    calls.push({ id, title: item.title, by: item.by, status: item.status, choice: item.choice, reason, activity: log });
  }
  return calls;
}

function empty(): Lineage {
  return { sources: [], calls: [], activity: [], commits: [], reverts: [] };
}

export function threadLineage(ws: Workspace, task: Item, root = repoRoot(task.spool.root), target?: Lineage['target']): Lineage {
  const activity = splitBody(task.body).log;
  const history = root ? linkedCommits(root, task, target?.commit) : { commits: [], reverts: [], cut: false };
  const command = `spool revert ${task.id}`;
  const undo = task.status === 'done' ? { command, label: 'Undo' } :
    task.revert && !task.commits.length && ['proposed', 'open'].includes(task.status) ? { command, label: 'Put the work back' } : undefined;
  return {
    target,
    thread: {
      id: task.id, title: task.title, state: task.archived ? 'archived' : task.status, project: task.spool.name,
      by: task.by, summary: task.summary, version: task.version, checked: task.checked,
    },
    sources: sourcesOf(ws, task), calls: callsOf(ws, task, activity), activity,
    commits: history.commits, reverts: history.reverts, undo,
    notice: history.cut ? `Showing up to ${HISTORY_LIMIT} entries from each Git history search.` : undefined,
  };
}

export function why(ws: Workspace, cwd: string, ref: string): Lineage {
  if (THREAD_ID.test(ref)) {
    // Tags and branches can also start with t. Give an exact thread or a t- prefix precedence.
    const key = ref.toLowerCase().replace(/^t([^-])/, 't-$1');
    if (ref.toLowerCase().startsWith('t-') || ws.find(key)?.kind === 'task') return threadLineage(ws, ws.get(ref, 'task'));
  }
  const root = repoRoot(cwd);
  if (!root) throw new SpoolError('there is no Git repository here', 'Use a thread id to see its queue history');
  const commit = resolveTarget(root, real(cwd), ref);
  const target = { ref, commit };
  const recordedFor = (shas: string[]): Item[] => ws.items.filter((item) => item.kind === 'task' &&
    [...item.commits, ...item.reverted, ...(item.revert ? [item.revert] : [])]
      .some((ref) => RECORDED_ID.test(ref) && shas.some((sha) => sha.startsWith(ref))));
  const candidates = recordedFor([commit.sha]);
  const trailers = [...commit.threads, ...commit.reverts, ...commit.restores];
  if (!trailers.length && !candidates.length && commit.undoes.length) {
    const originals = commit.undoes.slice(0, HISTORY_LIMIT);
    candidates.push(...recordedFor(originals));
    for (const original of recordedCommits(root, originals)) trailers.push(...original.threads, ...original.reverts);
  }
  if (!trailers.length && !candidates.length) {
    // Match the canonical line written by legacy Spool undo, then verify its trailers.
    trailers.push(...undoingCommits(root, [commit.sha]).flatMap((c) => c.reverts));
  }
  // A linked worktree has a different top-level path, but shares the same thread ledger.
  const directory = gitDirectory(root);
  const projectDirs = new Map([[root, directory]]);
  const tasks = [...new Set([...trailers.map((id) => ws.find(id)), ...candidates])].filter((item): item is Item => {
    if (item?.kind !== 'task') return false;
    const folder = item.spool.root;
    if (!projectDirs.has(folder)) projectDirs.set(folder, gitDirectory(folder));
    return !!directory && projectDirs.get(folder) === directory;
  });
  const exact = tasks.filter((item) => trailers.includes(item.id));
  const matches = exact.length ? exact : tasks;
  if (matches.length > 1) return {
    ...empty(), target,
    notice: `This commit is linked to ${matches.map((item) => item.id).join(', ')}. Run spool why with a thread id to see its history.`,
  };
  if (matches[0]) return threadLineage(ws, matches[0], root, target);
  return {
    ...empty(), target,
    notice: trailers.length ? `Thread ${[...new Set(trailers)].join(', ')} is missing from the local spool.` :
      commit.version ? `Version ${commit.version}.` : 'No Spool thread is on record for this commit.',
  };
}

function commitLine(c: Commit): string {
  const person = c.agent || c.coauthors.join(', ') || (c.author && `Git author ${c.author}`);
  return [`${c.sha.slice(0, 12)}  ${c.subject}`, person, c.model].filter(Boolean).join(' · ');
}

export function lineageSections(lineage: Lineage): Section[] {
  const { target, thread, sources, calls, activity, commits, reverts, undo, notice } = lineage;
  const sections: Section[] = [];
  if (target) sections.push({ title: 'Git lookup', groups: [target.ref, commitLine(target.commit)] });
  if (thread) sections.push({
    title: 'Thread',
    groups: [[`${thread.id}  ${thread.title}`, [thread.project, thread.state, thread.by].filter(Boolean).join(' · '),
      thread.summary, thread.version && `Version ${thread.version}`, thread.checked && `Check passed · ${thread.checked}`].filter(Boolean).join('\n')],
  });
  if (sources.length) sections.push({
    title: 'Sources',
    groups: sources.map((s) => s.kind === 'note' ? [[s.id, s.by].filter(Boolean).join(' · '), s.words].filter(Boolean).join('\n') : `${s.id}  ${s.title}`),
  });
  if (calls.length) sections.push({
    title: 'Calls',
    groups: calls.map((c) => [
      `${c.id}  ${c.title}`, [c.by, c.status, c.choice].filter(Boolean).join(' · '), c.reason, ...c.activity,
    ].filter(Boolean).join('\n')),
  });
  if (undo) sections.push({ title: undo.label, groups: [undo.command] });
  if (commits.length) sections.push({ title: 'Commits', groups: commits.map(commitLine) });
  if (reverts.length) sections.push({ title: 'Reverts', groups: reverts.map(commitLine) });
  if (activity.length) sections.push({ title: 'Activity', groups: [activity.map((line) => line.replace(/^- /, '')).join('\n')] });
  if (notice) sections.push({ title: 'Record', groups: [notice] });
  return sections;
}

export function lineageText(lineage: Lineage): string {
  return lineageSections(lineage).map(({ title, groups }) => `${title.toUpperCase()}\n${groups.join('\n\n')}`).join('\n\n');
}
