/**
 * The manager's worksheet: the facts a pass over the backlog starts from, and the report it ends on.
 *
 * Keeping a backlog in order is judgment: has this shipped, are these two one wish, what comes
 * first. Spool makes none of those calls, and calls no model. What it does is gather what the
 * judgment needs, in plain code and the same way every time, so the agent that does the judging
 * starts from one list and not from whatever it happened to read:
 *
 *   0  what was said no to before: every drop with its reason, the archive, the lessons, and
 *      what became of the last runs' ideas
 *   1  for each open thread, the evidence that it may already have shipped. Never a verdict
 *   2  pairs that look alike
 *   3  threads gone cold
 *   4  threads with no size, and with no Why
 *   5  threads too big to build in one go
 *   6  the order as it stands, and every priority the human set
 *
 * `spool manage --start` opens a run (journal.ts) on a thread of its own and prints the worksheet.
 * The agent then works through it with ordinary commands, each one journaled under the run.
 * `spool manage --end` writes the report from that journal, under whatever the agent has to say,
 * and finishes the run's thread with it. One `spool revert` of that thread takes it all back.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLEANUP_RULE, type CleanupAsk, takeCleanup } from './cleanup.ts';
import { COMMANDS, type Call, type Result } from './commands.ts';
import { git, repoRoot } from './git.ts';
import { type Leave, allowed, leaveLine, leaveOfRun, runUnder, settle } from './leave.ts';
import { lessons } from './lessons.ts';
import {
  type Item,
  type Kind,
  RUN_TAG,
  type Spool,
  SpoolError,
  addLog,
  isRun,
  oneLine,
  reportFile,
  splitBody,
  timestamp,
  tokens,
  whyOf,
} from './model.ts';
import { PROPOSABLE, type Proposal, type Verb, proposalLine, readProposals, unanswered, writeProposals } from './proposals.ts';
import { type Paint, age, itemJson, itemLine, paint } from './render.ts';
import { type Entry, readJournal, startJournal } from './journal.ts';
import { buildLine, effort, openRun, taskState, tasks } from './schedule.ts';
import { SIMILAR, alikeIn, compare, droppedBecause, wordsOf } from './similar.ts';
import { SPOOL_DIR, type Workspace } from './store.ts';
import { TIDIED, tidyDue } from './takeover.ts';
import { agentOf } from './usage.ts';

/** The numbers, in one place so they are easy to change. */
export const MANAGE = {
  /** Proposed, and untouched this many days, is cold. */
  coldDays: 30,
  /** A thread the human wrote on this lately is theirs to move. */
  handsOffDays: 7,
  /** New ideas a run may file. */
  proposals: 5,
  /** With this many earlier ideas still unanswered, a run files none: the human has enough to answer. */
  waiting: 10,
  /** Earlier runs a new one reads the outcome of. */
  runsRead: 3,
  /** A commit, a changelog entry or a test is evidence when it shares this many words with the title, and this share of the shorter of the two. */
  minShared: 3,
  minShare: 0.5,
  /** A word in this share of the project's titles, and in at least this many, is too usual to count. */
  usualShare: 0.08,
  usualAtLeast: 5,
  /** Lines of each kind of evidence shown for a thread. */
  shown: 3,
  /** Commits looked through, newest first. */
  commits: 2000,
} as const;

const DAY = 86_400_000;
/** Open, and not being built: what a pass over the backlog reads. */
const WAITING = ['proposed', 'ready', 'blocked', 'stale', 'held'];

const SPEC = `What: one pass over the backlog. What has shipped is marked, what has no size is sized, what is doubled or cold is named, the order is set and a few ideas are proposed.
Why: so the backlog is in order without the human sorting it.
Done when: the report is on this thread, and undoing this thread takes back everything the pass changed.`;

// -------------------------------------------------------------------- facts

interface Ref {
  id: string;
  title: string;
  state: string;
  priority: number;
  size: string | null;
  /** Why the manager leaves it as it is, where it must. */
  handsOff: string | null;
}

export interface Evidence {
  /** Commits that carry the thread's own id: it was worked on, and never finished. */
  own: { sha: string; date: string; subject: string }[];
  /** Commits since it was filed whose subject says what its title says. */
  commits: { sha: string; date: string; subject: string; thread: string | null; words: string[] }[];
  /** Finished threads that look like it. */
  finished: { id: string; title: string; summary: string | null; commits: string[]; words: string[] }[];
  changelog: { version: string; line: string; words: string[] }[];
  tests: { file: string; name: string; words: string[] }[];
}

export interface Worksheet {
  run: string;
  project: string;
  /** Open threads read: everything waiting, in the backlog or in Build. */
  open: number;
  /** The leave the run is under: how far the human said it may go. Null: it tidies only. */
  leave: Leave | null;
  /** The human asked for this pass with Clean Up on the board: every drop and archive is theirs to say yes to. */
  asked: CleanupAsk | null;
  /** The chat that builds ran this pass itself, taking over the backlog: it sizes and orders, and proposes every drop and archive. */
  tidy?: boolean;
  /** New ideas the run may file: five, or what the leave says; none while too many still wait. */
  proposals: { cap: number; unanswered: number };
  saidNo: {
    dropped: { id: string; title: string; why: string | null; by: string | null; when: string }[];
    archived: { id: string; title: string; when: string }[];
    lessons: { words: string; thread: string | null; date: string | null }[];
    runs: { id: string; date: string; headline: string | null; undone: { why: string | null } | null; filed: { id: string; title: string; outcome: string }[] }[];
  };
  shipped: (Ref & { evidence: Evidence })[];
  alike: { a: Ref; b: Ref; words: string[]; merge: string }[];
  cold: (Ref & { days: number })[];
  noSize: Ref[];
  noWhy: Ref[];
  tooBig: Ref[];
  order: {
    /** The backlog as it ranks now: most urgent first, then the smallest, then the oldest. */
    backlog: Ref[];
    /** Every priority the human set, read from the threads' logs. */
    humanSet: { id: string; title: string; set: number; now: number; when: string }[];
    /** Build's line, in the order it will be built. Never the manager's to change. */
    build: Ref[];
  };
  handsOff: { id: string; title: string; why: string }[];
}

interface Note {
  at: number;
  /** YYYY-MM-DDTHH:MM, to hold against the minute a run wrote. */
  minute: string;
  actor: string;
  text: string;
}

function logOf(item: Item): Note[] {
  const out: Note[] = [];
  for (const line of splitBody(item.body).log) {
    const m = /^- (\d{4}-\d\d-\d\d) (\d\d:\d\d(?::\d\d)?)Z ([^:]+): (.*)$/.exec(line);
    if (m) out.push({ at: Date.parse(`${m[1]}T${m[2]}Z`), minute: `${m[1]}T${m[2]!.slice(0, 5)}`, actor: m[3]!, text: m[4]! });
  }
  return out;
}

/** How long ago, as a person says it. */
function since(at: number | string, now: Date): string {
  const span = age(typeof at === 'string' ? at : new Date(at).toISOString(), now);
  return span === 'now' ? 'just now' : `${span} ago`;
}

/** Why the manager leaves a thread as it is: it is in Build, on hold, or the human has just had a hand on it. */
function handsOff(ws: Workspace, t: Item): string | null {
  const state = taskState(ws, t);
  const now = ws.now();
  if (state === 'active') return 'being built';
  if (state === 'ready' || state === 'blocked' || state === 'stale') return 'in Build';
  // Held is held, in the backlog as much as in Build. An agent's own idea is the exception: where
  // there is no gate it waits on hold for a yes, and is still the agents' to tidy.
  if (t.hold && !t.suggested) return 'on hold';
  const lately = (at: number) => now.getTime() - at < MANAGE.handsOffDays * DAY;
  const theirs = logOf(t).filter((n) => n.actor === 'human');
  const changed = theirs.at(-1);
  if (changed && lately(changed.at)) return `the human changed it ${since(changed.at, now)}`;
  // What they say on a thread arrives as a note filed into it, with no line in the log.
  const said = t.from
    .map((id) => ws.find(id))
    .filter((n): n is Item => n?.kind === 'note')
    .map((n) => Date.parse(n.created))
    .sort((a, b) => a - b)
    .at(-1);
  if (said !== undefined && lately(said)) return `the human wrote on it ${since(said, now)}`;
  if (t.sprint && theirs.some((n) => /^edited: .*\bsprint /.test(n.text))) return 'the human put it in a sprint';
  return null;
}

/** Every thread the manager leaves as it is, and why. */
function handsOffIn(ws: Workspace, spool: Spool): { id: string; title: string; why: string }[] {
  return tasks(ws, spool)
    .filter((t) => !isRun(t) && [...WAITING, 'active'].includes(taskState(ws, t)))
    .map((t) => ({ id: t.id, title: t.title, why: handsOff(ws, t) }))
    .filter((h): h is { id: string; title: string; why: string } => !!h.why);
}

/** The priority the human last set on a thread, from its log. */
function humanSet(t: Item): { priority: number; at: number } | null {
  for (const note of logOf(t).reverse()) {
    const m = note.actor === 'human' ? /^edited: .*\bpriority p([0-3])\b/.exec(note.text) : null;
    if (m) return { priority: Number(m[1]), at: note.at };
  }
  return null;
}

/**
 * Words so usual in this project's titles that sharing them says nothing: here, "page" and
 * "thread". They are left out of every comparison below, or half the backlog looks shipped.
 */
function usualWords(threads: Item[]): Set<string> {
  const seen = new Map<string, number>();
  for (const t of threads) for (const word of tokens(t.title)) seen.set(word, (seen.get(word) ?? 0) + 1);
  const bar = Math.max(MANAGE.usualAtLeast, Math.ceil(threads.length * MANAGE.usualShare));
  return new Set([...seen].filter(([, n]) => n >= bar).map(([word]) => word));
}

function without(words: Set<string>, usual: Set<string>): Set<string> {
  return new Set([...words].filter((w) => !usual.has(w)));
}

/** The words a line of evidence is held against: the thread's title, or with a very short title, its first line too. */
function wanted(t: Item, usual: Set<string>): Set<string> {
  const title = without(tokens(t.title), usual);
  return title.size >= MANAGE.minShared ? title : without(wordsOf(t), usual);
}

/** The words a line has in common with a title, if they are enough for it to be saying the same thing: most of the shorter of the two. */
function says(want: Set<string>, line: Set<string>): string[] {
  const shared = [...want].filter((w) => line.has(w));
  return shared.length >= MANAGE.minShared && shared.length >= MANAGE.minShare * Math.min(want.size, line.size) ? shared : [];
}

interface Commit {
  sha: string;
  at: number;
  subject: string;
  /** The thread its `Spool:` trailer names. */
  thread: string | null;
  words: Set<string>;
}

/** The project's commits, newest first, without the ones a later commit took back and without the queue's own. */
function commitsOf(spool: Spool): Commit[] {
  if (!repoRoot(spool.root)) return [];
  const log = git(spool.root, ['log', '-n', String(MANAGE.commits), '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', '--', '.', `:(exclude)${SPOOL_DIR}`]);
  if (!log.ok) return [];
  const all = log.out
    .split('\x1e')
    .map((record) => record.trim().split('\x1f'))
    .filter((f) => f.length >= 3)
    .map(([sha, date, subject, body = '']) => ({ sha: sha!, at: Date.parse(date!), subject: subject!, body }));
  const reverted = new Set(all.flatMap((c) => [...c.body.matchAll(/This reverts commit ([0-9a-f]{40})/g)].map((m) => m[1]!)));
  return all
    .filter((c) => !reverted.has(c.sha) && !/^Revert "/.test(c.subject))
    .map((c) => ({ sha: c.sha, at: c.at, subject: c.subject, thread: /^Spool: (\S+)\s*$/m.exec(c.body)?.[1] ?? null, words: tokens(c.subject) }));
}

/** The changelog's entries, each under the heading it sits below. A wrapped entry is read as one. */
function changelogOf(spool: Spool): { version: string; line: string; words: Set<string> }[] {
  const file = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md'].map((name) => path.join(spool.root, name)).find((f) => fs.existsSync(f));
  if (!file) return [];
  const out: { version: string; line: string; words: Set<string> }[] = [];
  let version = '';
  let entry: string[] = [];
  const flush = () => {
    const line = entry.join(' ').replace(/\s+/g, ' ').trim();
    if (line) out.push({ version, line, words: tokens(line) });
    entry = [];
  };
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const heading = /^#{1,4}\s+(.+)$/.exec(raw);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (heading) {
      flush();
      version = heading[1]!.trim();
    } else if (bullet) {
      flush();
      entry = [bullet[1]!];
    } else if (entry.length && raw.trim()) entry.push(raw.trim());
    else flush();
  }
  flush();
  return out;
}

const TEST_FILE = /(^|\/)(tests?|specs?|__tests__)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+$/i;
const TEST_TITLE = /\b(?:test|it|describe|scenario|specify)(?:\.\w+)?\s*\(\s*(['"`])((?:(?!\1).)+)\1/;
const TEST_NAMED = /\b(?:def|func|fn|function|void)\s+(test\w+)/i;

/** What the project's tests are called, from the test files git knows of. */
function testsOf(spool: Spool): { file: string; name: string; words: Set<string> }[] {
  if (!repoRoot(spool.root)) return [];
  const listed = git(spool.root, ['ls-files', '-z', '--', '.']);
  if (!listed.ok) return [];
  const out: { file: string; name: string; words: Set<string> }[] = [];
  for (const file of listed.raw.split('\0').filter((f) => f && TEST_FILE.test(f)).slice(0, 400)) {
    let text: string;
    try {
      const full = path.join(spool.root, file);
      if (fs.statSync(full).size > 512 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const name = TEST_TITLE.exec(line)?.[2] ?? TEST_NAMED.exec(line)?.[1]?.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
      if (name) out.push({ file, name, words: tokens(name) });
    }
  }
  return out;
}

/** When someone other than a run last touched a thread: a run's own sizing must not keep a thread warm for ever. */
function touched(t: Item, byRuns: Map<string, Set<string>>): number {
  const minutes = byRuns.get(t.id);
  if (!minutes?.has(t.updated.slice(0, 16))) return Date.parse(t.updated);
  const own = logOf(t).filter((n) => !minutes.has(n.minute)).at(-1);
  return Math.max(Date.parse(t.created), own?.at ?? 0);
}

/** What became of an idea an earlier run filed: the human's answer to it, or that there is none yet. */
function outcome(ws: Workspace, item: Item | undefined): string {
  if (!item) return 'gone';
  const state = taskState(ws, item);
  if (state === 'proposed' || state === 'held') return 'not answered yet';
  if (state === 'dropped') return `dropped${droppedBecause(item) ? `: ${droppedBecause(item)}` : ''}`;
  if (state === 'archived') return 'archived';
  if (state === 'done') return 'built';
  return state === 'active' ? 'being built' : 'moved to build';
}

/** Everything the worksheet says, as data. Reads the spool, the git log, the changelog and the tests; writes nothing. */
export function gather(ws: Workspace, spool: Spool, run: Item, leave?: Leave, asked?: CleanupAsk): Worksheet {
  const now = ws.now();
  const mine = tasks(ws, spool).filter((t) => !isRun(t));
  const state = (t: Item) => taskState(ws, t);
  const open = mine.filter((t) => WAITING.includes(state(t)));
  const ref = (t: Item): Ref => ({ id: t.id, title: t.title, state: state(t), priority: t.priority ?? 2, size: t.size ?? null, handsOff: handsOff(ws, t) });

  // 0. What was said no to.
  const runs = tasks(ws, spool)
    .filter((t) => isRun(t) && t !== run)
    .sort((a, b) => b.created.localeCompare(a.created));
  const journals = new Map(runs.map((r) => [r.id, readJournal(r)]));
  const dropped = mine
    .filter((t) => t.status === 'dropped')
    .map((t) => {
      const line = logOf(t).filter((n) => /^dropped\b/.test(n.text)).at(-1);
      return { id: t.id, title: t.title, why: droppedBecause(t) ?? null, by: line?.actor ?? null, when: line ? new Date(line.at).toISOString() : t.updated };
    });
  const archived = mine.filter((t) => state(t) === 'archived').map((t) => ({ id: t.id, title: t.title, when: t.archived! }));
  const earlier = runs.slice(0, MANAGE.runsRead).map((r) => {
    const journal = journals.get(r.id)!;
    const made = [...new Set(journal.entries.filter((e) => e.change === 'created' && e.kind === 'task').map((e) => e.item))];
    return {
      id: r.id,
      date: r.created.slice(0, 10),
      headline: r.summary ?? null,
      undone: journal.undone ? { why: journal.undone.why ?? null } : null,
      filed: made.map((id) => ({ id, title: ws.find(id)?.title ?? journal.entries.find((e) => e.item === id)!.title, outcome: outcome(ws, ws.find(id)) })),
    };
  });

  // 1. What may have shipped: the evidence, for a reader to weigh.
  const usual = usualWords(mine);
  const plain = <T extends { words: Set<string> }>(found: T[]): T[] => found.map((x) => ({ ...x, words: without(x.words, usual) }));
  const commits = open.length ? plain(commitsOf(spool)) : [];
  const changelog = open.length ? plain(changelogOf(spool)) : [];
  const tests = open.length ? plain(testsOf(spool)) : [];
  const finished = mine.filter((t) => t.status === 'done').map((t) => ({ item: t, words: wordsOf(t) }));
  const best = <T extends { words: string[] }>(found: T[]): T[] => found.sort((a, b) => b.words.length - a.words.length).slice(0, MANAGE.shown);
  const shipped: Worksheet['shipped'] = [];
  for (const t of open) {
    const want = wanted(t, usual);
    const filed = Date.parse(t.created);
    const words = wordsOf(t);
    const evidence: Evidence = {
      own: commits.filter((c) => c.thread === t.id).map((c) => ({ sha: c.sha.slice(0, 7), date: new Date(c.at).toISOString().slice(0, 10), subject: c.subject })),
      commits: best(
        commits
          .filter((c) => c.thread !== t.id && c.at >= filed)
          .map((c) => ({ sha: c.sha.slice(0, 7), date: new Date(c.at).toISOString().slice(0, 10), subject: c.subject, thread: c.thread, words: says(want, c.words) }))
          .filter((c) => c.words.length),
      ),
      finished: best(
        finished
          // Cut from one note, they are parts of one message and not the same wish twice.
          .filter((d) => !d.item.from.some((id) => t.from.includes(id)))
          .map((d) => ({ d, ...compare(words, d.words) }))
          .filter((m) => m.shared >= SIMILAR.alikeShared && m.score >= SIMILAR.alikeDice)
          .map((m) => ({ id: m.d.item.id, title: m.d.item.title, summary: m.d.item.summary ?? null, commits: m.d.item.commits.map((c) => c.slice(0, 7)), words: m.words })),
      ),
      changelog: best(changelog.map((c) => ({ version: c.version, line: c.line, words: says(want, c.words) })).filter((c) => c.words.length)),
      tests: best(tests.map((x) => ({ file: x.file, name: x.name, words: says(want, x.words) })).filter((x) => x.words.length)),
    };
    if (Object.values(evidence).some((found) => found.length)) shipped.push({ ...ref(t), evidence });
  }

  // 2 to 5. Doubled, cold, unsized, unexplained, too big.
  const alike = alikeIn(ws, spool)
    .filter((m) => !isRun(m.a) && !isRun(m.b))
    .map((m) => {
      const notes = m.b.from.filter((id) => ws.find(id)?.kind === 'note');
      return { a: ref(m.a), b: ref(m.b), words: m.words, merge: [...notes.map((n) => `spool file ${n} --into ${m.a.id}`), `spool drop ${m.b.id}`].join(', then ') };
    });
  // Only a run from the last weeks can be what last touched a thread that might still be warm.
  const byRuns = new Map<string, Set<string>>();
  for (const r of runs.filter((r) => now.getTime() - Date.parse(r.created) < (MANAGE.coldDays + 1) * DAY)) {
    for (const entry of journals.get(r.id)!.entries) byRuns.set(entry.item, (byRuns.get(entry.item) ?? new Set()).add(entry.at.slice(0, 16)));
  }
  const cold = open
    .filter((t) => state(t) === 'proposed')
    .map((t) => ({ ...ref(t), days: Math.floor((now.getTime() - touched(t, byRuns)) / DAY) }))
    .filter((t) => t.days >= MANAGE.coldDays)
    .sort((a, b) => b.days - a.days);

  // 6. The order, and whose it is.
  const backlog = open
    .filter((t) => state(t) === 'proposed')
    .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || effort(a) - effort(b) || a.created.localeCompare(b.created));
  const set = open
    .map((t) => ({ t, set: humanSet(t) }))
    .filter((x): x is { t: Item; set: { priority: number; at: number } } => !!x.set)
    .map(({ t, set }) => ({ id: t.id, title: t.title, set: set.priority, now: t.priority ?? 2, when: new Date(set.at).toISOString() }));

  const unanswered = mine.filter((t) => t.suggested && ['proposed', 'held'].includes(state(t))).length;
  return {
    run: run.id,
    project: spool.name,
    open: open.length,
    leave: leave ?? null,
    asked: asked ?? null,
    // The human's own number for tonight stands, whatever is waiting.
    proposals: { cap: leave?.allows.proposals ?? (unanswered >= MANAGE.waiting ? 0 : MANAGE.proposals), unanswered },
    saidNo: {
      dropped,
      archived,
      lessons: lessons(ws)
        .filter((l) => l.spool === spool)
        .map((l) => ({ words: l.words, thread: l.thread ?? null, date: l.date ?? null })),
      runs: earlier,
    },
    shipped,
    alike,
    cold,
    noSize: open.filter((t) => !t.size).map(ref),
    // An idea an agent suggested carries its reason with it, as `spool check` reads it.
    noWhy: open.filter((t) => !whyOf(t) && !t.suggested).map(ref),
    tooBig: open.filter((t) => (t.size === 'l' || t.size === 'xl') && t.type !== 'plan').map(ref),
    order: { backlog: backlog.map(ref), humanSet: set, build: buildLine(ws, spool).filter((t) => !isRun(t)).map(ref) },
    handsOff: handsOffIn(ws, spool),
  };
}

// ---------------------------------------------------------------- worksheet

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How many threads are left alone for each reason, in a line. */
function handsOffLine(left: { why: string }[]): string {
  const count = (test: RegExp) => left.filter((h) => test.test(h.why)).length;
  const groups: [number, string][] = [
    [count(/^in Build$/), 'in Build'],
    [count(/^being built$/), 'being built'],
    [count(/^on hold$/), 'on hold'],
    [count(/^the human (changed|wrote on) it /), `the human had a hand on in the last ${MANAGE.handsOffDays} days`],
    [count(/^the human put it in a sprint$/), 'the human put in a sprint'],
  ];
  return groups
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}`)
    .join(' · ');
}

/** What the worksheet of a pass the chat runs itself, taking over, says first. */
export const TIDY_RULE =
  'Run by the chat itself, taking over the backlog: nobody asked for this pass, so go no further than tidying. Size what has no size or a wrong one, and set priorities, yourself, by the rules. Every drop and every archive goes on this thread as a proposal, your own suggestions too: spool manage --propose <drop|archive> <t-id> -m "<the reason>". End with a headline in numbers ("Sized 4, reordered 2, 3 proposed to drop"): the brief shows it.';

/** The worksheet as an agent reads it: each step's facts under its number, and nothing that is a judgment. */
export function worksheetText(ws: Workspace, w: Worksheet, p: Paint): string {
  const now = ws.now();
  /** A thread's usual line, then what this step has to say of it, and whether it is to be left alone. */
  const thread = (r: { id: string; title: string; handsOff?: string | null }, ...notes: string[]): string => {
    const item = ws.find(r.id);
    // The line every listing gives it, with this step's notes joined to its own.
    const [lead, ...own] = item ? itemLine(ws, item, paint(false), false).split('  · ') : [`${r.id}  ${oneLine(r.title, 78)}`];
    const tail = [...own, ...notes, r.handsOff ? `hands off: ${r.handsOff}` : ''].filter(Boolean);
    return `${lead!.replace(r.id, p.bold(r.id))}${tail.length ? p.dim(`  · ${tail.join(' · ')}`) : ''}`;
  };
  const head = (n: number, title: string, note = '') => `${p.bold(`${n}  ${title}`)}${note ? p.dim(`  ${note}`) : ''}`;
  const both = (words: string[]) => p.dim(`  (${words.join(', ')})`);
  const counted = (label: string, n: number) => `  ${label}, ${n}${n ? ':' : '.'}`;
  const out: string[] = [];

  const ideas = w.proposals;
  out.push(`SPOOL_RUN=${w.run}`, `Set it on every command of this run, so one undo takes back all of it:  export SPOOL_RUN=${w.run}`, '');
  if (w.tidy && !w.asked) {
    out.push(p.bold(TIDY_RULE), '');
  }
  if (w.asked) {
    out.push(p.bold(CLEANUP_RULE));
    if (w.asked.words) out.push(`  What they wrote with it: "${w.asked.words}"`);
    out.push('');
  }
  // How far this run may go: the human's leave, in their words, or none.
  if (w.leave) {
    const a = w.leave.allows;
    out.push(`${p.bold('Under the leave')} ${leaveLine(w.leave, now)}`);
    if (a.build) out.push(`  to move a thread to build under it   spool build <t-id> --leave${p.dim(`      ${w.leave.used.build} of ${a.build} used`)}`);
    if (a.dropShipped) out.push('  to drop one that has shipped         spool drop <t-id> --leave -m "Shipped in <sha>: <what makes its Done-when true>"');
    if (!a.build && !a.dropShipped) out.push('  It moves nothing to build and drops nothing: what you would build or drop goes in the report, for the human to answer.');
  } else out.push('No leave is live: this run tidies only. What you would build or drop goes in the report, for the human to answer.');
  out.push(
    '',
    `${p.bold(`The backlog of ${w.project}`)}${p.dim(`  ${plural(w.open, 'open thread')}`)}`,
    'What follows are facts, gathered the same way every time. The judgment is yours.',
    ideas.cap
      ? `New ideas: ${ideas.cap} at most this run${w.leave?.allows.proposals ? ', by the leave' : ''}. ${ideas.unanswered ? `${plural(ideas.unanswered, 'earlier one')} still ${ideas.unanswered === 1 ? 'waits' : 'wait'} for an answer.` : 'No earlier one is waiting for an answer.'}`
      : `New ideas: none this run. ${ideas.unanswered} earlier ones still wait for an answer, and at ${MANAGE.waiting} the human has enough to read.`,
    '',
  );

  const no = w.saidNo;
  out.push(head(0, 'SAID NO TO BEFORE', 'hold every idea and every proposal against these'));
  if (!no.dropped.length && !no.archived.length && !no.lessons.length && !no.runs.length) out.push('  Nothing yet: nothing here was dropped, archived or undone.');
  if (no.dropped.length) {
    out.push(counted('Dropped', no.dropped.length));
    for (const d of no.dropped) out.push(`    ${thread(d, `${since(d.when, now)}${d.by ? ` by ${d.by}` : ''}${d.why ? `: ${oneLine(d.why, 110)}` : ', no reason given'}`)}`);
  }
  if (no.archived.length) {
    out.push(counted('Archived', no.archived.length));
    for (const a of no.archived) out.push(`    ${thread(a)}`);
  }
  if (no.lessons.length) {
    out.push(counted('Undone, and why', no.lessons.length));
    for (const l of no.lessons) out.push(`    "${l.words}"${l.thread ? p.dim(`  (${[l.thread, l.date].filter(Boolean).join(', ')})`) : ''}`);
  }
  if (no.runs.length) {
    out.push(counted('Earlier runs, and what became of the ideas each filed', no.runs.length));
    for (const r of no.runs) {
      const how = r.undone ? `undone${r.undone.why ? `: ${r.undone.why}` : ''}` : (r.headline ?? 'never finished');
      out.push(`    ${p.bold(r.id)}  ${r.date}  ${oneLine(how, 100)}${r.headline && !r.undone ? p.dim(`  · spool show ${r.id} --report`) : ''}`);
      for (const f of r.filed) out.push(`      ${f.id}  ${oneLine(f.title, 60)}${p.dim(`  · ${oneLine(f.outcome, 80)}`)}`);
    }
  }

  out.push('', head(1, 'MAY HAVE SHIPPED ALREADY', `evidence for ${w.shipped.length} of ${w.open}. It is evidence, never a verdict: read the Done-when against the code`));
  if (!w.shipped.length) out.push('  No open thread shares its words with a commit, a finished thread, the changelog or a test.');
  for (const t of w.shipped) {
    out.push(`  ${thread(t)}`);
    const e = t.evidence;
    for (const c of e.own) out.push(`      commit ${c.sha}  ${c.date}  ${oneLine(c.subject, 80)}${p.dim("  · carries this thread's own id")}`);
    for (const c of e.commits) out.push(`      commit ${c.sha}  ${c.date}  ${oneLine(c.subject, 80)}${c.thread ? p.dim(`  · for ${c.thread}`) : ''}${both(c.words)}`);
    for (const d of e.finished) out.push(`      finished ${d.id}  ${oneLine(d.title, 70)}${d.commits.length ? p.dim(`  · ${d.commits.join(', ')}`) : ''}${both(d.words)}`);
    for (const c of e.changelog) out.push(`      changelog${c.version ? ` ${oneLine(c.version, 24)}` : ''}  ${oneLine(c.line, 90)}${both(c.words)}`);
    for (const x of e.tests) out.push(`      test ${x.file}  ${oneLine(x.name, 80)}${both(x.words)}`);
  }

  out.push('', head(2, 'LOOK ALIKE', w.alike.length ? `${plural(w.alike.length, 'pair')}: one wish, or two on one subject?` : ''));
  if (!w.alike.length) out.push('  No two open threads share enough words.');
  for (const m of w.alike) out.push(`  ${thread(m.a)}`, `  ${thread(m.b)}`, p.dim(`      both say: ${m.words.join(', ')}. To merge: ${m.merge}`));

  out.push('', head(3, 'GONE COLD', `proposed, and untouched for ${MANAGE.coldDays} days`));
  if (!w.cold.length) out.push('  Nothing.');
  for (const t of w.cold) out.push(`  ${thread(t, `${t.days} days`)}`);

  out.push('', head(4, 'NO SIZE, NO WHY'), counted('No size', w.noSize.length));
  for (const t of w.noSize) out.push(`    ${thread(t)}`);
  out.push(counted('No Why: line', w.noWhy.length));
  for (const t of w.noWhy) out.push(`    ${thread(t)}`);

  out.push('', head(5, 'TOO BIG', 'large or huge, and not a plan'));
  if (!w.tooBig.length) out.push('  Nothing.');
  for (const t of w.tooBig) out.push(`  ${thread(t)}`);

  const order = w.order;
  const set = new Map(order.humanSet.map((h) => [h.id, h]));
  out.push('', head(6, 'THE ORDER'), counted('The backlog as it ranks now', order.backlog.length));
  order.backlog.forEach((t, i) => {
    const h = set.get(t.id);
    out.push(`  ${String(i + 1).padStart(3)}. ${thread(t, h ? `the human set p${h.set} ${since(h.when, now)}` : '')}`);
  });
  out.push(counted('Priorities the human set, each to be left as it is', order.humanSet.length));
  for (const h of order.humanSet) out.push(`    ${h.id}  p${h.set}  ${oneLine(h.title, 60)}${p.dim(`  · ${since(h.when, now)}${h.now === h.set ? '' : `, and it is p${h.now} now`}`)}`);
  out.push(`  In Build, in the order it will be built, ${order.build.length}${order.build.length ? `: ${order.build.map((t) => t.id).join(', ')}` : ''}. Never yours to reorder.`);

  out.push('', p.bold('HANDS OFF'), `  ${handsOffLine(w.handsOff) || 'No thread is in Build, on hold, or freshly the human\'s.'}`);
  out.push('', `When the pass is done:  spool manage --end -m "<the headline>" --report - <<'EOF' … EOF`, p.dim(`To take the whole run back:  spool revert ${w.run}`));
  return out.join('\n');
}

// ------------------------------------------------------------------- report

/** One item, and everything a run did to it. */
interface Folded {
  id: string;
  kind: Kind;
  title: string;
  /** The run made it. */
  made: boolean;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  said: string[];
}

/** A run's writes, item by item: where each field started and where it ended. A change put back is no change. */
function fold(entries: Entry[]): Folded[] {
  const out = new Map<string, Folded>();
  for (const e of entries) {
    let f = out.get(e.item);
    if (!f) out.set(e.item, (f = { id: e.item, kind: e.kind, title: e.title, made: e.change === 'created', from: {}, to: {}, said: [] }));
    f.title = e.title;
    for (const [key, value] of Object.entries(e.now)) {
      if (!(key in f.from)) f.from[key] = e.was[key] ?? null;
      f.to[key] = value;
    }
    f.said.push(...e.said);
  }
  for (const f of out.values()) {
    for (const key of Object.keys(f.to)) {
      if (!f.made && JSON.stringify(f.from[key]) === JSON.stringify(f.to[key])) {
        delete f.from[key];
        delete f.to[key];
      }
    }
  }
  return [...out.values()];
}

/** Lines a command writes on a log by itself. What is left is what the agent chose to say: its reasons. */
const ROUTINE = /^(edited: |builder model: |built on |dropped\b|moved to build|put on hold|released from hold|archived$|brought back|started\b|placed |still proposed|moved back)/;

export interface Changes {
  dropped: number;
  sized: number;
  reordered: number;
  plans: number;
  sprints: number;
  proposals: number;
  built: number;
  placed: number;
  archived: number;
  held: number;
  notes: number;
  other: number;
  items: number;
}

/** What a run changed, grouped the way a person asks about it, each line with its reason where the journal has one. */
export function changesOf(entries: Entry[]): { lines: string[]; counts: Changes } {
  // Made and dropped within the run comes to nothing, and is told as neither.
  const items = fold(entries).filter((f) => !(f.made && f.to.status === 'dropped'));
  const made = items.filter((f) => f.made);
  const old = items.filter((f) => !f.made);
  const lines: string[] = [];
  /** The items a group has named, and the fields of each that a group has accounted for. */
  const told = new Set<string>();
  const explained = new Map<string, Set<string>>();
  const explain = (f: Folded, key: string) => explained.set(f.id, (explained.get(f.id) ?? new Set()).add(key));
  /** An item's line in a group. What the agent said of it goes under the first line that names it. */
  const row = (f: Folded, key: string, what = '', why?: string): string[] => {
    const reasons = [...(why ? [why] : []), ...(told.has(f.id) ? [] : f.said.filter((s) => !ROUTINE.test(s)))];
    told.add(f.id);
    if (key) explain(f, key);
    return [`  ${f.id}  ${oneLine(f.title, 70)}${what ? ` · ${what}` : ''}`, ...reasons.map((r) => `          ${oneLine(r, 160)}`)];
  };
  const group = (title: string, rows: string[][]): number => {
    if (rows.length) lines.push(`${title}  ${rows.length}`, ...rows.flat());
    return rows.length;
  };

  const counts: Changes = { dropped: 0, sized: 0, reordered: 0, plans: 0, sprints: 0, proposals: 0, built: 0, placed: 0, archived: 0, held: 0, notes: 0, other: 0, items: items.length };
  counts.dropped = group(
    'Dropped',
    old.filter((f) => f.to.status === 'dropped').map((f) => row(f, 'status', '', f.said.map((s) => /^dropped: (.*)$/.exec(s)?.[1]).find(Boolean) ?? 'no reason given')),
  );
  counts.sized = group(
    'Sized',
    old.filter((f) => 'size' in f.to).map((f) => row(f, 'size', f.from.size ? `${String(f.from.size)} → ${String(f.to.size)}` : String(f.to.size))),
  );
  counts.reordered = group(
    'Re-ordered',
    old.filter((f) => 'priority' in f.to).map((f) => row(f, 'priority', `p${String(f.from.priority ?? 2)} → p${String(f.to.priority ?? 2)}`)),
  );
  counts.plans = group('Marked as plans', old.filter((f) => f.to.type === 'plan').map((f) => row(f, 'type')));
  const sprints = made.filter((f) => f.kind === 'sprint');
  counts.sprints = group(
    'Sprints drafted',
    sprints.map((sprint) => {
      const inIt = items.filter((t) => t.to.sprint === sprint.id);
      for (const t of inIt) explain(t, 'sprint');
      return row(sprint, '', inIt.length ? `${plural(inIt.length, 'thread')}: ${inIt.map((t) => t.id).join(', ')}` : 'empty');
    }),
  );
  counts.placed = group('Put in a sprint', old.filter((f) => typeof f.to.sprint === 'string' && !explained.get(f.id)?.has('sprint')).map((f) => row(f, 'sprint', String(f.to.sprint))));
  counts.proposals = group(
    'New ideas',
    made
      .filter((f) => f.kind === 'task')
      .map((f) => row(f, '', [f.to.size, f.to.type].filter(Boolean).join(' · '), typeof f.to.suggested === 'string' ? `Why: ${f.to.suggested}` : undefined)),
  );
  counts.built = group('Moved to build', old.filter((f) => f.from.status === 'proposed' && f.to.status === 'open').map((f) => row(f, 'status')));
  counts.archived = group('Archived', old.filter((f) => f.to.archived).map((f) => row(f, 'archived')));
  counts.held = group('Put on hold', old.filter((f) => f.to.hold).map((f) => row(f, 'hold', String(f.to.hold))));
  counts.notes = group('Notes left', old.filter((f) => !Object.keys(f.to).length && f.said.some((s) => !ROUTINE.test(s))).map((f) => row(f, '')));
  // Whatever no group above accounts for, so that nothing a run did goes unsaid.
  const unexplained = (f: Folded) => Object.keys(f.to).filter((key) => !explained.get(f.id)?.has(key));
  counts.other = group('Also changed', [
    ...made.filter((f) => !told.has(f.id)).map((f) => row(f, '', `a new ${f.kind}`)),
    ...old.filter((f) => unexplained(f).length).map((f) => row(f, '', unexplained(f).join(', '))),
  ]);
  return { lines, counts };
}

/** The counts in a line: "5 sized · 1 dropped · 2 new ideas". */
function countsLine(c: Changes): string {
  const parts: [number, string][] = [
    [c.dropped, 'dropped'],
    [c.sized, 'sized'],
    [c.reordered, 're-ordered'],
    [c.plans, c.plans === 1 ? 'marked as a plan' : 'marked as plans'],
    [c.sprints, c.sprints === 1 ? 'sprint drafted' : 'sprints drafted'],
    [c.proposals, c.proposals === 1 ? 'new idea' : 'new ideas'],
    [c.built, 'moved to build'],
    [c.placed, 'put in a sprint'],
    [c.archived, 'archived'],
    [c.held, 'put on hold'],
    [c.notes, c.notes === 1 ? 'note left' : 'notes left'],
    [c.other, 'changed otherwise'],
  ];
  return parts.filter(([n]) => n).map(([n, what]) => `${n} ${what}`).join(' · ');
}

/** The report on the run's ticket: the headline, what the agent has to say, then what the journal shows. */
function reportText(run: Item, headline: string, said: string, entries: Entry[], left: string): { text: string; counts: Changes } {
  const { lines, counts } = changesOf(entries);
  const leave = leaveOfRun(run);
  const text = [
    headline,
    ...(leave ? [`Under the leave "${leave.words}" (${allowed(leave)}).`] : []),
    `Undo all of it: spool revert ${run.id} -m "<why>", or Undo this thread on its ticket.`,
    ...(said ? ['', said] : []),
    '',
    `WHAT THIS RUN CHANGED  ${counts.items ? `${plural(counts.items, 'item')}, from its journal` : 'nothing'}`,
    ...(lines.length ? ['', ...lines] : []),
    ...(left ? ['', `Left alone  ${left}`] : []),
  ].join('\n');
  return { text: `${text}\n`, counts };
}

// ------------------------------------------------------------------ command

/** `spool manage --propose <verb> <id> -m <why>`: put what the run would do on its thread, for the human's yes or no. */
function propose(call: Call, open: Item | undefined): Result {
  const { ws, ctx, opts, actor, p } = call;
  const named = ctx.env.SPOOL_RUN?.trim();
  const run = named ? ws.find(named) : open;
  if (!run || !isRun(run) || run.status !== 'active') throw new SpoolError('no run is open to propose on', 'Start one: spool manage --start');
  const [verb, ref, ...extra] = call.args;
  if (!PROPOSABLE.includes(verb as Verb) || !ref || extra.length) {
    throw new SpoolError(`a proposal is a verb (${PROPOSABLE.join(', ')}) and one thread`, 'spool manage --propose drop <id> -m "Shipped in <sha>: <why>"');
  }
  const item = ws.get(ref);
  if (item.kind !== 'task' || isRun(item)) throw new SpoolError(`${item.id} is not a thread a run can propose on`);
  if (item.status === 'dropped' || item.status === 'done') throw new SpoolError(`${item.id} is already ${item.status}`);
  const reason = (typeof opts.message === 'string' ? opts.message : '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new SpoolError('a proposal needs its reason', `spool manage --propose ${verb} ${item.id} -m "<why>": it is what the human reads, and what a drop is given`);
  const all = readProposals(run);
  if (unanswered(all).some((x) => x.verb === verb && x.id === item.id)) throw new SpoolError(`${verb} ${item.id} is already proposed`);
  const made: Proposal = { n: Math.max(0, ...all.map((x) => x.n)) + 1, verb: verb as Verb, id: item.id, title: item.title, reason };
  writeProposals(run, [...all, made]);
  return {
    text: `${p.bold(`${run.id} proposal ${made.n}`)}  ${proposalLine(made)}\n${p.dim(`  The human says yes or no on the run's ticket, or:  spool manage --answer yes ${made.n}`)}`,
    data: { run: run.id, proposal: made },
  };
}

/** `spool manage --answer yes|no <n…|all>`: a word on proposals. A yes runs the verb, as whoever says it, with the run's reason. */
function answer(call: Call): Result {
  const { ws, opts, actor, p } = call;
  const [said, ...which] = call.args;
  if (said !== 'yes' && said !== 'no') throw new SpoolError('answer yes, or no', 'spool manage --answer yes 3   or   spool manage --answer no all');
  const spool = typeof opts.project === 'string' && opts.project ? ws.project(opts.project) : ws.home;
  const run =
    typeof opts.on === 'string' && opts.on
      ? ws.get(opts.on)
      : tasks(ws, spool).filter((t) => isRun(t) && unanswered(readProposals(t)).length).sort((a, b) => b.created.localeCompare(a.created))[0];
  if (!run || !isRun(run)) throw new SpoolError('no run has proposals waiting', 'See: spool manage');
  const all = readProposals(run);
  const picked = which.includes('all') ? unanswered(all) : which.map((w) => all.find((x) => x.n === Number(w)));
  if (!picked.length || picked.some((x) => !x)) throw new SpoolError(`which proposals? ${run.id} has ${all.map((x) => x.n).join(', ') || 'none'}`);
  const command = (verb: Verb) => COMMANDS.find((c) => c.name === verb)!;
  const out: string[] = [];
  for (const x of picked as Proposal[]) {
    if (x.answer) {
      out.push(`  ${x.n}: already answered ${x.answer.said}`);
      continue;
    }
    if (said === 'yes') {
      // The verb is the one a person would type, with the run's reason: its own rules hold for it.
      command(x.verb).run!({ ...call, args: [x.id], opts: { message: `${x.reason} (proposed by run ${run.id})` } });
    }
    x.answer = { by: actor, at: timestamp(ws.now()), said };
    addLog(run, actor, `${said} to proposal ${x.n}: ${proposalLine(x)}`, ws.now());
    out.push(`  ${x.n}: ${said === 'yes' ? `${x.verb} ${x.id}, done` : `left alone, ${x.id}`}`);
  }
  writeProposals(run, all);
  ws.save(run);
  const left = unanswered(all).length;
  return {
    text: [`${p.bold(run.id)}: ${said} to ${plural(picked.length, 'proposal')}`, ...out, left ? p.dim(`  ${plural(left, 'proposal')} still wait`) : p.dim('  Nothing more waits on you here.')].join('\n'),
    data: { run: run.id, proposals: all },
  };
}

/** `spool manage`: open a run and print its worksheet, close one with its report, or say whether one is open. */
export function manage(call: Call): Result {
  const { ws, ctx, opts, actor, p } = call;
  const spool = typeof opts.project === 'string' && opts.project ? ws.project(opts.project) : ws.home;
  if (opts.start && opts.end) throw new SpoolError('--start and --end are two ends of a run', 'spool manage --start   then, when the pass is done:   spool manage --end -m "<headline>"');
  const open = openRun(ws, spool);
  if (opts.propose && opts.answer) throw new SpoolError('--propose and --answer are two things');
  if (opts.propose) return propose(call, open);
  if (opts.answer) return answer(call);

  if (opts.takeover && !opts.start) throw new SpoolError('--takeover goes with --start: it is how the chat that takes over the backlog opens its own tidy', 'spool manage --start --takeover');
  if (opts.start) {
    // Taking over, the chat runs its own pass: only when one is due, and never past the usage target.
    if (opts.takeover && !open) {
      const due = tidyDue(ctx, ws, spool, agentOf(actor));
      if (!due.due) throw new SpoolError(`no tidy is due: ${due.why}`, 'See when the next one is: spool takeover');
    }
    if (open) {
      throw new SpoolError(
        `a run is open already: ${open.id}, started ${since(open.started ?? open.created, ws.now())} by ${open.by ?? 'someone'}`,
        `Carry on under it (SPOOL_RUN=${open.id}), end it (spool manage --end -m "<headline>"), or take it back (spool revert ${open.id})`,
      );
    }
    const run = ws.create(spool, 'task', {
      title: `Tidy the backlog, ${timestamp(ws.now()).slice(0, 10)}`,
      type: 'audit',
      tags: [RUN_TAG],
      // It changes no code, so it does not go through Build, which guards code: it is being worked from the start.
      status: 'active',
      by: actor,
      started: timestamp(ws.now()),
      priority: 2,
      body: SPEC,
    });
    addLog(run, actor, 'started', ws.now());
    ws.save(run);
    startJournal(run);
    // A leave that is live is this run's from now on: its thread names it, and undoing the run ends it.
    const { live } = settle(ws, spool);
    if (live) runUnder(ws, run, live, actor);
    // Asked for with Clean Up on the board: the request is this run's now, and its thread says so.
    const asked = takeCleanup(spool);
    if (asked) {
      addLog(run, actor, `asked for with Clean Up on the board by ${asked.by}${asked.words ? `: "${asked.words}"` : ''}`, ws.now());
      ws.save(run);
    }
    if (opts.takeover) {
      addLog(run, actor, TIDIED, ws.now());
      ws.save(run);
    }
    const sheet = { ...gather(ws, spool, run, live, asked), ...(opts.takeover ? { tidy: true } : {}) };
    return { text: worksheetText(ws, sheet, p), data: { env: { SPOOL_RUN: run.id }, ...sheet } };
  }

  if (opts.end) {
    const named = ctx.env.SPOOL_RUN?.trim();
    const run = named ? ws.find(named) : open;
    if (named && (!run || !isRun(run) || run.status !== 'active')) {
      throw new SpoolError(`SPOOL_RUN names "${named}", which is not an open run`, open ? `The run that is open is ${open.id}` : 'Start one: spool manage --start');
    }
    if (!run) throw new SpoolError('no run is open', 'Start one: spool manage --start');
    // A leave that ran out while the run worked is cleared now, so the run's thread says when.
    settle(ws, run.spool);
    const headline = (typeof opts.message === 'string' ? opts.message : call.args.join(' ')).replace(/\s+/g, ' ').trim();
    if (!headline) throw new SpoolError('the headline is missing', 'The human reads it first: spool manage --end -m "Tidied the backlog: 9 sized, 2 new ideas" --report -');
    let said = '';
    if (typeof opts.report === 'string' && opts.report) {
      try {
        said = (opts.report === '-' ? ctx.stdin() : fs.readFileSync(path.resolve(ctx.cwd, opts.report), 'utf8')).trim();
      } catch {
        throw new SpoolError(`cannot read the report at ${opts.report}`);
      }
    }
    const { text, counts } = reportText(run, headline, said, readJournal(run).entries, handsOffLine(handsOffIn(ws, run.spool)));
    const file = reportFile(run);
    ws.writeQueue(run.spool, `report-${run.id}`, text);
    run.status = 'done';
    run.place = undefined;
    run.summary = headline;
    addLog(run, actor, `done: ${headline}`, ws.now());
    ws.save(run);
    const where = path.relative(run.spool.root, file);
    return {
      text: [
        `${p.bold(run.id)} done: ${headline}`,
        `  ${counts.items ? `${plural(counts.items, 'item')} changed: ${countsLine(counts)}` : 'It changed nothing.'}`,
        p.dim(`  report  ${where}      spool show ${run.id} --report`),
        p.dim(`  One undo takes all of it back: spool revert ${run.id}`),
        'The run is over: unset SPOOL_RUN.',
      ].join('\n'),
      data: { run: itemJson(ws, run), report: where, changes: counts },
    };
  }

  const last = tasks(ws, spool)
    .filter((t) => isRun(t) && t !== open)
    .sort((a, b) => b.created.localeCompare(a.created))[0];
  if (open) {
    const writes = readJournal(open).entries;
    const { live } = settle(ws, spool);
    return {
      text: [
        `A run is open in ${spool.name}:`,
        `  ${itemLine(ws, open, p, false)}`,
        p.dim(`  ${plural(new Set(writes.map((e) => e.item)).size, 'item')} changed so far, in ${plural(writes.length, 'write')}`),
        ...(live ? [p.dim(`  under the leave ${leaveLine(live, ws.now())}`)] : []),
        p.dim(`  carry on under it     export SPOOL_RUN=${open.id}`),
        p.dim(`  end it                spool manage --end -m "<the headline>" --report -`),
        p.dim(`  take it all back      spool revert ${open.id}`),
      ].join('\n'),
      data: { open: itemJson(ws, open), writes: writes.length, last: last ? itemJson(ws, last) : null },
    };
  }
  return {
    text: [`No run is open in ${spool.name}.`, ...(last ? [`  The last one: ${itemLine(ws, last, p, false)}`] : []), p.dim('  start one   spool manage --start')].join('\n'),
    data: { open: null, last: last ? itemJson(ws, last) : null },
  };
}
