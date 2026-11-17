/**
 * Spool in the terminal: the queue, full-screen, where the human already is.
 *
 * Typing `spool` in a real terminal opens it. It is a third face on the one engine, beside the
 * page and the plain lines: a client of the page's server, over the same 127.0.0.1 API the
 * browser uses. It reads the board about once a second and draws it, and a key is one of the
 * POSTs the page's buttons make, carrying the token from the page's record on this machine. So
 * there is still one runner to a project, and leaving this screen stops nothing: the page is a
 * process of its own, and its agents carry on.
 *
 * Beside the queue is whatever the cursor is on. For a thread being built that is its agent's
 * session, live: the lines the page's runner heard, asked for by number (`/api/run`, `heard.ts`),
 * so what came before this screen was opened is there too, and each look brings only what is new.
 *
 * Two pure functions do the work, so a test compares screens as text with no terminal: `frame`
 * draws a screen from the board and the interface's own state, and `key` turns a key into a new
 * state and, maybe, an action. `watchQueue` is the loop around them, and `openQueue` is what bare
 * `spool` runs: it finds the page, or starts one in the background, and hands it the terminal.
 */

import * as path from 'node:path';
import type { Board, Card } from './board.ts';
import type { Brief } from './brief.ts';
import type { Result } from './commands.ts';
import type { Ctx } from './context.ts';
import { type PageRecord, pageUp, startDetached } from './detach.ts';
import { firstLine } from './model.ts';
import { MARK_LINE, inColor, markLine } from './mark.ts';
import { type Paint, age, paint } from './render.ts';
import { Workspace } from './store.ts';
import { type Proc, type TermIn, type TermOut, cut, fit, openTerm, tail, width, wrap } from './term.ts';
import { CODE_DIR, CODE_EXT } from './upkeep.ts';

// ------------------------------------------------------------------ what the interface holds

/** The smallest terminal the queue is drawn in. A smaller one is told so, plainly. */
export const SMALLEST = { cols: 80, rows: 24 };

/** Above the two sides: the header and a rule. Below them: a rule, the line that says what happened, and two lines of keys. */
const TOP = 2;
const BOTTOM = 4;

/** Everything the interface knows that the board does not. */
export interface State {
  /** Which screen: the queue with what the cursor is on beside it, the brief, or the list of keys. */
  view: 'queue' | 'brief' | 'keys';
  /** Which side takes the arrow keys: the queue, or what is open beside it. */
  focus: 'queue' | 'side';
  /** The row the cursor is on, as `section:id`, and where that was in the list, for when the row has gone. */
  at: string;
  index: number;
  /** Whether the backlog's list is open. */
  backlog: boolean;
  /** The thread being typed after `/`, or null when none is. */
  adding: string | null;
  /** The first line shown of what is beside the queue, or of the brief, once he has scrolled; null where it starts. */
  scroll: number | null;
  /** What the last action came to, in the page's words, and whether it failed. */
  said: string;
  failed: boolean;
  /** The page this is a face of: its address, whether this run started it, and whether it has stopped answering. */
  page: { url: string; started: boolean; lost: boolean };
  /** The time, for how long a thread has been built. */
  now: number;
  /** The terminal's size, so a key can move by a screenful. */
  cols: number;
  rows: number;
  /** What each finished thread changed, once the page has been asked: "+38 -12". */
  sizes: Record<string, string>;
  /** Spool's mark for the top line, in this terminal's colours (`markLine`); empty where it is drawn plain. */
  mark: string;
  /**
   * What the agent said on the thread the cursor is on, as far as the page has been asked: which
   * run, the number of the next line to ask for, and whether the thread was still being built then.
   */
  run: { id: string; run: string; next: number; lines: string[]; live: boolean } | null;
}

export function start(page: State['page'], cols: number, rows: number, now: number): State {
  return { view: 'queue', focus: 'queue', at: '', index: 0, backlog: false, adding: null, scroll: null, said: '', failed: false, page, now, cols, rows, sizes: {}, mark: '', run: null };
}

/** What a key asks for beyond a change of state: one of the page's own POSTs, or to leave. */
export type Action = { do: 'post'; action: string; body: Record<string, unknown>; done: string } | { do: 'quit' };

type Tone = keyof Paint;
/** A run of text in one tone. A line is a few of these. `as` is the same text already painted another way, shown in its place where all of it fits. */
interface Bit {
  text: string;
  tone?: Tone;
  as?: string;
}

const ink = (p: Paint, text: string, tone?: Tone): string => (tone && text ? p[tone](text) : text);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(high, n));

/** How long, the way a person would say it in a narrow column. */
function took(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// ------------------------------------------------------------------ the queue's rows

type Section = 'needs' | 'building' | 'build' | 'done' | 'backlog';

/** One line of the queue the cursor can stand on. */
interface Row {
  key: string;
  section: Section;
  kind: 'question' | 'plan' | 'thread' | 'sprint' | 'backlog';
  id: string;
  mark: string;
  title: string;
  /** What sits against the right edge: how long, how big, what it waits on. */
  tail: string;
  /** A Building row: the last thing its agent said. */
  under?: string;
}

const cardsOf = (board: Board): Card[] => [...board.columns.building, ...board.columns.build, ...board.columns.done, ...board.columns.proposed];
const cardOf = (board: Board, id: string): Card | undefined => cardsOf(board).find((c) => c.id === id);

/** Why a thread in Build is not moving and needs him: he stopped it, or its agent left it unfinished. */
function halted(board: Board, c: Card): string {
  if (board.runner.stopped.includes(c.id)) return 'stopped';
  return c.waiting?.kind === 'stuck' ? 'unfinished' : '';
}

/** How long a thread has been built: by the page's own count where it runs the agent, else from when it was taken. */
function builtFor(board: Board, c: Card, now: number): number {
  const run = board.runner.running.find((r) => r.id === c.id);
  if (run) return run.seconds;
  return c.live ? Math.max(0, Math.round((now - Date.parse(c.live.since)) / 1000)) : 0;
}

/** The sprints with threads still in the backlog, each with those threads: what pressing play would move. */
function sprintsWaiting(board: Board): { sprint: Board['sprints'][number]; cards: Card[] }[] {
  return board.sprints
    .filter((s) => s.status !== 'done')
    .map((sprint) => ({ sprint, cards: board.columns.proposed.filter((c) => c.sprint === sprint.id) }))
    .filter((s) => s.cards.length);
}

/**
 * Every line of the queue the cursor can stand on, top to bottom: what needs him, what is being
 * built, Build in the order it will be built, what is done and not yet checked, and the backlog,
 * which is one line until it is opened.
 */
export function rowsOf(board: Board, state: Pick<State, 'backlog' | 'now' | 'sizes'>): Row[] {
  const rows: Row[] = [];
  const thread = (section: Section, c: Card, mark: string, end: string, under?: string): void => {
    rows.push({ key: `${section}:${c.id}`, section, kind: 'thread', id: c.id, mark, title: c.title, tail: end, under });
  };
  for (const q of board.needs.questions) {
    const options = Math.min(9, q.options.length);
    rows.push({ key: `needs:${q.id}`, section: 'needs', kind: 'question', id: q.id, mark: '?', title: q.title, tail: options > 1 ? `1-${options}` : options ? '1' : '' });
  }
  for (const plan of board.needs.plans) rows.push({ key: `needs:${plan.id}`, section: 'needs', kind: 'plan', id: plan.id, mark: '!', title: plan.title, tail: 'plan' });
  for (const c of board.columns.build) if (halted(board, c)) thread('needs', c, '!', halted(board, c));

  for (const c of board.columns.building) {
    const run = board.runner.running.find((r) => r.id === c.id);
    thread('building', c, '*', took(builtFor(board, c, state.now)), run?.lines.at(-1) || c.live?.note || 'starting…');
  }
  board.columns.build.forEach((c, i) => thread('build', c, String(i + 1), halted(board, c) || (c.waiting ? 'waits' : c.size)));
  for (const c of board.columns.done) if (!c.complete) thread('done', c, '+', state.sizes[c.id] ?? '');

  rows.push({ key: 'backlog:', section: 'backlog', kind: 'backlog', id: '', mark: '', title: 'BACKLOG', tail: String(board.columns.proposed.length) });
  if (state.backlog) {
    const sprints = sprintsWaiting(board);
    const waits = (c: Card): string => (c.waiting?.kind === 'hold' ? 'hold' : c.size);
    for (const c of board.columns.proposed) if (!sprints.some((s) => s.cards.includes(c))) thread('backlog', c, '-', waits(c));
    for (const { sprint, cards } of sprints) {
      rows.push({ key: `backlog:${sprint.id}`, section: 'backlog', kind: 'sprint', id: sprint.id, mark: '#', title: sprint.name, tail: `${cards.length} waiting` });
      for (const c of cards) thread('backlog', c, '-', waits(c));
    }
  }
  return rows;
}

/** Where the cursor is among the rows: on the row it was on, or where that row was, if it has gone. */
function cursor(rows: Row[], state: Pick<State, 'at' | 'index'>): number {
  const found = rows.findIndex((r) => r.key === state.at);
  return found >= 0 ? found : clamp(state.index, 0, rows.length - 1);
}

/**
 * The state, with its cursor on a row the board still has. A thread that moved on (built,
 * approved, sent to Build) leaves the cursor where it was in the list, on whatever is there now.
 */
export function settle(state: State, board: Board | null): State {
  if (!board) return state;
  const rows = rowsOf(board, state);
  const index = cursor(rows, state);
  const at = rows[index]!.key;
  if (at === state.at && index === state.index) return state;
  return { ...state, at, index, scroll: at === state.at ? state.scroll : null };
}

/** The first screen: the brief, when something shipped since he last looked and nothing is being built; else the queue. */
export function opening(state: State, board: Board): State {
  return (board.brief?.shipped ?? 0) > 0 && !board.columns.building.length ? { ...state, view: 'brief', scroll: null } : state;
}

// ------------------------------------------------------------------ what is beside the queue

/** What is drawn beside the queue for the row the cursor is on: two lines of heading, and a body that scrolls. */
interface Side {
  head: { left: Bit[]; right: Bit[] }[];
  body: Bit[];
  /** A body that grows at its end is shown from its end; one that is read is shown from its start. */
  follow: boolean;
}

const BLANK: Bit = { text: '' };

/** Lines under a label: the text wrapped to the room there is, a blank line kept between paragraphs. */
function part(body: Bit[], label: string, text: string | string[], inner: number, tone?: Tone): void {
  const paragraphs = (Array.isArray(text) ? text : text.split('\n')).map((line) => line.trim());
  if (!paragraphs.some(Boolean)) return;
  if (body.length) body.push(BLANK);
  body.push({ text: label, tone: 'bold' });
  for (const paragraph of paragraphs) {
    if (!paragraph) body.push(BLANK);
    else for (const line of wrap(paragraph, inner - 2)) body.push({ text: `  ${line}`, tone });
  }
}

/** A numbered list, each item wrapped under its own first word: under a label, or straight after what is above it. */
function numbered(body: Bit[], label: string, items: string[], inner: number, note: (i: number) => string = () => ''): void {
  if (!items.length) return;
  if (label && body.length) body.push(BLANK);
  if (label) body.push({ text: label, tone: 'bold' });
  items.forEach((item, i) => {
    const lead = `  ${i + 1}  `;
    wrap(`${item}${note(i)}`, inner - lead.length).forEach((line, n) => body.push({ text: `${n ? ' '.repeat(lead.length) : lead}${line}` }));
  });
}

/** Where a thread stands, in a word or two, for the right of its heading. */
function standing(board: Board, c: Card, now: number): string {
  if (c.column === 'building') return `building · ${took(builtFor(board, c, now))}`;
  if (c.column === 'build') return halted(board, c) || (c.waiting ? 'waiting' : 'in build');
  if (c.done) return c.complete ? 'done' : 'done, to check';
  return c.waiting?.kind === 'hold' ? 'on hold' : 'backlog';
}

/** One thread, read: why it exists, what it waits on, what came of it, how to check it, and its last lines. */
function threadSide(board: Board, state: State, c: Card, inner: number): Side {
  const sprint = board.sprints.find((s) => s.id === c.sprint)?.name ?? '';
  const facts = [c.type !== 'change' ? c.type : '', c.difficulty, c.priority !== 'Normal' ? c.priority : '', sprint, c.version ? `v${c.version}` : '', ...c.tags.map((t) => `#${t}`)].filter(Boolean);
  const body: Bit[] = [];
  const about = (key: string): string => c.thread.about.filter((a) => a.key === key).map((a) => a.text).join('\n');

  const plan = board.needs.plans.find((x) => x.id === c.id);
  if (plan) numbered(body, 'Waits for your go-ahead: a gives it', plan.parts, inner);
  const stop = c.column === 'build' ? halted(board, c) : '';
  if (stop === 'stopped') part(body, 'Stopped', 'You stopped its agent. It waits in Build until you carry on: b.', inner);
  const w = c.waiting;
  if (w?.kind === 'stuck') {
    part(body, 'Its agent stopped unfinished', [`It ${w.text}. b carries on with it.`, ...(w.said ? [`It last said: ${w.said}`] : []), ...w.refused.map((r) => `Refused: ${r}`)], inner);
  } else if (w?.kind === 'hold') part(body, 'On hold', w.text || 'You put it on hold.', inner);
  else if (w?.kind === 'thread') part(body, 'Waits on', w.on.map((t) => `${t.id}  ${t.title}`), inner);
  else if (w?.kind === 'you' && !c.question) part(body, 'Needs you', w.text, inner);
  if (c.question) {
    part(body, 'Needs your answer', c.question.title, inner);
    numbered(body, '', c.question.options, inner, (i) => (c.question!.recommend === i + 1 ? '  (I would pick)' : ''));
  }

  part(body, 'Why', c.why || about('why'), inner);
  const spec = (): void => {
    part(body, 'What', about('what'), inner);
    part(body, 'Done when', about('done'), inner);
    part(body, 'More', about('other'), inner);
    // A thread nobody has written up yet is only what he said.
    if (!c.thread.about.length && !c.why) part(body, 'You said', c.thread.said.map((s) => s.text).join('\n\n'), inner);
  };
  // Finished, what came of it is the news; before that, what it is.
  if (!c.done) spec();
  part(body, 'Result', c.thread.summary, inner);
  numbered(body, 'To check', c.steps, inner);
  if (c.done) spec();

  // What its agent said last, where a page ran one on it; else the last of what is written on the thread.
  const heard = state.run?.id === c.id ? state.run.lines.slice(-8) : [];
  const last = heard.length ? heard : c.thread.steps.slice(-6).map((s) => `${s.at.slice(5, 16)} ${s.who}: ${s.what}`.trim());
  if (last.length) {
    if (body.length) body.push(BLANK);
    body.push({ text: heard.length ? 'Its agent last said' : 'Last lines', tone: 'bold' });
    for (const said of last) wrap(said, inner - 4).forEach((line, n) => body.push({ text: `${n ? '    ' : '  '}${line}`, tone: 'dim' }));
  }
  if (!body.length) body.push({ text: 'Nothing is written on it yet.', tone: 'dim' });
  return {
    head: [
      { left: [{ text: c.id, tone: 'dim' }, { text: `  ${c.title}`, tone: 'bold' }], right: [{ text: standing(board, c, state.now) }] },
      { left: [{ text: facts.join(' · '), tone: 'dim' }], right: [] },
    ],
    body,
    follow: false,
  };
}

/** How a line an agent said is shown: its tool calls quietly, what failed in red, what it was refused in yellow. */
function saidTone(line: string): Tone | undefined {
  if (line.startsWith('→ ') || line.startsWith('session ')) return 'dim';
  if (line.startsWith('✗ ')) return 'red';
  return line.startsWith('denied → ') ? 'yellow' : undefined;
}

/**
 * One agent at work, live: what it was started with and where, and under that every line it has
 * said, the newest last. The lines are the run's own, once the page has been asked for them;
 * until then, the few the board carries, so moving to a thread shows its lines at once.
 */
function sessionSide(board: Board, state: State, c: Card, inner: number): Side {
  const run = board.runner.running.find((r) => r.id === c.id);
  // Only a run of this page's is shown as this session: lines kept from an earlier run are not what a chat is doing now.
  const lines = !run ? [] : state.run?.id === c.id && state.run.lines.length ? state.run.lines : run.lines;
  const body: Bit[] = [];
  for (const said of lines) wrap(said, inner - 2).forEach((line, n) => body.push({ text: `${n ? '  ' : ''}${line}`, tone: saidTone(said) }));
  if (!body.length) {
    // Built by a chat, or by hand: its agent's lines are wherever that agent is.
    const none = run ? 'Nothing said yet.' : `${c.thread.by || 'An agent'} is building this outside the page, so its lines are not here.`;
    for (const line of wrap(c.live?.note ? `${none} Its last note: ${c.live.note}` : none, inner)) body.push({ text: line, tone: 'dim' });
  }
  const started = [c.run?.model, c.run?.effort, took(builtFor(board, c, state.now))].filter(Boolean).join(' · ');
  return {
    head: [
      { left: [{ text: c.id, tone: 'dim' }, { text: `  ${c.title}`, tone: 'bold' }], right: [{ text: started }] },
      { left: [{ text: c.worktree || 'the project’s own folder', tone: 'dim' }], right: [{ text: c.run?.session ? `session ${c.run.session.slice(0, 8)}` : '', tone: 'dim' }] },
    ],
    body,
    follow: true,
  };
}

function questionSide(q: Board['needs']['questions'][number], inner: number): Side {
  const body: Bit[] = [];
  part(body, 'Why it is asked', q.why, inner);
  numbered(body, 'Answer with its number', q.options, inner, (i) => (q.recommend === i + 1 ? '  (I would pick)' : ''));
  part(body, 'Holds up', q.holds, inner);
  if (body.length) body.push(BLANK);
  for (const line of wrap(q.options.length ? 'For an answer in your own words, use the page.' : `It has no options to pick from. Answer it in your own words on the page, or: spool answer ${q.id} "<your call>"`, inner)) {
    body.push({ text: line, tone: 'dim' });
  }
  return {
    head: [
      { left: [{ text: q.id, tone: 'dim' }, { text: `  ${q.title}`, tone: 'bold' }], right: [{ text: 'question' }] },
      { left: [{ text: q.threads.length ? `holds up ${q.threads.join(', ')}` : '', tone: 'dim' }], right: [] },
    ],
    body,
    follow: false,
  };
}

function sprintSide(board: Board, sprint: Board['sprints'][number], inner: number): Side {
  const body: Bit[] = [];
  part(body, 'Goal', sprint.goal, inner);
  part(body, 'Why', sprint.why, inner);
  part(body, 'Done when', sprint.doneWhen, inner);
  const waiting = board.columns.proposed.filter((c) => c.sprint === sprint.id);
  part(body, 'p plays it: these move to Build', waiting.map((c) => `${c.id}  ${c.title}`), inner);
  return {
    head: [
      { left: [{ text: sprint.id, tone: 'dim' }, { text: `  ${sprint.name}`, tone: 'bold' }], right: [{ text: `sprint · ${sprint.status}` }] },
      { left: [{ text: `${sprint.done} of ${sprint.total} done · ${waiting.length} waiting`, tone: 'dim' }], right: [] },
    ],
    body,
    follow: false,
  };
}

function backlogSide(board: Board, state: State, inner: number): Side {
  const body: Bit[] = [];
  const say = (text: string, tone?: Tone): void => wrap(text, inner).forEach((line) => body.push({ text: line, tone }));
  const sprints = sprintsWaiting(board);
  if (!board.columns.proposed.length) say('Nothing waits in the backlog. / adds a thread.');
  else if (state.backlog) say('Move to a thread and press b to send it to Build. p on a sprint plays it: everything waiting in it moves to Build.');
  else say('Threads wait here until you send them to Build. Enter opens the list.');
  part(body, 'Sprints', sprints.map(({ sprint, cards }) => `${sprint.name}: ${cards.length} waiting, ${sprint.done} of ${sprint.total} done`), inner);
  return {
    head: [
      { left: [{ text: 'Backlog', tone: 'bold' }], right: [{ text: plural(board.columns.proposed.length, 'thread') }] },
      { left: [{ text: sprints.length ? plural(sprints.length, 'sprint') + ' to play' : '', tone: 'dim' }], right: [] },
    ],
    body,
    follow: false,
  };
}

/** What is beside the queue for the row the cursor is on. */
function sideOf(board: Board, state: State, row: Row, inner: number): Side {
  if (row.kind === 'question') {
    const q = board.needs.questions.find((x) => x.id === row.id);
    if (q) return questionSide(q, inner);
  }
  if (row.kind === 'sprint') {
    const sprint = board.sprints.find((s) => s.id === row.id);
    if (sprint) return sprintSide(board, sprint, inner);
  }
  const c = row.kind === 'thread' || row.kind === 'plan' ? cardOf(board, row.id) : undefined;
  if (c?.column === 'building') return sessionSide(board, state, c, inner);
  return c ? threadSide(board, state, c, inner) : backlogSide(board, state, inner);
}

/** The thread the cursor is on, if it is on one: the thread whose run is asked for. */
export function threadAt(board: Board, state: State): string {
  const rows = rowsOf(board, state);
  const row = rows[cursor(rows, state)]!;
  return row.kind === 'thread' || row.kind === 'plan' ? row.id : '';
}

// ------------------------------------------------------------------ the brief, and the keys

/** The morning brief, as lines: what `spool brief` says, laid out for this screen. */
function briefBody(b: Brief, inner: number, now: number): Bit[] {
  const out: Bit[] = [];
  const put = (text: string, tone: Tone | undefined, indent: number, hang = indent): void => {
    wrap(text, inner - Math.max(indent, hang)).forEach((line, i) => out.push({ text: ' '.repeat(i ? hang : indent) + line, tone }));
  };
  const title = (text: string): void => {
    out.push(BLANK, { text, tone: 'bold' });
  };
  put(b.headline, 'bold', 0);

  const needs = b.needsYou;
  const count = needs.questions.length + needs.plans.length + needs.stopped.length;
  if (!count) {
    out.push(BLANK);
    put('Nothing needs you: no questions, no plans waiting, nothing stopped.', undefined, 0);
  } else {
    title(`NEEDS YOU  ${count}`);
    for (const q of needs.questions) {
      put(`? ${q.title}  (${q.id}${q.blocks ? `, blocks ${plural(q.blocks, 'thread')}` : ''})`, undefined, 2, 4);
      q.options.forEach((o, i) => put(`${i + 1}  ${o}${q.recommend === i + 1 ? '  (I would pick)' : ''}`, 'dim', 4, 7));
    }
    for (const t of needs.plans) {
      put(`! plan: ${t.title}  (${t.id}, ${plural(t.parts, 'part')} ${t.parts === 1 ? 'waits' : 'wait'} for your go-ahead)`, undefined, 2, 4);
      if (t.summary) put(firstLine(t.summary), 'dim', 4);
    }
    for (const s of needs.stopped) {
      put(`! ${s.title}  (${s.id})`, undefined, 2, 4);
      put(`${s.why}, ${age(s.when, new Date(now))} ago`, 'dim', 4);
      if (s.lastSaid) put(`last said: ${s.lastSaid}`, 'dim', 4);
    }
  }

  if (b.worthALook.length) {
    title(`WORTH A LOOK  ${b.worthALook.length}`);
    b.worthALook.forEach((t, i) => {
      put(`${i + 1}. ${t.title}  (${t.id})`, undefined, 2, 5);
      if (t.summary) for (const l of t.summary.split('\n')) if (l.trim()) put(l, undefined, 5);
      put(`why: ${t.reasons.join(' · ')}`, 'dim', 5);
      if (t.steps.length) put('to check:', 'dim', 5);
      t.steps.forEach((step, n) => put(`${n + 1}) ${step}`, undefined, 7, 10));
    });
  }

  if (b.spent) {
    const sp = b.spent;
    title('WHAT IT TOOK');
    put([plural(sp.runs, 'run'), `${Math.round(sp.minutes)} min`, ...(sp.turns ? [plural(sp.turns, 'turn')] : []), ...(sp.usd > 0 ? [`$${sp.usd.toFixed(2)}`] : [])].join(' · '), undefined, 2);
    if (sp.unmeasured) put(`${plural(sp.unmeasured, 'thread')} built in chat: only the time from claim to landing is known`, 'dim', 2);
  }

  const rest = b.alsoShipped.reduce((n, g) => n + g.threads.length, 0);
  if (rest) {
    title(`${b.worthALook.length ? 'ALSO SHIPPED' : 'SHIPPED'}  ${rest}`);
    for (const g of b.alsoShipped) {
      if (g.sprint) put(g.sprint.title, 'dim', 2);
      const indent = g.sprint ? 4 : 2;
      for (const t of g.threads) put(`+ ${t.title}${t.summary ? `: ${firstLine(t.summary)}` : ''}  (${t.id})`, undefined, indent, indent + 2);
    }
  }

  if (b.calls.length) {
    title(`CALLS AGENTS MADE  ${b.calls.length}`);
    for (const c of b.calls) put(`${c.question} → ${c.chose}  (${c.id})`, undefined, 2, 4);
  }
  return out;
}

/** Every key, for `?`. */
const KEYS: [string, string][] = [
  ['up, down, j, k', 'move through the queue'],
  ['enter', 'read what the cursor is on; open or close the backlog'],
  ['tab', 'between the queue and what is beside it; esc goes back too'],
  ['pgup, pgdn', 'scroll what is beside the queue: a session, or a thread'],
  ['home, end', 'its start, and its end: a session follows its end again'],
  ['b', 'build a backlog thread, or carry on with a stopped one'],
  ['p', 'play a sprint: on it, or a thread of it, in the backlog'],
  ['s', 'stop the agent on a thread being built; it waits in Build'],
  ['a', 'approve a finished thread, or give a plan the go-ahead'],
  ['1 to 9', 'answer a question with that option'],
  ['g', 'switch the page’s agents on or off'],
  ['/', 'add a thread: type one line, enter files it in the backlog'],
  ['?', 'this list'],
  ['q', 'leave. The page stays up and its agents carry on'],
];

function keysBody(inner: number): Bit[] {
  const out: Bit[] = [{ text: 'Keys', tone: 'bold' }, BLANK];
  for (const [name, what] of KEYS) wrap(what, inner - 18).forEach((line, i) => out.push({ text: `  ${(i ? '' : name).padEnd(16)}${line}` }));
  out.push(BLANK, { text: 'Every key is something the page does too. Any key goes back.', tone: 'dim' });
  return out;
}

// ------------------------------------------------------------------ drawing

/** A line of exactly `w` columns: the left cut to the room it has, the right against the edge. */
function spread(left: Bit[], right: Bit[], w: number, p: Paint): string {
  let end = right.filter((b) => b.text);
  let endWidth = end.reduce((n, b) => n + width(b.text), 0);
  if (endWidth > w) {
    end = [{ text: cut(end.map((b) => b.text).join(''), w), tone: end[0]?.tone }];
    endWidth = width(end[0]!.text);
  }
  const room = Math.max(0, w - endWidth - (endWidth ? 1 : 0));
  let out = '';
  let used = 0;
  for (const bit of left) {
    if (used >= room) break;
    const shown = cut(bit.text, room - used);
    out += bit.as && shown === bit.text ? bit.as : ink(p, shown, bit.tone);
    used += width(shown);
  }
  return out + ' '.repeat(Math.max(0, w - used - endWidth)) + end.map((b) => ink(p, b.text, b.tone)).join('');
}

const rule = (w: number, p: Paint, at = -1, tee = ''): string => p.dim(at >= 0 && at < w ? `${'─'.repeat(at)}${tee}${'─'.repeat(w - at - 1)}` : '─'.repeat(w));

/** How wide the queue is: a little over a third of the screen, and never too narrow for a title. */
const queueWidth = (cols: number): number => clamp(Math.floor(cols * 0.4), 36, 48);

/** The port of the page's address: the rest of it is always this machine. */
const portOf = (url: string): string => /:(\d+)\/?$/.exec(url)?.[1] ?? '';

/**
 * The top line: Spool's mark, the project and its version on the left, and on the right whether
 * agents are on, how many are building, how many things need him, and where the page is. The mark
 * is the yarn's one-line form (`mark.ts`), in the terminal's own colours where the loop has them.
 */
function head(board: Board | null, state: State, cols: number, p: Paint): string {
  const left: Bit[] = [{ text: ` ${MARK_LINE}`, tone: 'bold', as: state.mark ? ` ${state.mark}` : undefined }];
  const port = portOf(state.page.url);
  const where = !port ? 'starting the page' : `${state.page.started ? 'started ' : ''}page :${port}${state.page.lost ? ' not answering' : ''}`;
  const right: Bit[] = [];
  if (board) {
    const needs = rowsOf(board, state).filter((r) => r.section === 'needs').length;
    const building = board.columns.building.length;
    const agents = board.runner.builder === 'chat' ? 'a chat builds' : board.runner.on ? 'agents on' : 'agents off';
    right.push(
      { text: agents, tone: board.runner.builder === 'chat' ? undefined : board.runner.on ? 'green' : 'yellow' },
      { text: ` · ${building} building · `, tone: 'dim' },
      { text: needs === 1 ? '1 needs you' : `${needs} need you`, tone: needs ? 'red' : 'dim' },
      { text: ' · ', tone: 'dim' },
    );
  }
  right.push({ text: `${where} `, tone: state.page.lost ? 'red' : 'dim' });
  if (board) {
    // The project's version is the first thing to go where the line is short of room.
    const room = cols - right.reduce((n, b) => n + width(b.text), 0) - 1;
    const named = ` · ${board.project}`;
    const versioned = board.version ? `${named} ${board.version}` : named;
    left.push({ text: width(left[0]!.text) + width(versioned) <= room ? versioned : named });
  }
  return spread(left, right, cols, p);
}

const MARK_TONE: Record<string, Tone> = { '?': 'yellow', '!': 'red', '*': 'green', '+': 'green', '#': 'magenta' };

/** The queue: every section with its count, the rows under it, and the cursor. Exactly `h` lines of `w` columns. */
function queueLines(board: Board, state: State, rows: Row[], at: number, w: number, h: number, p: Paint): string[] {
  interface Line {
    left: Bit[];
    right: Bit[];
    row?: number;
  }
  const playing = board.sprints.filter((s) => s.status === 'running').map((s) => s.name);
  const compose = (under: boolean): Line[] => {
    const lines: Line[] = [];
    const title = (name: string, count: string, right = ''): void => {
      lines.push({ left: [{ text: ` ${name}`, tone: 'bold' }, { text: `  ${count}`, tone: 'dim' }], right: [{ text: right && `${right} `, tone: 'dim' }] });
    };
    const list = (section: Section): void => {
      rows.forEach((row, i) => {
        if (row.section !== section) return;
        const here = i === at;
        // The cursor is bright on the side that takes the keys.
        const pointer: Bit = here ? { text: '>', tone: state.focus === 'queue' ? 'cyan' : 'dim' } : { text: ' ' };
        if (row.kind === 'backlog') {
          lines.push({ left: [pointer, { text: row.title, tone: 'bold' }, { text: `  ${row.tail}`, tone: 'dim' }], right: [], row: i });
          return;
        }
        lines.push({
          left: [pointer, { text: row.mark.padStart(2), tone: here ? 'bold' : (MARK_TONE[row.mark] ?? 'dim') }, { text: ` ${row.id}`, tone: here ? 'bold' : 'dim' }, { text: `  ${row.title}`, tone: here ? 'bold' : undefined }],
          right: [{ text: row.tail && `${row.tail} `, tone: here ? 'bold' : 'dim' }],
          row: i,
        });
        if (under && row.under) lines.push({ left: [{ text: `     ${cut(row.under, w - 6)}`, tone: 'dim' }], right: [] });
      });
    };
    const count = (section: Section): number => rows.filter((r) => r.section === section && r.kind !== 'backlog').length;
    title('NEEDS YOU', String(count('needs')));
    list('needs');
    lines.push({ left: [], right: [] });
    const building = count('building');
    title('BUILDING', board.runner.builder === 'chat' || !building ? String(building) : `${building} of ${Math.max(building, board.runner.parallel)}`);
    list('building');
    lines.push({ left: [], right: [] });
    title('BUILD', String(count('build')), playing.length ? `sprint: ${playing[0]}${playing.length > 1 ? ` +${playing.length - 1}` : ''}` : '');
    list('build');
    lines.push({ left: [], right: [] });
    title('DONE, TO CHECK', String(count('done')));
    list('done');
    list('backlog');
    return lines;
  };
  // Each agent's last line sits under its row while there is room for everything; with less room, the rows come first.
  let lines = compose(true);
  if (lines.length > h) lines = compose(false);
  // Longer than the screen still: the part around the cursor is shown.
  const on = lines.findIndex((line) => line.row === at);
  const top = lines.length > h ? clamp(on - Math.floor(h / 2), 0, lines.length - h) : 0;
  const shown = lines.slice(top, top + h).map((line) => spread(line.left, line.right, w, p));
  while (shown.length < h) shown.push(' '.repeat(w));
  return shown;
}

/** How many lines of body the side has room for, under its heading and a rule. */
const sideRoom = (rows: number, side: Side): number => rows - TOP - BOTTOM - side.head.length - 1;

/** The first line of a body to show: where he scrolled to, or where it starts. */
function topOf(scroll: number | null, lines: number, room: number, follow: boolean): number {
  const most = Math.max(0, lines - room);
  return clamp(scroll ?? (follow ? most : 0), 0, most);
}

function sideLines(side: Side, state: State, w: number, h: number, p: Paint): string[] {
  const inner = w - 2;
  const out = side.head.map((line) => ` ${spread(line.left, line.right, inner, p)} `);
  out.push(rule(w, p));
  const room = h - out.length;
  const top = topOf(state.scroll, side.body.length, room, side.follow);
  for (const bit of side.body.slice(top, top + room)) out.push(` ${ink(p, fit(bit.text, inner), bit.tone)} `);
  while (out.length < h) out.push(' '.repeat(w));
  // More below than fits: the last line says so, in place of the text it covers. A session scrolled up holds still, and says how to follow it again.
  const below = side.body.length - top - room;
  const how = side.follow ? 'end follows them again' : state.focus === 'side' ? 'down, or pgdn' : 'tab, then down';
  if (below > 0) out[h - 1] = ` ${p.dim(fit(`… ${plural(below, 'more line')}: ${how}`, inner))} `;
  return out;
}

/** The keys that do something on the row the cursor is on. */
function rowKeys(board: Board, state: State, row: Row): string {
  if (state.focus === 'side') return 'up/down scroll · pgup/pgdn a page · home/end its ends · tab back to the queue';
  const read = 'tab read it';
  if (row.kind === 'backlog') return state.backlog ? 'enter close the list' : 'enter open the list';
  if (row.kind === 'sprint') {
    const n = sprintsWaiting(board).find((s) => s.sprint.id === row.id)?.cards.length ?? 0;
    return `p play it: ${n === 1 ? 'its thread moves' : `its ${n} threads move`} to Build · ${read}`;
  }
  if (row.kind === 'question') return `${row.tail ? `${row.tail} answer it · ` : ''}${read}`;
  if (row.kind === 'plan') return `a give the go-ahead · ${read}`;
  const c = cardOf(board, row.id);
  const answer = c?.question?.options.length ? `1-${Math.min(9, c.question.options.length)} answer it · ` : '';
  if (row.section === 'building') return 's stop its agent · tab its session · pgup/pgdn scroll it';
  if (row.section === 'done') return `a approve it · ${read}`;
  if (row.section === 'backlog') {
    const sprint = sprintsWaiting(board).find((s) => s.sprint.id === c?.sprint)?.sprint.name;
    return `b build it · ${sprint ? `p play ${sprint} · ` : ''}${read}`;
  }
  return `${c && halted(board, c) ? 'b carry on · ' : ''}${answer}${read}`;
}

/** The keys that work wherever the cursor is, said in full where there is room. */
function everyKeys(cols: number): string {
  const long = 'up/down move · g agents on/off · / add a thread · ? all keys · q leave, agents carry on';
  return long.length + 2 <= cols ? long : 'up/down move · g agents · / add · ? keys · q leave, agents carry on';
}

/** What the line above the keys says with nothing just done: the one thing about the page he should know. */
function standingNote(board: Board, state: State): string {
  if (state.page.lost) return 'The page is not answering. It may be restarting; if it has stopped, q and then spool starts it again.';
  if (board.notice) return board.notice;
  const waiting = board.columns.build.some((c) => !c.waiting && !halted(board, c));
  if (!waiting) return '';
  if (board.runner.builder === 'chat') return board.runner.watching ? '' : 'A chat builds here, and none is watching: say /spool-loop in one.';
  return board.runner.on ? '' : 'Agents are off, so nothing in Build starts: g switches them on.';
}

/** The screen for a terminal too small to draw the queue in: it says so, and what to do. */
function small(cols: number, rows: number): string[] {
  const words = [
    `Spool needs a terminal of ${SMALLEST.cols} by ${SMALLEST.rows} or more: this one is ${cols} by ${rows}.`,
    'Make the window bigger, or press q to leave.',
    'spool --plain prints the status instead.',
  ].flatMap((line) => wrap(line, Math.max(1, cols - 2)));
  const out: string[] = [];
  const top = Math.max(0, Math.floor((rows - words.length) / 2));
  for (let i = 0; i < rows; i++) out.push(fit(i >= top && i - top < words.length ? ` ${words[i - top]}` : '', cols));
  return out;
}

/** A screen with one body the width of the terminal: the brief, the keys, or a word while the page is not there yet. */
function whole(headLine: string, body: Bit[], top: number, said: string, keys: [string, string], cols: number, rows: number, p: Paint): string[] {
  const h = rows - TOP - BOTTOM;
  const out = [headLine, rule(cols, p)];
  for (const bit of body.slice(top, top + h)) out.push(` ${ink(p, fit(bit.text, cols - 2), bit.tone)} `);
  while (out.length < TOP + h) out.push(' '.repeat(cols));
  const below = body.length - top - h;
  if (below > 0) out[TOP + h - 1] = ` ${p.dim(fit(`… ${plural(below, 'more line')}: down, or pgdn`, cols - 2))} `;
  out.push(rule(cols, p), fit(` ${said}`, cols), p.dim(fit(` ${keys[0]}`, cols)), p.dim(fit(` ${keys[1]}`, cols)));
  return out;
}

/**
 * One screen, as `rows` lines of exactly `cols` columns: the header; the queue on the left with
 * what the cursor is on beside it; the line that says what just happened, or takes what is being
 * typed; and the keys. Everything on it comes from the board and the state, so the same two
 * always draw the same screen. `p` paints it; left out, the screen is plain text.
 */
export function frame(board: Board | null, state: State, cols: number, rows: number, p: Paint = paint(false)): string[] {
  if (cols < SMALLEST.cols || rows < SMALLEST.rows) return small(cols, rows);
  const top = head(board, state, cols, p);
  const leave = 'q leave, agents carry on';
  if (!board) {
    const port = portOf(state.page.url);
    const waiting = state.page.lost ? `The page at :${port} is not answering yet.` : port ? `Asking the page at :${port} for the board…` : 'Starting the page in the background…';
    return whole(top, [BLANK, { text: waiting }], 0, '', ['q leave', ''], cols, rows, p);
  }
  if (state.view === 'keys') return whole(top, keysBody(cols - 2), 0, '', ['any key goes back', ''], cols, rows, p);
  if (state.view === 'brief' && board.brief) {
    const body = briefBody(board.brief, cols - 2, state.now);
    return whole(top, body, topOf(state.scroll, body.length, rows - TOP - BOTTOM, false), state.said, ['enter the queue · up/down scroll · pgup/pgdn a page', `? all keys · ${leave}`], cols, rows, p);
  }

  const all = rowsOf(board, state);
  const at = cursor(all, state);
  const row = all[at]!;
  const left = queueWidth(cols);
  const right = cols - left - 1;
  const h = rows - TOP - BOTTOM;
  const queue = queueLines(board, state, all, at, left, h, p);
  const side = sideLines(sideOf(board, state, row, right - 2), state, right, h, p);
  const out = [top, rule(cols, p, left, '┬')];
  for (let i = 0; i < h; i++) out.push(`${queue[i]}${p.dim('│')}${side[i]}`);
  out.push(rule(cols, p, left, '┴'));
  if (state.adding !== null) {
    const lead = ' add a thread > ';
    out.push(fit(`${lead}${tail(state.adding, cols - lead.length - 2)}_`, cols));
  } else if (state.said) out.push(ink(p, fit(` ${state.said}`, cols), state.failed ? 'red' : undefined));
  else out.push(p.dim(fit(` ${standingNote(board, state)}`, cols)));
  const typing = state.adding !== null;
  out.push(p.dim(fit(` ${typing ? 'enter file it in the backlog · esc leave it' : rowKeys(board, state, row)}`, cols)));
  out.push(p.dim(fit(` ${typing ? '' : everyKeys(cols)}`, cols)));
  return out;
}

// ------------------------------------------------------------------ keys

/** The question a row is about: the one it is, or the one its thread waits on. */
function questionOf(board: Board, row: Row): { id: string; options: string[] } | undefined {
  if (row.kind === 'question') return board.needs.questions.find((q) => q.id === row.id);
  return (row.kind === 'thread' && cardOf(board, row.id)?.question) || undefined;
}

/** A key on the line being typed after `/`. */
function typed(state: State, k: string): { state: State; action?: Action } {
  const text = state.adding ?? '';
  if (k === 'esc') return { state: { ...state, adding: null } };
  if (k === 'enter') {
    const words = text.trim();
    const closed = { ...state, adding: null };
    return words ? { state: closed, action: { do: 'post', action: 'add', body: { text: words, to: 'proposed' }, done: 'Added to the backlog' } } : { state: closed };
  }
  if (k === 'backspace') return { state: { ...state, adding: [...text].slice(0, -1).join('') } };
  const more = k.startsWith('paste:') ? k.slice(6).replace(/\s+/g, ' ') : [...k].length === 1 ? k : '';
  return { state: more ? { ...state, adding: `${text}${more}`.slice(0, 400) } : state };
}

/** A key that scrolls a body of `lines` lines in `room` rows. Back where it starts, it is not scrolled at all. */
function scrolled(state: State, k: string, lines: number, room: number, follow: boolean): State {
  const most = Math.max(0, lines - room);
  const home = follow ? most : 0;
  const now = clamp(state.scroll ?? home, 0, most);
  const page = Math.max(1, room - 1);
  const moves: Record<string, number> = { up: now - 1, k: now - 1, down: now + 1, j: now + 1, pageup: now - page, pagedown: now + page, home: 0, end: most };
  const to = moves[k] ?? now;
  const next = clamp(to, 0, most);
  return { ...state, scroll: next === home ? null : next };
}

const SCROLLS = ['pageup', 'pagedown', 'home', 'end'];
const MOVES = ['up', 'down', 'j', 'k'];

/**
 * One key: the state it leaves, and what it asks of the page, if anything. Every action is a POST
 * the page's own buttons make, so a key can do nothing the page cannot, and nothing a command
 * could not.
 */
export function key(state: State, k: string, board: Board | null): { state: State; action?: Action } {
  if (k === 'ctrl-c') return { state, action: { do: 'quit' } };
  if (state.adding !== null) return typed(state, k);
  if (k === 'q') return { state, action: { do: 'quit' } };
  if (!board || state.cols < SMALLEST.cols || state.rows < SMALLEST.rows) return { state };
  // What the last action said stays until the next key.
  const fresh: State = { ...settle(state, board), said: '', failed: false };
  if (fresh.view === 'keys') return { state: { ...fresh, view: 'queue' } };
  if (k === '?') return { state: { ...fresh, view: 'keys' } };
  if (fresh.view === 'brief' && board.brief) {
    if (k === 'enter' || k === 'esc') return { state: { ...fresh, view: 'queue', scroll: null } };
    if (!MOVES.includes(k) && !SCROLLS.includes(k)) return { state: fresh };
    return { state: scrolled(fresh, k, briefBody(board.brief, fresh.cols - 2, fresh.now).length, fresh.rows - TOP - BOTTOM, false) };
  }

  const rows = rowsOf(board, fresh);
  const at = cursor(rows, fresh);
  const row = rows[at]!;
  const say = (said: string): { state: State } => ({ state: { ...fresh, said } });
  const post = (action: string, body: Record<string, unknown>, done: string): { state: State; action: Action } => ({ state: fresh, action: { do: 'post', action, body, done } });

  if (SCROLLS.includes(k) || (fresh.focus === 'side' && MOVES.includes(k))) {
    const side = sideOf(board, fresh, row, fresh.cols - queueWidth(fresh.cols) - 3);
    return { state: scrolled(fresh, k, side.body.length, sideRoom(fresh.rows, side), side.follow) };
  }
  if (MOVES.includes(k)) {
    const to = clamp(at + (k === 'up' || k === 'k' ? -1 : 1), 0, rows.length - 1);
    return { state: { ...fresh, at: rows[to]!.key, index: to, scroll: to === at ? fresh.scroll : null } };
  }
  if (k === 'esc') return { state: { ...fresh, focus: 'queue' } };
  if (k === 'tab') return { state: { ...fresh, focus: fresh.focus === 'queue' ? 'side' : 'queue' } };
  if (k === 'enter') {
    if (row.kind === 'backlog') return { state: { ...fresh, backlog: !fresh.backlog } };
    return { state: { ...fresh, focus: 'side' } };
  }
  if (k === '/') return { state: { ...fresh, adding: '' } };
  if (k === 'g') return post('runner', { on: !board.runner.on }, '');

  const c = row.kind === 'thread' ? cardOf(board, row.id) : undefined;
  if (k === 'b') {
    if (c && c.column === 'proposed') return post('move', { id: c.id, to: 'build' }, `In build: ${c.title}`);
    if (c && c.column === 'build' && halted(board, c)) return post('move', { id: c.id, to: 'building' }, `Building: ${c.title}`);
    return say('b sends a backlog thread to Build, and carries on with a stopped one. Open the backlog and move to a thread first.');
  }
  if (k === 'p') {
    const sprint = row.kind === 'sprint' ? board.sprints.find((s) => s.id === row.id) : sprintsWaiting(board).find((s) => c?.column === 'proposed' && s.sprint.id === c.sprint)?.sprint;
    return sprint ? post('play', { id: sprint.id }, `${sprint.name} is running`) : say('p plays a sprint. Open the backlog and move to one, or to a thread in one, first.');
  }
  if (k === 's') {
    return c?.column === 'building' ? post('stop', { id: c.id }, 'Stopped. It waits in Build until you carry on.') : say('s stops the agent on a thread that is being built.');
  }
  if (k === 'a') {
    if (row.kind === 'plan') return post('approve', { id: row.id }, 'The plan has your go-ahead');
    if (c?.done && !c.complete) return post('complete', { id: c.id }, 'Marked as complete');
    return say('a approves a finished thread, or gives a plan the go-ahead.');
  }
  if (/^[1-9]$/.test(k)) {
    const q = questionOf(board, row);
    if (!q) return say('A number answers a question: move to one under Needs you first.');
    const option = q.options[Number(k) - 1];
    if (option === undefined) return say(q.options.length ? `That question has ${plural(q.options.length, 'option')}.` : 'That question has no options to pick from: answer it in your own words on the page.');
    return post('answer', { id: q.id, choice: k }, `Answered: ${option}`);
  }
  return { state: fresh };
}

// ------------------------------------------------------------------ the loop

/** How much of a run from before this screen was opened is asked for: its last lines, this many. */
const HEARD_FIRST = 2000;

/** What the loop needs from outside, so a test can run it with no terminal. */
export interface Watching {
  ctx: Ctx;
  /** The project's folder, which the page's record is kept by. */
  root: string;
  page: PageRecord;
  /** This run started the page, and the header says so. */
  started: boolean;
  /** Switch the page's agents on, if they are off, as `spool --run` asks. */
  run?: boolean;
  io: { input: TermIn; output: TermOut };
  color: boolean;
  proc?: Proc;
  /** Each screen as it is drawn, for a test to read. */
  seen?: (lines: string[]) => void;
  /** How often the board is asked for, in ms. */
  every?: number;
}

/**
 * Draw the queue, and act on keys, until the human leaves. The board is asked for about once a
 * second, and again the moment an action has been taken. Resolves with where the page is and how
 * many agents it has at work, for the words said on the way out.
 */
export function watchQueue(w: Watching): Promise<{ url: string; building: number }> {
  return new Promise((resolve) => {
    const p = paint(w.color);
    let page = w.page;
    let board: Board | null = null;
    let over = false;
    let state: State = { ...start({ url: page.url, started: w.started, lost: false }, SMALLEST.cols, SMALLEST.rows, Date.now()), mark: w.color ? markLine(w.ctx) : '' };

    const draw = (): void => {
      if (over) return;
      const { cols, rows } = term.size();
      state = settle({ ...state, cols, rows, now: Date.now() }, board);
      const lines = frame(board, state, cols, rows, p);
      w.seen?.(lines);
      term.draw(lines);
    };
    const get = async (where: string): Promise<unknown> => {
      const res = await fetch(new URL(where, page.url), { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`the page said ${res.status}`);
      return res.json();
    };
    const post = async (action: string, body: unknown, again = true): Promise<{ ok: boolean; text: string }> => {
      if (!page.token) return { ok: false, text: 'The page that is up was started by an older Spool, and takes no keys from here: spool page --stop, then spool again.' };
      try {
        const res = await fetch(new URL(`api/${action}`, page.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-spool-token': page.token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        // A page that restarted hands out a new token, and writes it in its record: read it and try once more.
        const now = res.status === 403 && again ? pageUp(w.ctx, w.root) : undefined;
        if (now?.token && now.token !== page.token) {
          page = now;
          return await post(action, body, false);
        }
        const out = (await res.json()) as { ok?: boolean; text?: string };
        return { ok: out.ok === true, text: out.text ?? '' };
      } catch {
        return { ok: false, text: 'The page did not answer.' };
      }
    };

    // What each finished thread changed is asked for once, one thread at a time, behind the drawing.
    let sizing = false;
    const sizeUp = async (): Promise<void> => {
      if (sizing || !board) return;
      sizing = true;
      try {
        for (const id of board.columns.done.filter((c) => !c.complete && !(c.id in state.sizes)).map((c) => c.id).slice(0, 40)) {
          if (over) return;
          const diff = (await get(`api/diff?id=${id}`)) as { files?: { added: number; removed: number }[] };
          const files = diff.files ?? [];
          const sum = (pick: 'added' | 'removed'): number => files.reduce((n, f) => n + f[pick], 0);
          state = { ...state, sizes: { ...state.sizes, [id]: files.length ? `+${sum('added')} -${sum('removed')}` : '' } };
          draw();
        }
      } catch {
        // The page is busy or gone: the next look asks again.
      } finally {
        sizing = false;
      }
    };

    // The run of the thread the cursor is on: the end of it first, then only what is new. A thread no
    // longer being built is asked about once more, for its agent's last words, and then has said all it will.
    let hearing = false;
    const hear = async (): Promise<void> => {
      if (hearing || over || !board) return;
      const id = threadAt(board, state);
      const have = state.run?.id === id ? state.run : null;
      const live = board.columns.building.some((c) => c.id === id);
      if (!id || (have && !live && !have.live)) return;
      hearing = true;
      try {
        const where = `api/run?id=${id}&from=${have ? have.next : -HEARD_FIRST}${have?.run ? `&run=${encodeURIComponent(have.run)}` : ''}`;
        const answer = (await get(where)) as { run: string; from: number; next: number; lines: string[] };
        const held = state.run?.id === id ? state.run : null;
        // Another run than the one held, or not from where that had got to: what is held is replaced.
        const anew = !held || held.run !== answer.run || answer.from !== held.next;
        state = { ...state, run: { id, run: answer.run, next: answer.next, lines: anew ? answer.lines : [...held.lines, ...answer.lines], live } };
        if (anew || answer.lines.length) draw();
      } catch {
        // The page is busy or gone: the next look asks again.
      } finally {
        hearing = false;
      }
      // He moved on while this was being asked: the thread he is on now is asked about at once.
      if (!over && board && threadAt(board, state) !== id) void hear();
    };

    let asked = 0;
    let shown = 0;
    const look = async (): Promise<void> => {
      const mine = ++asked;
      let found: Board | undefined;
      try {
        found = (await get('api/board')) as Board;
      } catch {
        // It may have restarted, at the same address or another, or have been stopped.
        const now = pageUp(w.ctx, w.root);
        if (now) page = now;
      }
      // An answer that took longer than the one asked for after it is old news.
      if (over || mine < shown) return;
      shown = mine;
      const first = !board && !!found;
      if (found) board = found;
      state = { ...state, page: { ...state.page, url: page.url, lost: !found } };
      if (first && board) {
        state = opening(state, board);
        if (w.run && !board.runner.on) void post('runner', { on: true }).then(look);
      }
      draw();
      void hear();
      void sizeUp();
    };

    // Keys are taken one at a time, in the order they were pressed, each after what the last one asked for.
    let line: Promise<void> = Promise.resolve();
    const press = async (k: string): Promise<void> => {
      if (over) return;
      const { state: next, action } = key(state, k, board);
      state = next;
      if (action?.do === 'quit') {
        over = true;
        clearInterval(timer);
        term.close();
        resolve({ url: page.url, building: board?.columns.building.length ?? 0 });
        return;
      }
      draw();
      void hear();
      if (action?.do !== 'post') return;
      const out = await post(action.action, action.body);
      state = { ...state, said: out.ok ? out.text || action.done : out.text || 'That did not work.', failed: !out.ok };
      await look();
    };

    const term = openTerm(
      w.io,
      {
        key: (k) => void (line = line.then(() => press(k))),
        resize: draw,
        crash: (error) => w.ctx.err(`spool: the interface stopped on an error, and the page is still up.\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
      },
      w.proc,
    );
    const timer = setInterval(() => void look(), w.every ?? 1000);
    draw();
    void look();
  });
}

/**
 * The queue for the project at `ctx.cwd`, on the terminal given: over the page that is up for it,
 * or, with none up, over one started in the background as `spool page -d` starts it, with agents
 * off unless asked for. It resolves when the human leaves, with the page still running; it rejects,
 * with the words to say, where no page could be started.
 */
export function queueFor(
  ctx: Ctx,
  io: Watching['io'],
  options: { run?: boolean; proc?: Proc; seen?: Watching['seen']; every?: number; /** Where a page it starts is to listen, for a test: the usual port otherwise. */ port?: number } = {},
): Promise<{ url: string; building: number }> {
  const ws = Workspace.open(ctx.cwd, ctx.now);
  let root: string;
  try {
    root = ws.home.root;
  } finally {
    ws.close();
  }
  const { port, ...watching } = options;
  const show = (page: PageRecord, started: boolean): Promise<{ url: string; building: number }> => watchQueue({ ctx, root, page, started, io, color: inColor(ctx), ...watching });
  const up = pageUp(ctx, root);
  if (up) return show(up, false);
  // With no page up there is no engine to be a face of.
  ctx.out(`Starting the Spool page in the background${options.run ? ', with agents on' : ''}…`);
  return new Promise((resolve, reject) => {
    const args = [...(options.run ? ['--run'] : []), ...(port ? ['--port', String(port)] : [])];
    startDetached(ctx, root, path.join(CODE_DIR, `cli${CODE_EXT}`), args, (code, lines, started) => {
      // Another start got there first: that page is the one.
      const there = started ?? (code === 0 ? pageUp(ctx, root) : undefined);
      if (there) resolve(show(there, !!started));
      else reject(new Error(lines.join('\n')));
    });
  });
}

/**
 * Bare `spool`, typed at a real terminal: the queue, full-screen. Returns nothing where there is
 * no terminal to take over, and the caller prints the status as it always did.
 */
export function openQueue(ctx: Ctx, options: { run?: boolean } = {}): Result | undefined {
  // A terminal that cannot move its cursor would only be filled with codes.
  if (!process.stdin.isTTY || !process.stdout.isTTY || ctx.env.TERM === 'dumb') return undefined;
  const end = (code: number): void => {
    process.exitCode = code;
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  };
  queueFor(ctx, { input: process.stdin, output: process.stdout }, options).then(
    ({ url, building }) => {
      const agents = building ? `, and ${building === 1 ? 'its agent carries' : `its ${building} agents carry`} on` : '';
      ctx.out(`The Spool page is still up at ${url}${agents}. spool page --stop ends it.`);
      end(0);
    },
    (error: Error) => {
      ctx.err(error.message);
      end(1);
    },
  );
  return { text: '' };
}
