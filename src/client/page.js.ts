/**
 * The page's script: one string, put in the page's last <script> by `page.html.ts`.
 *
 * Plain browser JavaScript, with no build step and nothing to load. It asks `/api/board` for the
 * board about once a second, builds what it shows as nodes with the `el()` helper, and sends each
 * thing the human does to the server as a POST. Inside the string: no backticks, and no `${` but
 * the two that put in the models and efforts a ticket offers.
 */

import { EFFORTS, MODELS } from '../agent.ts';

export const JS = String.raw`const TOKEN = '__TOKEN__';
// Which build of Spool this page came from. The board names the build that serves it now.
const BUILD = '__BUILD__';
const COLUMNS = [
  ['proposed', 'Backlog', 'Nothing here is built. Drag a thread to Build, or press ▶.'],
  ['build', 'Build', 'Agents take these in order, top first. Drag a card up or down to change it.'],
  ['building', 'Building', 'An agent has it now.'],
  ['done', 'Done', 'For you to check.'],
];
const DOT = { proposed: '🟠', build: '🟢', building: '🔵', done: '✅' };
const STATE = { proposed: 'Backlog', build: 'Build', building: 'Building', done: 'Done' };
const SIZES = [['xs', 'Tiny'], ['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Huge']];
const PRIORITIES = ['Urgent', 'High', 'Normal', 'Someday'];
const MODELS = ${JSON.stringify(MODELS)};
const EFFORTS = ${JSON.stringify(EFFORTS)};
const ARROWS = ['↑↑', '↑', '=', '↓'];

let last = '';
let current = null;
let busy = false;
// Which view is up: the board, the backlog with its sprints, or the roadmap of sprints in order.
let view = 'board';
// A view the page no longer has, remembered or linked to, is the board.
try { view = ['backlog', 'roadmap'].find((v) => v === localStorage.getItem('spool-view')) || 'board'; } catch (e) {}
// A link can name the view: /?view=backlog
const asked = /[?&]view=(board|backlog|roadmap)\b/.exec(location.search);
if (asked) view = asked[1];
// The thread that is open, if one is, and notes begun but not yet added.
let openId = null;
const drafts = new Map();
// A page that reloaded itself onto a new build brings the replies that were begun along.
try {
  for (const [id, words] of JSON.parse(sessionStorage.getItem('spool-drafts') || '[]')) drafts.set(id, words);
  sessionStorage.removeItem('spool-drafts');
} catch (e) {}
// Completed threads are history: kept, and out of the way until asked for.
let showHistory = false;
// Archived threads are out of sight: their section at the foot of the backlog stays folded until opened.
let showArchived = false;
// What the board is narrowed to: { kind: 'tag' | 'version' | 'sprint', value }, and whatever is typed in the search.
let only = null;
let query = '';
// The "+ Add" that is open ('proposed', 'build', or 'sprint' for a new sprint), and what has been typed into it.
let adding = null;
let addDraft = '';

// (An attribute given as true is written empty, which is right for "hidden" or "open" and wrong for
// "draggable": that one has to say "true", or the browser does not let the thing be dragged.)
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) node.append(kid);
  return node;
};

// What the page has to say, for a moment. What can be taken back carries an Undo for a few seconds,
// and stays up while the pointer is on it.
function say(words, undo) {
  const box = document.getElementById('said');
  const away = () => box.classList.remove('on', 'undoable');
  const wait = undo ? 5000 : 2600;
  box.replaceChildren(words, undo ? el('button', { onclick: () => { clearTimeout(say.t); away(); undo(); } }, 'Undo') : '');
  box.classList.add('on');
  box.classList.toggle('undoable', !!undo);
  clearTimeout(say.t);
  say.t = setTimeout(away, wait);
  box.onmouseenter = () => clearTimeout(say.t);
  box.onmouseleave = () => { clearTimeout(say.t); say.t = setTimeout(away, wait); };
}

// Copy words for him, and say so. Where the clipboard is not to be had, the old way still works.
async function copy(words, done) {
  try {
    await navigator.clipboard.writeText(words);
  } catch (e) {
    const area = el('textarea', { style: 'position: fixed; opacity: 0' });
    area.value = words;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) return say('Could not copy ' + words);
  }
  say(done);
}
const copyId = (id) => copy(id, 'Copied ' + id);
// A ticket's own address: the page, with the thread after the #, and nothing else of where he is.
const linkOf = (id) => location.origin + location.pathname + projectQuery() + '#' + id;
const LINK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 9.5a3 3 0 0 0 4.24 0l2.5-2.5a3 3 0 0 0-4.24-4.24l-.75.75"/><path d="M9.5 6.5a3 3 0 0 0-4.24 0l-2.5 2.5a3 3 0 0 0 4.24 4.24l.75-.75"/></svg>';
function copyLinkNode(id) {
  const node = el('button', { class: 'copylink', title: 'Copy a link to this thread', 'aria-label': 'Copy link', onclick: () => copy(linkOf(id), 'Copied the link to ' + id) });
  node.innerHTML = LINK_ICON;
  return node;
}

// The page's server hands out a new token each time it starts. A page left open across a restart
// asks for the new one and tries again, where it used to fail and lose what had been typed.
let token = TOKEN;
async function freshToken() {
  const found = /const TOKEN = '([^']+)';/.exec(await (await fetch('/')).text());
  if (found) token = found[1];
}
function send(action, body) {
  return fetch('/api/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(withProject(body)) });
}

async function post(action, body, done, undo) {
  busy = true;
  say('Saving…');
  try {
    let res = await send(action, body);
    if (res.status === 403) {
      await freshToken();
      res = await send(action, body);
    }
    const out = await res.json();
    say(out.ok ? out.text || done : out.text || 'That did not work', out.ok ? undo : null);
    // Done, it says which thread it made or wrote on, where it did, for what is sent after it (pictures).
    return out.ok && (out.id || true);
  } catch (e) {
    say('The page lost its server. Run spool page again.');
    return false;
  } finally {
    busy = false;
    last = '';
    // Show what was just done at once. The box they typed in still has the focus, and waiting for
    // it to lose it is what made adding feel stuck.
    load(true);
  }
}

// ---- what is shown: narrowed by a sprint, a tag or a version, and by the search

const sprintName = (b, id) => (b.sprints.find((s) => s.id === id) || {}).name || '';
function shows(c) {
  if (only && (only.kind === 'tag' ? !c.tags.includes(only.value) : only.kind === 'version' ? c.version !== only.value : c.sprint !== only.value)) return false;
  if (!query) return true;
  const hay = (c.title + ' ' + c.id + ' ' + c.tags.join(' ') + ' ' + c.version + ' ' + c.note).toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => hay.includes(word));
}
const narrow = (kind, value) => { only = only && only.kind === kind && only.value === value ? null : { kind, value }; redraw(); };
const everyCard = (b) => COLUMNS.flatMap(([key]) => b.columns[key]);

// ---- one thread, as a card on the board and as a row in the backlog

function chipsOf(c, b) {
  return [
    c.done && el('span', { class: 'chip ' + (c.complete ? 'ok' : 'check') }, c.complete ? '✓ Complete' : planWaits(b, c.id) ? 'Waiting for your go-ahead' : 'For you to check'),
    lookAt(b, c.id) > 0 && el('span', { class: 'chip tag', title: 'Calls an agent made, or a skill it wrote, for you to look at on the thread', onclick: () => openThread(c.id) }, '🧾 ' + lookAt(b, c.id) + ' to look at'),
    c.type !== 'change' && el('span', { class: 'chip' }, c.type),
    c.suggested && el('span', { class: 'chip ai', title: c.suggested }, '✨ AI suggested'),
    c.sprint && el('span', { class: 'chip tag sprint', title: 'Show only this sprint', onclick: () => narrow('sprint', c.sprint) }, sprintName(b, c.sprint)),
    c.version && el('span', { class: 'chip tag', title: 'Show only this version', onclick: () => narrow('version', c.version) }, 'v' + c.version),
    c.tags.map((t) => el('span', { class: 'chip tag', title: 'Show only this tag', onclick: () => narrow('tag', t) }, '#' + t)),
  ];
}

// What an agent did on the thread by itself and he has not looked at: the calls it made, the skills it wrote.
const lookAt = (b, id) => callsFor(b, id).length + skillsFor(b, id).length;

// Who built it, how urgent, how big: the small facts at the foot of a card, the way a board has always shown them.
function facts(c) {
  return [
    !c.done && el('span', { class: 'prio p' + c.p, title: c.priority }, ARROWS[c.p]),
    c.size && el('span', { class: 'size', title: c.difficulty }, c.size.toUpperCase()),
    (c.column === 'building' || c.done) && c.thread.by && smallAvatar(c.thread.by),
  ];
}
// The model and effort its agent was started with, where the page started it, and why they were chosen on hover.
function ranNode(c, cls) {
  const said = c.run && [c.run.model, c.run.effort].filter(Boolean).join(' · ');
  if (!said) return null;
  return el('span', { class: cls, title: 'Started with ' + said + (c.run.why ? '. Why: ' + c.run.why : '') }, said);
}
// A button that puts a command on the clipboard, for him to paste into a terminal.
function copyNode(command, label) {
  return el('button', { class: 'act', title: 'Copies: ' + command, onclick: () => {
    const done = () => say('Copied: ' + command);
    try { navigator.clipboard.writeText(command).then(done, () => say(command)); } catch (e) { say(command); }
  } }, label);
}
function smallAvatar(who) {
  const node = avatar(who);
  node.classList.add('who22');
  return node;
}
// The run of this thread, if the page's own runner is building it right now.
const liveOf = (c, b) => b.runner.running.find((run) => run.id === c.id) || null;
// A thread the human stopped while it was being built: it waits in Build until they carry on.
const stoppedOf = (c, b) => c.column === 'build' && b.runner.stopped.includes(c.id);
// Stop the agent on one thread, and no other.
const stopNode = (c, cls, label) => el('button', { class: cls, title: 'Stop the agent on this thread, now. The thread waits in Build until you carry on. Other threads go on being built.',
  onclick: () => post('stop', { id: c.id }, 'Stopped') }, label);
// Carry on with a stopped thread: it is built next, as one dragged into Building is.
const carryOnNode = (c, cls) => el('button', { class: cls, title: 'Build this again. It is taken next, ahead of the rest of Build.',
  onclick: () => post('move', { id: c.id, to: 'building' }, 'Building: ' + c.title) }, '▶ Carry on');
// How long an agent has been at it, the way a person would say it.
function took(since) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm';
  return Math.floor(s / 86400) + 'd';
}
// A tool call the agent needs a yes for, and waits on: what it is, and the three answers. The answer goes back to the
// agent, which carries on or is told no. The card says it in short; the ticket shows the call whole, as it was written,
// and there a no can say why, which the agent is told too.
function permitNode(c, a, onTicket) {
  const answer = (how, done, why) => post('permit', { id: c.id, ask: a.ask, answer: how, why: why || '' }, done);
  return el('div', { class: 'q' },
    onTicket ? [el('div', {}, '🔐 May it run this?' + (a.why ? ' ' + a.why + '.' : '')), el('pre', { class: 'mono' }, a.full)]
      : el('div', { title: a.full }, '🔐 May it run ', el('span', { class: 'mono' }, a.what), '?', a.why ? ' ' + a.why + '.' : ''),
    el('button', { onclick: () => answer('once', 'Allowed once') }, 'Allow once'),
    a.rest && el('button', { title: 'It is not asked again in this run: ' + a.rest, onclick: () => answer('run', 'Allowed for this run') }, 'Allow for this run'),
    el('button', { onclick: () => answer('no', 'Refused') }, 'No'),
    onTicket && sayNode('Why not?', 'No, because', (why) => answer('no', 'Refused', why)));
}
// The line a Building card shows: what the agent is doing now, and for how long. The runner's own output is the freshest.
function liveLine(c, b) {
  if (b && stoppedOf(c, b)) return el('div', { class: 'live', title: 'You stopped the agent that was building this. Nothing builds it until you carry on.' }, el('span', { class: 'now' }, '■ Stopped'));
  if (!c.live) return null;
  const run = b && liveOf(c, b);
  const now = (run && run.lines.at(-1)) || c.live.note || 'starting…';
  return el('div', { class: 'live', title: 'What the agent is doing now, and how long it has been at it' },
    el('span', { class: 'pulse' }), el('span', { class: 'now' }, now), el('span', { class: 'for', 'data-since': c.live.since }, took(c.live.since)));
}
// What a thread waits on, as its card shows it: a small mark at the top, in the colour of who has to act.
// The note under the title says the rest; a ticket says all of it. A question is asked on the thread
// alone, so its card only says a call is wanted, and the click that opens the thread is where it is made.
function waitMark(c, b) {
  const w = c.waiting;
  if (!w) return null;
  const label = w.kind === 'you' ? (c.question || (c.proposals && c.proposals.length) ? 'Needs a call from you' : 'Needs you') : w.kind === 'hold' ? 'On hold'
    : w.kind === 'thread' ? 'Waiting on ' + (w.on.length === 1 ? w.on[0].id : w.on.length + ' threads') : 'Agent stopped unfinished';
  const said = w.kind === 'stuck' && lastWords(c, b);
  const title = w.kind === 'stuck' ? 'It ' + w.text + (said ? '. It last said: ' + said : '') : c.question ? 'An agent asked a question: open the thread to answer it' : '';
  return el('div', { class: 'flag ' + w.kind, title }, label);
}
// The last thing an agent that gave up said: on the thread if it wrote it there, or as this page heard it.
function lastWords(c, b) {
  if (c.waiting.said) return c.waiting.said;
  const run = ((b && b.runner && b.runner.recent) || []).find((r) => r.id === c.id && /^unfinished/.test(r.outcome));
  const cut = run ? run.outcome.indexOf(' — ') : -1;
  return cut >= 0 ? run.outcome.slice(cut + 3) : '';
}
// A move between the backlog and Build is taken back by the same move the other way. Moves that stop
// an agent or undo its work cannot be taken back like that, and a thread on hold would lose its hold.
function moveBack(id, from, to) {
  const c = current && everyCard(current).find((x) => x.id === id);
  const plain = (k) => k === 'proposed' || k === 'build';
  if (!c || c.column !== from || from === to || !plain(from) || !plain(to) || (c.waiting && c.waiting.kind === 'hold')) return null;
  return () => post('move', { id, to: from }, from === 'build' ? 'Back in build: ' + c.title : 'Back in the backlog: ' + c.title);
}
// Abort a thread being built: the agent on it stops, and the thread goes straight back to the backlog.
const abortNode = (c, cls) => el('button', { class: cls, title: 'Stop building this, undo what it changed, and move it back to the backlog. Nothing builds it until you move it to Build again.',
  onclick: () => post('abort', { id: c.id }, 'Aborted. Back in the backlog: ' + c.title) }, '↩ Abort');
function moves(c, b) {
  return [
    b && liveOf(c, b) && stopNode(c, 'act', '■ Stop'),
    b && stoppedOf(c, b) && carryOnNode(c, 'act go'),
    c.column === 'building' && abortNode(c, 'act'),
    c.column === 'proposed' && el('button', { class: 'act go', title: 'Move to Build', onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title, moveBack(c.id, 'proposed', 'build')) }, '▶ Build'),
    c.column === 'build' && el('button', { class: 'act', title: 'Back to the backlog', onclick: () => post('move', { id: c.id, to: 'proposed' }, 'Back in the backlog', moveBack(c.id, 'build', 'proposed')) }, 'Not yet'),
    c.done && !c.complete && el('button', { class: 'tick', title: 'Mark as complete', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓'),
  ];
}
// Archiving: a thread waiting in the backlog put out of sight, not dropped. One click, and one click back.
const ARCHIVE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.75 6v6.75a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75V6M6.5 9h3"/></svg>';
function archiveNode(c) {
  if (c.column !== 'proposed') return null;
  const node = el('button', { class: 'arch', title: 'Archive: out of sight, not dropped. It is kept under Archived, at the foot of the Backlog view.', 'aria-label': 'Archive',
    onclick: () => post('archive', { id: c.id }, 'Archived: ' + c.title, () => post('unarchive', { id: c.id }, 'Back in the backlog: ' + c.title)) });
  node.innerHTML = ARCHIVE_ICON;
  return node;
}
function dragOf(node, c, from) {
  node.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.id + ' ' + from); node.classList.add('dragging'); busy = true; });
  node.addEventListener('dragend', () => { node.classList.remove('dragging'); unland(); busy = false; });
}

// Dragging over Build, a thin line shows where the card will land: before the first card whose middle is below the pointer.
function landAt(col, y) {
  const cards = [...col.querySelectorAll('.card:not(.dragging)')];
  const below = cards.find((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  const line = document.querySelector('.landing') || el('div', { class: 'landing' });
  const at = below || (cards.length ? cards[cards.length - 1].nextSibling : null);
  if (line.parentNode !== col || line.nextSibling !== at) col.insertBefore(line, at);
}
function unland() {
  const line = document.querySelector('.landing');
  if (line) line.remove();
}
// Where a drop at the landing line puts a thread in Build's line, as the order command takes it; null where it changes nothing.
function spotOf(col, id) {
  const line = col.querySelector('.landing');
  if (!line) return null;
  const all = [...col.querySelectorAll('.card')];
  const others = all.filter((n) => n.dataset.id !== id);
  if (!others.length) return null;
  let below = line.nextSibling;
  while (below && !(below.classList && below.classList.contains('card'))) below = below.nextSibling;
  if (below && below.dataset.id === id) below = all[all.indexOf(below) + 1] || null;
  const mine = all.find((n) => n.dataset.id === id);
  // Dropped just where it already is.
  if (mine && (all[all.indexOf(mine) + 1] || null) === below) return null;
  return below ? { before: below.dataset.id } : { after: others[others.length - 1].dataset.id };
}

// The line under a card's title, and on a Building card what its agent was started with, quietly after it.
function noteNode(c) {
  const ran = c.column === 'building' && ranNode(c, 'ran');
  if (c.done || (!c.note && !ran)) return null;
  return el('div', { class: 'note' }, c.note && inline(c.note), c.note && ran ? ' · ' : '', ran);
}

function cardNode(c, b) {
  // Any card can be dragged to any column, at any time, and opens its ticket from anywhere on it.
  const node = el('div', { class: 'card' + (c.complete ? ' past' : ''), draggable: 'true', 'data-id': c.id },
    waitMark(c, b),
    el('div', { class: 'title' }, c.title),
    el('div', { class: 'chips' }, chipsOf(c, b)),
    c.why && !c.done && el('div', { class: 'why', title: c.why }, inline(c.why)),
    noteNode(c),
    liveLine(c, b),
    b && liveOf(c, b) && liveOf(c, b).asking && permitNode(c, liveOf(c, b).asking, false),
    el('div', { class: 'meta' },
      el('span', { class: 'key', title: 'Copy the id', onclick: () => copyId(c.id) }, c.id),
      el('span', { class: 'push' }), facts(c), archiveNode(c), moves(c, b)));
  dragOf(node, c, c.column);
  return opensOn(node, c.id);
}

function rowNode(c, b) {
  const node = el('div', { class: 'row', draggable: !c.done && c.column !== 'building' && 'true', 'data-id': c.id },
    el('div', {}, el('span', { class: 'title', onclick: () => openThread(c.id) }, c.title),
      el('span', { class: 'chips', style: 'display: inline-flex; margin: 0 0 0 8px; vertical-align: middle' }, chipsOf({ ...c, sprint: '', done: false }, b)),
      c.why && !c.done && el('div', { class: 'why', title: c.why }, inline(c.why))),
    el('div', { class: 'right' },
      el('span', { class: 'state ' + c.column }, STATE[c.column]),
      facts(c), el('span', { class: 'key', title: 'Copy the id', onclick: () => copyId(c.id) }, c.id), archiveNode(c), moves(c)));
  if (!c.done && c.column !== 'building') dragOf(node, c, 'row');
  return node;
}

// "+ Add": a thread added under a column starts in that column.
function addNode(column, placeholder) {
  if (adding !== column) {
    return el('button', { class: 'add', onclick: () => { adding = column; addDraft = ''; redraw(); } }, '+ Add');
  }
  const close = () => { adding = null; addDraft = ''; redraw(); };
  const save = async () => {
    const words = addDraft.trim();
    if (!words) return;
    adding = null;
    addDraft = '';
    // If it could not be saved, their words go back in the box: nothing typed is ever thrown away.
    const made = await post('add', { text: words, to: column }, column === 'build' ? 'Added to build' : 'Added to the backlog');
    if (!made) {
      adding = column;
      addDraft = words;
      redraw();
    } else await sendPictures(made, 'add:' + column);
  };
  const box = el('textarea', { placeholder: placeholder,
    oninput: (e) => { addDraft = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    } });
  box.value = addDraft;
  takePictures(box, 'add:' + column);
  return el('div', { class: 'adding' }, box, trayNode('add:' + column),
    el('div', { class: 'acts' }, el('button', { class: 'go', onclick: save }, 'Add'), el('button', { onclick: close }, 'Cancel')));
}

// ---- each column can be sorted and filtered by itself; the choice is remembered

const SORTS = [['', 'Sort: as it stands'], ['priority', 'Sort: most urgent'], ['small', 'Sort: smallest'], ['large', 'Sort: largest'], ['new', 'Sort: newest'], ['old', 'Sort: oldest'], ['title', 'Sort: A to Z']];
const BIG = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };
let cols = {};
try { cols = JSON.parse(localStorage.getItem('spool-columns') || '{}') || {}; } catch (e) {}
const colOf = (key) => cols[key] || { sort: '', filter: '' };
function setCol(key, change) {
  cols[key] = { ...colOf(key), ...change };
  try { localStorage.setItem('spool-columns', JSON.stringify(cols)); } catch (e) {}
  redraw();
}
// What a column can be narrowed to depends on what is in it: its tags, sprints, versions and kinds of thread.
function filtersOf(cards, b) {
  const seen = (pick) => [...new Set(cards.flatMap(pick).filter(Boolean))].sort();
  return [
    ['', 'Show: all'],
    cards.some((c) => c.suggested) && ['ai', '✨ AI suggested'],
    cards.some((c) => c.question) && ['ask', '❓ Needs you'],
    cards.some((c) => !c.size) && ['unsized', 'Not sized'],
    ...seen((c) => [c.type !== 'change' && c.type]).map((t) => ['type:' + t, t]),
    ...seen((c) => [c.sprint]).map((id) => ['sprint:' + id, sprintName(b, id)]),
    ...seen((c) => [c.version]).map((v) => ['version:' + v, 'v' + v]),
    ...seen((c) => c.tags).map((t) => ['tag:' + t, '#' + t]),
  ].filter(Boolean);
}
function passes(c, filter) {
  if (!filter) return true;
  if (filter === 'ai') return !!c.suggested;
  if (filter === 'ask') return !!c.question;
  if (filter === 'unsized') return !c.size;
  const [kind, value] = [filter.slice(0, filter.indexOf(':')), filter.slice(filter.indexOf(':') + 1)];
  return kind === 'tag' ? c.tags.includes(value) : kind === 'type' ? c.type === value : kind === 'sprint' ? c.sprint === value : c.version === value;
}
function sorted(cards, sort) {
  const size = (c, missing) => (c.size ? BIG[c.size] : missing);
  const by = {
    priority: (a, z) => a.p - z.p,
    small: (a, z) => size(a, 9) - size(z, 9),
    large: (a, z) => size(z, -1) - size(a, -1),
    new: (a, z) => z.created.localeCompare(a.created),
    old: (a, z) => a.created.localeCompare(z.created),
    title: (a, z) => a.title.localeCompare(z.title),
  }[sort];
  return by ? [...cards].sort(by) : cards;
}
function toolsNode(key, cards, b) {
  const { sort, filter } = colOf(key);
  const options = filtersOf(cards, b);
  // A filter for something that has since left the column would hide everything: let it go.
  const live = options.some(([v]) => v === filter) ? filter : '';
  const pick = (list, value, onpick, label) => {
    const node = el('select', { class: value ? 'set' : '', 'aria-label': label, onchange: (e) => { const v = e.target.value; e.target.blur(); onpick(v); } },
      list.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  return el('div', { class: 'tools' },
    pick(SORTS, sort, (v) => setCol(key, { sort: v }), 'Sort this column'),
    pick(options, live, (v) => setCol(key, { filter: v }), 'Filter this column'));
}

// "Add to Build", for everything the backlog is showing right now. It starts work on all of them,
// so it asks once: the first press arms it, the second does it.
let armed = '';
function addAllNode(where, cards) {
  if (!cards.length) return null;
  const ids = cards.map((c) => c.id);
  const key = where + ':' + ids.join(',');
  const label = cards.length === 1 ? '▶ Add 1 to Build' : '▶ Add all ' + cards.length + ' shown to Build';
  if (armed !== key) {
    return el('button', { class: 'foot addall', title: 'Moves what is shown here, and only that, to Build', onclick: () => { armed = key; redraw(); setTimeout(() => { if (armed === key) { armed = ''; redraw(); } }, 5000); } }, label);
  }
  return el('button', { class: 'foot addall go', onclick: () => { armed = ''; post('move-many', { ids }, cards.length + ' moved to Build'); } },
    'Yes, move ' + cards.length + ' to Build');
}

// ---- the board: four columns

function drawBoard(b) {
  const board = document.getElementById('board');
  const before = placesOf(board);
  board.replaceChildren(...COLUMNS.map(([key, name, hint]) => {
    const whole = b.columns[key].filter(shows);
    const tools = toolsNode(key, whole, b);
    const filter = tools.lastChild.value;
    const every = sorted(whole.filter((c) => passes(c, filter)), colOf(key).sort);
    // Done shows what is still for them to check. What they marked complete is history, a click away.
    const past = key === 'done' ? every.filter((c) => c.complete) : [];
    const cards = key === 'done' ? every.filter((c) => !c.complete) : every;
    // Every column takes a card dropped on it; only the backlog and Build take a new thread typed in.
    const drop = key === 'proposed' || key === 'build';
    // Build drawn as it stands is the order it will be built in, so a drop there is a place in that line.
    const line = key === 'build' && !colOf(key).sort;
    return el('section', { class: 'col', 'data-column': key,
      ondragover: (e) => {
        e.preventDefault();
        e.currentTarget.classList.add('over');
        if (line) landAt(e.currentTarget, e.clientY);
      },
      ondragleave: (e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        e.currentTarget.classList.remove('over');
        unland();
      },
      ondrop: (e) => {
        e.currentTarget.classList.remove('over');
        const [id, from] = e.dataTransfer.getData('text/plain').split(' ');
        const spot = line && id ? spotOf(e.currentTarget, id) : null;
        unland();
        if (!id || (from === key && !spot)) return;
        e.preventDefault();
        // The server says what the move did: stopped an agent, undid its work, or queued it to build next.
        // Dropped at a place in Build, it is moved there first if it came from elsewhere, then put in that place.
        // A move that can be taken back says so, with its Undo.
        const back = moveBack(id, from, key);
        const said = back ? (key === 'build' ? 'In build' : 'Back in the backlog') : '';
        if (spot) post('order', { id, ...spot }, said, back);
        else post('move', { id, to: key }, said, back);
      } },
      el('h2', {}, DOT[key] + ' ' + name, el('span', { class: 'count' }, filter ? every.length + ' of ' + whole.length : String(cards.length))),
      line && cards.length > 1 && el('div', { class: 'hint' }, 'Built top first. Drag a card up or down to change the order.'),
      whole.length > 1 && tools,
      cards.length ? cards.map((c) => cardNode(c, b)) : el('div', { class: 'empty' }, filter ? 'Nothing here matches.' : key === 'done' ? 'Nothing left to check.' : hint),
      key === 'done' && cards.length > 1 && el('button', { class: 'foot go', onclick: () => post('complete-all', {}, 'All marked as complete') }, '✓ Mark all ' + cards.length + ' as complete'),
      key === 'done' && b.history > 0 && el('button', { class: 'history', onclick: () => { showHistory = !showHistory; redraw(); } },
        (showHistory ? '▾ Hide history' : '▸ History') + ' · ' + b.history + ' complete'),
      key === 'done' && showHistory && past.map((c) => cardNode(c, b)),
      key === 'done' && showHistory && b.history > past.length && !only && !query && el('div', { class: 'empty' }, '+ ' + (b.history - past.length) + ' older'),
      drop && addNode(key, key === 'build' ? 'What should be built?' : 'What do you want added?'),
      key === 'proposed' && cards.length > 0 && el('div', { style: 'margin-top: 8px' }, addAllNode('board', cards)));
  }));
  slide(board, before);
}

// Cards move, they do not jump. Where each card was before the board was drawn again is measured,
// and a card that is somewhere else now slides there from its old place; one never seen before
// fades in. Not while a card is being dragged, not on the first draw, and not where the system
// asks for less motion. Places are taken from the board's own corner, so what changes above it
// does not set every card moving.
const SLIDE_MS = 200;
const known = new Set();
let boardSeen = false;
function placesOf(board) {
  const at = new Map();
  if (board.hidden) return at;
  const corner = board.getBoundingClientRect();
  for (const node of board.querySelectorAll('.card[data-id]')) {
    const r = node.getBoundingClientRect();
    if (r.width) at.set(node.dataset.id, { x: r.left - corner.left, y: r.top - corner.top });
  }
  return at;
}
function slide(board, before) {
  const first = !boardSeen;
  boardSeen = true;
  const still = first || !!document.querySelector('.dragging') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const corner = board.getBoundingClientRect();
  for (const node of board.querySelectorAll('.card[data-id]')) {
    const id = node.dataset.id;
    const fresh = !known.has(id);
    known.add(id);
    if (still || !node.animate) continue;
    const was = before.get(id);
    if (was) {
      const r = node.getBoundingClientRect();
      const dx = was.x - (r.left - corner.left);
      const dy = was.y - (r.top - corner.top);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        node.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'ease-out' });
      }
    } else if (fresh) {
      node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS, easing: 'ease-out' });
    }
  }
}

// ---- while you were away: the morning brief, above the board's columns

// The rest of what shipped stays folded shut until asked for, and so do the steps of each thread worth a look.
let briefRest = false;
const briefOpen = new Set();
// Where there is room for one line of what an agent wrote: its first, without a list's mark.
const firstLine = (text) => (String(text).split('\n').find((l) => l.trim()) || '').replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '').trim();
// Whether it said more than that one line.
const moreLines = (text) => !!text && String(text).split('\n').filter((l) => l.trim()).length > 1;
// What an agent wrote, whole, read as a post on its thread is: lists and code shown as what they are.
const richNote = (text) => el('pre', { class: 'note said' }, rich(text));
// A card opens its thread from anywhere on it. Its buttons, links, id, tags and boxes do their own
// thing, and so does a drag or a selection of its words.
function opensOn(node, id) {
  node.addEventListener('click', (e) => {
    if (!id || e.target.closest('button, a, input, select, textarea, label, summary, .key, .tag, [contenteditable]')) return;
    if (String(window.getSelection ? getSelection() : '').trim()) return;
    openThread(id);
  });
  return node;
}
// Folded, the panel is its headline alone, until the set of finished threads in it changes.
const briefSet = (r) => [...r.worthALook, ...r.alsoShipped.flatMap((g) => g.threads)].map((t) => t.id).sort().join(' ');
function briefFolded(r) {
  try { return localStorage.getItem('spool-brief-folded') === briefSet(r); } catch (e) { return false; }
}
function foldBrief(r, fold) {
  try { if (fold) localStorage.setItem('spool-brief-folded', briefSet(r)); else localStorage.removeItem('spool-brief-folded'); } catch (e) {}
  redraw();
}

// When it stopped: so long ago, or on a day.
function briefWhen(at) {
  const said = ago(at);
  return !said || said === 'now' ? '' : /^\d+[mh]$/.test(said) ? ', ' + said + ' ago' : ', on ' + said;
}

function drawBrief(b) {
  const box = document.getElementById('brief');
  const r = b.brief;
  box.hidden = view !== 'board' || !r;
  if (box.hidden) { box.replaceChildren(); return; }
  const folded = briefFolded(r);
  // Approving everything is what the brief's headline offers: the finished threads, and the calls agents made.
  const approve = async () => {
    const ok = !r.shipped || await post('complete-all', {}, 'All marked as complete');
    if (ok && r.calls.length) await post('approve-calls', {}, 'All approved');
  };
  const head = el('div', { class: 'bline' },
    el('button', { class: 'bhead', 'aria-expanded': String(!folded), title: folded ? 'Show the brief' : 'Fold it to this line',
      onclick: () => foldBrief(r, !folded) }, el('span', { class: 'fold' }, folded ? '▸' : '▾'), el('span', {}, r.headline)),
    !folded && r.approve && (r.shipped > 0 || r.calls.length > 0) && el('button', { class: 'go', onclick: approve }, 'All good: approve everything'));
  if (folded) { box.replaceChildren(head); return; }
  const n = r.needsYou;
  const plural = (k, one) => k + ' ' + one + (k === 1 ? '' : 's');
  // Each card opens its thread from anywhere on it. What an agent wrote is read as it is on a thread:
  // code and bold shown, not typed out. A card has room for the first line of a result; the rest is a click away.
  // A question is not here: it is asked on its thread, and nowhere else, and its card on the board says so.
  const needs = [
    ...n.plans.map((t) => opensOn(el('div', { class: 'card', 'data-id': t.id },
      el('div', { class: 'title' }, '📋 Plan: ' + t.title),
      t.summary && el('div', { class: 'note one', title: t.summary }, inline(firstLine(t.summary))),
      el('div', { class: 'why' }, plural(t.parts, 'part') + (t.parts === 1 ? ' waits' : ' wait') + ' for your go-ahead')), t.id)),
    ...n.proposals.map((m) => opensOn(el('div', { class: 'card', 'data-id': m.id },
      el('div', { class: 'title' }, '🧹 The manager proposes ' + plural(m.count, 'change')),
      m.headline && el('div', { class: 'note one', title: m.headline }, inline(firstLine(m.headline))),
      el('div', { class: 'why' }, 'Open it to say yes or no to each')), m.id)),
    ...n.stopped.map((t) => opensOn(el('div', { class: 'card', 'data-id': t.id },
      el('div', { class: 'title' }, '↺ ' + t.title),
      el('div', { class: 'why' }, t.why + briefWhen(t.when)),
      t.lastSaid && el('div', { class: 'note' }, 'Last said: “', inline(t.lastSaid), '”')), t.id)),
  ];
  const worth = (t) => {
    const more = moreLines(t.summary);
    const open = briefOpen.has(t.id);
    const toggle = () => { if (open) briefOpen.delete(t.id); else briefOpen.add(t.id); redraw(); };
    return opensOn(el('div', { class: 'card', 'data-id': t.id },
      el('div', { class: 'title' }, t.title),
      t.summary && el('div', { class: 'note one', title: t.summary }, inline(firstLine(t.summary))),
      el('div', { class: 'why' }, t.reasons.join(' · '), pictureMark(t.pictures)),
      (t.steps.length > 0 || more) && el('button', { class: 'fold', 'aria-expanded': String(open), onclick: toggle },
        (open ? '▾ ' : '▸ ') + (t.steps.length ? 'To check · ' + t.steps.length : 'All it said')),
      open && more && richNote(t.summary),
      open && t.steps.length > 0 && stepsNode(t.steps)), t.id);
  };
  const rest = r.alsoShipped.reduce((k, g) => k + g.threads.length, 0);
  box.replaceChildren(...[head, el('div', { class: 'bbody' }, ...[
    needs.length > 0 && [el('h2', {}, 'Needs you', el('span', { class: 'count' }, String(needs.length))), el('div', { class: 'brow needs' }, needs)],
    r.worthALook.length > 0 && [el('h2', {}, 'Worth a look', el('span', { class: 'count' }, String(r.worthALook.length))),
      el('div', { class: 'brow worth' }, r.worthALook.map(worth))],
    rest > 0 && el('button', { class: 'history', 'aria-expanded': String(briefRest), onclick: () => { briefRest = !briefRest; redraw(); } },
      (briefRest ? '▾ ' : '▸ ') + (r.worthALook.length ? 'Also shipped' : 'Shipped') + ' · ' + rest),
    rest > 0 && briefRest && r.alsoShipped.map((g) => [
      g.sprint && el('div', { class: 'sprint' }, '🏁 ' + g.sprint.title),
      el('div', { class: 'brow' }, g.threads.map((t) => opensOn(el('div', { class: 'card', 'data-id': t.id },
        el('div', { class: 'title' }, t.title),
        t.summary && el('div', { class: 'note one', title: t.summary }, inline(firstLine(t.summary)))), t.id)))]),
  ].flat(3).filter(Boolean))]);
}

// ---- the backlog: sprints to fill and play, then everything that is in none

function dropInto(node, sprint) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('over'); });
  node.addEventListener('dragleave', () => node.classList.remove('over'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('over');
    const [id] = e.dataTransfer.getData('text/plain').split(' ');
    if (!id) return;
    e.preventDefault();
    post('assign', { id, sprint }, sprint ? 'In the sprint' : 'Back in the backlog');
  });
  return node;
}

function sprintNode(s, b) {
  const rows = everyCard(b).filter((c) => c.sprint === s.id && shows(c));
  const finished = s.status === 'done';
  const group = el('div', { class: 'group' },
    el('div', { class: 'ghead' },
      el('span', { class: 'gname' }, s.name),
      el('span', { class: 'state ' + s.status }, s.status),
      el('span', { class: 'gmeta' }, s.total ? s.done + ' of ' + s.total + ' done' : 'Empty: drag threads here'),
      s.total > 0 && el('span', { class: 'prog' }, el('i', { style: 'width: ' + Math.round((100 * s.done) / s.total) + '%' })),
      el('span', { class: 'push' },
        s.waiting > 0 && el('button', { class: 'go', title: 'Everything in it moves to Build', onclick: () => post('play', { id: s.id }, s.name + ' is running') },
          s.status === 'running' ? '▶ Play ' + s.waiting + ' more' : '▶ Play sprint'),
        !finished && s.status !== 'running' && el('button', { title: 'Remove the sprint. What is in it goes back to the backlog.', onclick: () => post('drop-sprint', { id: s.id }, 'Sprint removed') }, '✕'))),
    aboutNode(s),
    rows.map((c) => rowNode(c, b)));
  return finished ? group : dropInto(group, s.id);
}

// What a sprint is for: its goal, the reason, and when it is done. Click it to write or change it.
let editingSprint = '';
function aboutNode(s) {
  if (editingSprint === s.id) {
    const field = (key, placeholder) => { const box = el('input', { placeholder, 'data-about': key }); box.value = s[key] || ''; return box; };
    const form = el('div', { class: 'aboutform' },
      field('goal', 'Goal: what this sprint is for'), field('why', 'Why: why now'), field('doneWhen', 'Done when: what will be true'));
    const read = () => Object.fromEntries([...form.querySelectorAll('input')].map((box) => [box.dataset.about, box.value]));
    form.append(el('div', { class: 'acts' },
      el('button', { class: 'go', onclick: () => { const about = read(); editingSprint = ''; post('sprint-about', { id: s.id, ...about }, 'Saved'); } }, 'Save'),
      el('button', { onclick: () => { editingSprint = ''; redraw(); } }, 'Cancel')));
    return form;
  }
  const open = () => { editingSprint = s.id; redraw(); };
  if (!s.goal && !s.why && !s.doneWhen) return s.status === 'done' ? null : el('div', { class: 'about', onclick: open }, '+ Say what this sprint is for');
  return el('div', { class: 'about', title: 'Click to change', onclick: s.status === 'done' ? null : open },
    s.goal && el('div', {}, el('b', {}, 'Goal '), s.goal),
    s.why && el('div', {}, el('b', {}, 'Why '), s.why),
    s.doneWhen && el('div', {}, el('b', {}, 'Done when '), s.doneWhen));
}

function drawBacklog(b) {
  const open = b.sprints.filter((s) => s.status !== 'done');
  const finished = b.sprints.filter((s) => s.status === 'done');
  const loose = b.columns.proposed.filter((c) => !c.sprint && shows(c));
  const newSprint = adding === 'sprint'
    ? el('div', { class: 'adding', style: 'max-width: 360px; margin-bottom: 14px' },
        (() => {
          const box = el('input', { placeholder: 'Name the sprint',
            oninput: (e) => { addDraft = e.target.value; },
            onkeydown: (e) => {
              if (e.key === 'Enter' && addDraft.trim()) { const name = addDraft.trim(); adding = null; addDraft = ''; post('sprint', { name }, 'Sprint made'); }
              if (e.key === 'Escape') { e.stopPropagation(); adding = null; addDraft = ''; redraw(); }
            } });
          box.value = addDraft;
          return box;
        })(),
        el('div', { class: 'acts' },
          el('button', { class: 'go', onclick: () => { const name = addDraft.trim(); if (!name) return; adding = null; addDraft = ''; post('sprint', { name }, 'Sprint made'); } }, 'Create'),
          el('button', { onclick: () => { adding = null; addDraft = ''; redraw(); } }, 'Cancel')))
    : el('button', { style: 'margin-bottom: 14px', onclick: () => { adding = 'sprint'; addDraft = 'Sprint ' + (b.sprints.length + 1); redraw(); } }, '+ Create sprint');
  document.getElementById('backlog').replaceChildren(
    ...[waitingNode(b)].filter(Boolean),
    ...open.map((s) => sprintNode(s, b)),
    newSprint,
    dropInto(el('div', { class: 'group' },
      el('div', { class: 'ghead' }, el('span', { class: 'gname' }, 'Backlog'), el('span', { class: 'gmeta' }, loose.length + (loose.length === 1 ? ' thread' : ' threads') + ' in no sprint')),
      loose.length ? loose.map((c) => rowNode(c, b)) : el('div', { class: 'empty' }, 'Everything is in a sprint, or built.'),
      addNode('proposed', 'What do you want added?'),
      loose.length > 0 && el('div', { style: 'margin-top: 8px; max-width: 320px' }, addAllNode('backlog', loose))), ''),
    ...finished.map((s) => sprintNode(s, b)),
    archivedNode(b));
}

// The foot of the backlog: what was archived, folded shut, each with its way back.
function archivedNode(b) {
  if (!b.archived.length) return '';
  const rows = b.archived.filter(shows);
  const row = (c) => el('div', { class: 'row', 'data-id': c.id },
    el('div', {}, el('span', { title: c.title }, c.title), c.why && el('div', { class: 'why', title: c.why }, inline(c.why))),
    el('div', { class: 'right' }, el('span', {}, 'Archived ', stamp(c.archived, true)), el('span', { class: 'key', title: 'Copy the id', onclick: () => copyId(c.id) }, c.id),
      el('button', { class: 'act', title: 'Back to the backlog, just as it was', onclick: () => post('unarchive', { id: c.id }, 'Back in the backlog: ' + c.title) }, '↩ Bring back')));
  return el('div', { class: 'group', id: 'archived' },
    el('button', { class: 'history', 'aria-expanded': String(showArchived), onclick: () => { showArchived = !showArchived; redraw(); } },
      (showArchived ? '▾ Archived' : '▸ Archived') + ' · ' + b.archived.length),
    showArchived && (rows.length ? rows.map(row) : el('div', { class: 'empty' }, 'Nothing archived matches.')));
}

// ---- what waits on him: on the thread it is about, or at the top of the backlog when it is about none.
// A question is the one thing that is only ever on its thread.

// The calls agents made for a thread and the skills it taught, that he has not looked at yet.
const callsFor = (b, id) => b.needs.calls.filter((x) => x.threads.includes(id));
const skillsFor = (b, id) => b.needs.skills.filter((x) => x.threads.includes(id));
const planWaits = (b, id) => b.needs.plans.some((x) => x.id === id);
// A call or a skill about no thread on the board has nowhere else to be shown, so the backlog's strip carries it.
function homeless(b, list) {
  const ids = new Set(everyCard(b).map((c) => c.id));
  return list.filter((x) => !x.threads.some((id) => ids.has(id)));
}

// A box to say something else in, and the button that sends it.
function sayNode(placeholder, label, send) {
  const box = el('input', { placeholder, onkeydown: (e) => { if (e.key === 'Enter' && box.value.trim()) send(box.value.trim()); } });
  return el('span', { class: 'say' }, box, el('button', { onclick: () => { if (box.value.trim()) send(box.value.trim()); } }, label));
}
// A question's options: side by side where they fit, and where they do not, one to a line, each as
// wide as the line, so a short one is never a small button beside a wide block.
function optionsNode(q) {
  return el('div', { class: 'opts' }, q.options.map((o, i) => el('button', { class: q.recommend === i + 1 ? 'rec' : '', title: q.recommend === i + 1 ? 'Recommended' : '',
    onclick: () => post('answer', { id: q.id, choice: String(i + 1) }, 'Answered: ' + o) }, o)));
}
// A question is answered with one of its options, or in his own words.
function answersNode(q) {
  return el('div', { class: 'acts wrap' }, optionsNode(q),
    sayNode('Or say what you want', 'Answer', (words) => post('answer', { id: q.id, choice: words }, 'Answered')));
}
// What a manager's run proposes: each numbered, with a yes and a no. A yes runs its verb, with the run's reason.
function proposalsNode(c) {
  if (!c.proposals || !c.proposals.length) return null;
  const left = c.proposals.filter((x) => !x.answer).length;
  const say = (x, said) => post('proposal', { id: c.id, n: x.n, said }, said === 'yes' ? 'Yes: ' + x.text : 'No: left alone');
  return el('div', { class: 'proposals' },
    el('h3', {}, 'Proposals ', el('span', { class: 'count' }, left ? left + ' to answer' : 'all answered')),
    c.proposals.map((x) => el('div', { class: 'proposal', 'data-n': String(x.n) },
      el('div', { class: 'ptext' }, el('span', { class: 'pn' }, x.n + '. '), inline(x.text)),
      x.answer
        ? el('div', { class: 'said ' + x.answer }, x.answer === 'yes' ? '✓ Yes, done' : 'No, left alone')
        : el('div', { class: 'acts' }, el('button', { class: 'go', onclick: () => say(x, 'yes') }, 'Yes'), el('button', { onclick: () => say(x, 'no') }, 'No')))));
}
// A call an agent made is fine by him, or he overrules it in his own words.
function callActs(call) {
  return el('div', { class: 'acts wrap' },
    el('button', { onclick: () => post('approve', { id: call.id }, 'Accepted') }, 'Fine'),
    sayNode('No: say what you want instead', 'Overrule', (words) => post('answer', { id: call.id, choice: words }, 'Overruled')));
}
function skillActs(skill) {
  return el('div', { class: 'acts wrap' },
    el('button', { onclick: () => post('approve', { id: skill.id }, 'Kept') }, 'Keep'),
    el('button', { onclick: () => post('drop-skill', { id: skill.id }, 'Dropped') }, 'Drop'));
}

// A call an agent made, as a post in its thread: what it chose, the question and the why under it.
// Until he has looked at it, Fine and Overrule are right there.
function decidedNode(who, at, ref, text, b, t) {
  const call = b.needs.calls.find((x) => x.id === ref);
  const d = t.questions.find((x) => x.id === ref);
  // The log line is "question → choice". Accepted, the decision still says the same choice; overruled, it says his.
  const cut = text.lastIndexOf(' → ');
  const chose = call ? call.choice : d && text.endsWith(' → ' + d.choice) ? d.choice : cut > 0 ? text.slice(cut + 3) : '';
  const question = call ? call.title : d ? d.title : cut > 0 ? text.slice(0, cut) : text;
  const why = call ? call.why : d ? d.why : '';
  return el('div', { class: 'post', 'data-call': ref }, avatar(who),
    el('div', {}, byline(who, at),
      el('pre', {}, 'Decided: ' + chose),
      el('div', { class: 'note' }, question),
      why && el('div', { class: 'note' }, 'Why: ' + why),
      call ? callActs(call)
        : d && d.status === 'decided' && d.choice !== chose ? el('span', { class: 'badge ask' }, 'You overruled it: ' + d.choice)
        : d && d.status === 'decided' && el('span', { class: 'badge' }, '✓ Fine by you')));
}
// A skill an agent wrote while working on the thread, to keep or drop.
function skillPost(skill) {
  return el('div', { class: 'post' }, avatar(skill.by || 'agent'),
    el('div', {}, byline(skill.by || 'agent', ''),
      el('span', { class: 'badge' }, '📘 Wrote a new skill'),
      el('pre', {}, skill.name),
      skill.about && el('div', { class: 'note' }, skill.about),
      skillActs(skill)));
}

// The strip at the top of the backlog: notes nobody filed, and the calls and skills about no thread.
// A question is never in it: a question is asked on the thread it stops, and nowhere else on the page.
// It is not there when there is nothing in it.
function waitingNode(b) {
  const n = b.needs;
  const items = [
    ...homeless(b, n.calls).map((call) => el('div', { class: 'need' },
      el('div', { class: 'what' }, 'Decided: ' + call.choice),
      el('div', { class: 'more' }, call.title),
      call.why && el('div', { class: 'more' }, 'Why: ' + call.why),
      callActs(call))),
    ...homeless(b, n.skills).map((skill) => el('div', { class: 'need' },
      el('div', { class: 'what' }, '📘 New skill: ' + skill.name),
      skill.about && el('div', { class: 'more' }, skill.about),
      skillActs(skill))),
    ...n.notes.map((note) => el('div', { class: 'need' },
      el('pre', {}, note.text),
      el('div', { class: 'acts wrap' },
        el('button', { class: 'go', onclick: () => post('note-thread', { id: note.id, title: note.text }, 'It is a thread in the backlog') }, 'Make it a thread'),
        el('button', { onclick: () => post('note-aside', { id: note.id }, 'Set aside') }, 'Set aside')))),
  ];
  // Many calls are accepted in one go, wherever they are.
  const all = n.calls.length > 1 && el('button', { onclick: () => post('approve-calls', {}, 'All accepted') }, 'All ' + n.calls.length + ' calls fine');
  if (!items.length && !all) return null;
  return el('div', { class: 'group waiting' },
    el('div', { class: 'ghead' }, el('span', { class: 'gname' }, 'Waiting on you'),
      el('span', { class: 'gmeta' }, items.length ? 'Not on any thread yet' : 'Agents made ' + n.calls.length + ' calls on their threads'),
      all && el('span', { class: 'push' }, all)),
    items);
}

// ---- the ticket

const whoIs = (who) => (who === 'human' ? 'You' : who === 'agent' ? 'An agent' : who === 'loop' ? 'The loop' : who || 'Someone');
// An agent that signed with its model's name is shown as who it is: "Claude" and the model beside it.
const speaker = (who) => {
  if (who === 'human') return { name: 'You', model: '', kind: 'you' };
  const claude = /^claude\b[\s-]*(.*)$/i.exec(who || '');
  if (claude) return { name: 'Claude', model: claude[1].trim(), kind: 'claude' };
  if (who === 'agent' || !who) return { name: 'Agent', model: '', kind: 'agent' };
  if (who === 'loop') return { name: 'The loop', model: '', kind: 'agent' };
  if (who === 'page') return { name: 'The page', model: '', kind: 'agent' };
  return { name: who, model: '', kind: 'agent' };
};
// Claude's own mark, from docs/claude_logo.svg. It is Anthropic's trademark, shown only to say which agent did the work.
const CLAUDE = '<svg viewBox="0 0 24 24" fill="#D97757" role="img" aria-label="Claude"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>';
// The human's identicon for this project, from the board: each spool draws its own.
let YOU = '';
function avatar(who) {
  const s = speaker(who);
  const node = el('div', { class: 'avatar ' + s.kind, title: s.model ? s.name + ' ' + s.model : s.name });
  if (s.kind === 'claude') node.innerHTML = CLAUDE;
  else if (s.kind === 'you' && YOU) node.innerHTML = YOU;
  else node.textContent = s.kind === 'you' ? 'You'.slice(0, 1) : '🤖';
  return node;
}
function byline(who, at) {
  const s = speaker(who);
  return el('div', { class: 'byline' }, el('b', {}, s.name), s.model && el('span', { class: 'model' }, s.model), at && [el('span', { class: 'sep' }, '·'), stamp(at)]);
}
// When something happened, the way a person says it: "now", "4m", "3h", then the day. The exact time is on hover,
// and the clock on the page keeps it current. Everywhere a time is shown, it is shown this way. Standing on its
// own, outside the thread, it reads "just now", "4m ago", "3h ago".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const timeOf = (at) => Date.parse(String(at).replace(' ', 'T'));
function ago(at, alone) {
  const then = timeOf(at);
  if (isNaN(then)) return '';
  const s = (Date.now() - then) / 1000;
  if (s < 60) return alone ? 'just now' : 'now';
  if (s < 3600) return Math.floor(s / 60) + (alone ? 'm ago' : 'm');
  if (s < 86400) return Math.floor(s / 3600) + (alone ? 'h ago' : 'h');
  const d = new Date(then);
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === new Date().getFullYear() ? '' : ', ' + d.getFullYear());
}
const stamp = (at, alone) => (isNaN(timeOf(at)) ? null
  : el('time', { class: 'at', 'data-at': at, 'data-alone': alone ? 'true' : null, datetime: new Date(timeOf(at)).toISOString(), title: new Date(timeOf(at)).toLocaleString() }, ago(at, alone)));
// What agents write, shown as what it is: a small, safe part of Markdown. Code in backticks, fenced
// blocks of code, bold, lists, and links to the web. Everything is built as nodes from the text;
// nothing an agent wrote is ever read as HTML, and whatever is not recognised stays as it was written.
// Words in backticks are code: shown as code, whole on hover. A path from the root of the machine
// (an agent's command, a file outside the project) is shown by its last part, however short; in a
// long piece of code, every path is.
const codeNode = (part) => el('code', { title: part }, part.length > 40 ? part.replace(/\S*\/(\S+)/g, '$1') : part.replace(/(^|\s)~?\/\S*\/(\S+)/g, '$1$2'));
// A link goes only to the web, in a tab of its own; any other kind stays the words it was.
const webLink = (href, words) => (/^https?:\/\/\S+$/i.test(href) ? el('a', { class: 'out', href, target: '_blank', rel: 'noopener noreferrer' }, words) : null);
const INLINE = /\x60([^\x60\n]+)\x60|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^()\s]+)\)|(https?:\/\/[^\s<>()\[\]\x60]*[^\s<>()\[\]\x60.,;:!?'"])/g;
function inline(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) out.push(codeNode(m[1]));
    else if (m[2] != null) out.push(el('strong', {}, inline(m[2])));
    else if (m[3] != null) out.push(webLink(m[4], inline(m[3])) || m[0]);
    else out.push(webLink(m[5], m[5]) || m[0]);
  }
  out.push(text.slice(at));
  return out.filter((x) => x !== '');
}
const ITEM = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const FENCE = /^\s*\x60\x60\x60/;
function rich(text) {
  const lines = String(text).split('\n');
  const out = [];
  let words = [];
  const flush = () => { if (words.length) out.push(...inline(words.join('\n'))); words = []; };
  let i = 0;
  while (i < lines.length) {
    // A fence opened and never closed is not code: it is left as written.
    const close = FENCE.test(lines[i]) ? lines.slice(i + 1).findIndex((l) => /^\s*\x60\x60\x60\s*$/.test(l)) : -1;
    const first = ITEM.exec(lines[i]);
    if (close >= 0) {
      flush();
      out.push(el('pre', { class: 'code' }, lines.slice(i + 1, i + 1 + close).join('\n')));
      i += close + 2;
    } else if (first) {
      flush();
      // One list runs while its lines are items of the same kind: bullets, or numbers.
      const ordered = !first[1];
      const items = [];
      for (let m = first; m && !m[1] === ordered; m = ITEM.exec(lines[++i] || '')) items.push(el('li', {}, inline(m[3])));
      out.push(el(ordered ? 'ol' : 'ul', { start: ordered && first[2] !== '1' ? first[2] : null }, items));
    } else {
      words.push(lines[i]);
      i++;
    }
  }
  flush();
  return out;
}
// How to see a finished thread working, step by step as its agent wrote them: a numbered list, read as a post is.
const stepsNode = (steps) => el('pre', {}, el('ol', {}, steps.map((s) => el('li', {}, inline(s)))));
// A long run of bookkeeping between two posts is folded to its first and last line, a click from the rest.
const unfolded = new Set();
function folded(id, feed) {
  if (unfolded.has(id)) return feed;
  const out = [];
  for (let i = 0; i < feed.length;) {
    let j = i;
    while (j < feed.length && feed[j].kind === 'event') j++;
    if (j - i > 4) out.push(feed[i], { kind: 'fold', text: (j - i - 2) + ' more' }, feed[j - 1]);
    else out.push(...feed.slice(i, j));
    if (j < feed.length) out.push(feed[j]);
    i = j + 1;
  }
  return out;
}
// While an agent works, it is the newest post in the thread: who, for how long, what it is doing now,
// and its log as it comes. A chat building it has no log here, only the note it last left.
function livePost(c, b) {
  if (c.column !== 'building' || !c.live) return null;
  const run = liveOf(c, b);
  const who = c.thread.by || 'agent';
  const s = speaker(who);
  const face = avatar(who);
  face.append(el('span', { class: 'pulse' }));
  const session = c.run && c.run.session;
  return el('div', { class: 'post livepost' }, face,
    el('div', {},
      el('div', { class: 'byline' }, el('b', {}, s.name), ranNode(c, 'model') || (s.model && el('span', { class: 'model' }, s.model)), el('span', { class: 'sep' }, '·'),
        el('span', { class: 'at' }, 'working for ', el('span', { 'data-since': c.live.since }, took(c.live.since))),
        c.worktree && el('span', { class: 'at', title: 'Its own git worktree: a checkout apart from yours, that lands on yours when it is done' }, ' · in ' + c.worktree),
        run && run.listens && el('span', { class: 'at', title: 'What you reply on this thread reaches the agent while it works: it reads it at its next step.' }, ' · hears your replies'),
        run && stopNode(c, 'act stop', '■ Stop the agent')),
      el('div', { class: 'livenow' }, el('span', { class: 'nowtext' }, (run && run.lines.at(-1)) || c.live.note || 'starting…'), el('span', { class: 'caret' })),
      run && run.asking && permitNode(c, run.asking, true),
      session && el('div', { class: 'session' }, 'Session ', el('code', { title: session }, session.slice(0, 8)), copyNode('claude --resume ' + session, 'Copy the command that opens it')),
      run && el('div', { class: 'livelog', 'data-keep': 'livelog', 'data-follow': 'true' }, run.lines.join('\n') || 'starting…')));
}

// The open thread is in the address, so a ticket can be linked to and survives a reload.
function openThread(id) { openId = id; history.replaceState(null, '', '#' + id); redraw(); }
function closeThread() { openId = null; history.replaceState(null, '', location.pathname + location.search); redraw(); }

// What a thread changed, fetched when asked for and kept: the files, the lines, and the patch itself.
const diffs = new Map();
const showing = new Set();
let undoing = '';
async function showChanges(id) {
  if (showing.has(id)) { showing.delete(id); redraw(); return; }
  showing.add(id);
  if (!diffs.has(id)) {
    try { diffs.set(id, await (await fetch('/api/diff?id=' + id)).json()); } catch (e) { say('The changes could not be read.'); }
  }
  redraw();
}
// The patch the server sends is one text; the files in it are told apart here, the way a pull request lists them.
// Each file keeps its header facts (new, deleted, renamed, binary) and its hunks as rows with both line numbers.
function parsePatch(patch) {
  const files = [];
  const byPath = new Map();
  let f = null, h = null, old = 0, now = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(text);
      const path = m ? m[2] : text.slice(11);
      f = byPath.get(path);
      // One file touched by several commits is one row, its hunks in the order they happened.
      if (!f) { f = { path, from: m ? m[1] : path, state: '', binary: false, hunks: [] }; byPath.set(path, f); files.push(f); }
      else if (f.state === 'deleted') f.state = '';
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (text.startsWith('new file mode')) f.state = f.state || 'new';
      else if (text.startsWith('deleted file mode')) f.state = 'deleted';
      else if (text.startsWith('rename from ')) { f.state = 'renamed'; f.from = text.slice(12); }
      else if (text.startsWith('Binary files') || text.startsWith('GIT binary patch')) f.binary = true;
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(text);
    if (at) { h = { title: text, rows: [] }; f.hunks.push(h); old = +at[1]; now = +at[2]; continue; }
    if (!h || !text) continue;
    const mark = text[0];
    if (mark === '+') h.rows.push({ kind: 'plus', old: '', now: now++, text: text.slice(1) });
    else if (mark === '-') h.rows.push({ kind: 'minus', old: old++, now: '', text: text.slice(1) });
    else if (mark === ' ') h.rows.push({ kind: '', old: old++, now: now++, text: text.slice(1) });
    else h.rows.push({ kind: 'none', old: '', now: '', text });
  }
  for (const g of files) {
    g.added = g.hunks.reduce((n, x) => n + x.rows.filter((r) => r.kind === 'plus').length, 0);
    g.removed = g.hunks.reduce((n, x) => n + x.rows.filter((r) => r.kind === 'minus').length, 0);
  }
  return files;
}

// Which files of a ticket are folded open, and how far each is scrolled sideways: kept across redraws.
const opened = new Map();
const sideways = new Map();
function changeBar(added, removed) {
  const total = added + removed;
  let green = total ? Math.round(5 * added / total) : 0;
  let red = total ? 5 - green : 0;
  if (added && !green) { green = 1; red = 4; }
  if (removed && !red) { red = 1; green = 4; }
  return el('span', { class: 'stat', 'aria-hidden': 'true' },
    [0, 1, 2, 3, 4].map((i) => el('i', { class: i < green ? 'plus' : i < green + red ? 'minus' : '' })));
}
function fileDiff(key, g, cutNote) {
  const table = el('table', { class: 'lines' }, g.hunks.map((h) => el('tbody', {},
    el('tr', { class: 'at' }, el('td', { colspan: 4 }, h.title)),
    h.rows.map((r) => el('tr', { class: r.kind },
      el('td', { class: 'num' }, r.old === '' ? '' : String(r.old)),
      el('td', { class: 'num' }, r.now === '' ? '' : String(r.now)),
      el('td', { class: 'sign' }, r.kind === 'plus' ? '+' : r.kind === 'minus' ? '−' : ''),
      el('td', { class: 'code' }, r.text))))));
  const box = el('div', { class: 'scroll', 'data-keep': 'diff:' + key }, table);
  box.addEventListener('scroll', () => sideways.set(key, box.scrollLeft));
  // A box has no width until it is on the page, so its sideways place is put back once it is.
  const was = sideways.get(key);
  if (was) setTimeout(() => { box.scrollLeft = was; }, 0);
  return el('div', { class: 'filebody' },
    g.binary && !g.hunks.length ? el('div', { class: 'note' }, 'A binary file: there are no lines to show.') : g.hunks.length ? box : el('div', { class: 'note' }, g.state === 'renamed' ? 'Renamed, with no lines changed.' : 'No lines to show.'),
    cutNote);
}
function changesNode(c) {
  if (!c.done || !c.thread.commits.length) return null;
  const d = showing.has(c.id) && diffs.get(c.id);
  const head = el('button', { onclick: () => showChanges(c.id) }, d ? 'Hide the changes' : 'Show what changed');
  if (!d) return el('div', { class: 'changes' }, head);
  if (!d.files.length) return el('div', { class: 'changes' }, head, el('div', { class: 'note' }, 'No changes on record for it in this repository.'));
  const parsed = parsePatch(d.patch || '');
  const counted = new Map(d.files.map((f) => [f.path, f]));
  // The rows: every file in the patch, then any the cut patch never reached.
  const rows = parsed.map((g) => {
    const n = counted.get(g.path);
    return { ...g, added: n ? n.added : g.added, removed: n ? n.removed : g.removed };
  });
  for (const f of d.files) if (!parsed.some((g) => g.path === f.path) && !f.path.includes(' => ')) rows.push({ path: f.path, state: '', binary: false, hunks: [], added: f.added, removed: f.removed, unseen: true });
  const added = d.files.reduce((n, f) => n + f.added, 0);
  const removed = d.files.reduce((n, f) => n + f.removed, 0);
  const small = added + removed < 40;
  const shas = d.commits.map((x) => x.sha).join(' ');
  const cutNote = el('div', { class: 'note cutnote' }, 'The rest of this change is not shown here. To see it: ', el('code', {}, 'git show ' + shas));
  return el('div', { class: 'changes' }, head,
    el('div', { class: 'sum' },
      el('b', {}, d.files.length + (d.files.length === 1 ? ' file' : ' files') + ' changed'), ' ',
      el('span', { class: 'plus' }, '+' + added), ' ', el('span', { class: 'minus' }, '−' + removed)),
    el('div', { class: 'commits' }, d.commits.map((x) => el('div', {}, el('span', { class: 'mono' }, x.sha), ' ' + x.subject))),
    rows.map((g, i) => {
      const key = c.id + '\0' + g.path;
      const open = opened.has(key) ? opened.get(key) : small || i === 0;
      const slash = g.path.lastIndexOf('/');
      const last = i === rows.length - 1;
      const word = g.binary ? 'binary' : g.state === 'new' ? 'new' : g.state === 'deleted' ? 'deleted' : g.state === 'renamed' ? 'renamed from ' + g.from : '';
      const cut = d.cut && last;
      return el('div', { class: 'file' + (open ? ' open' : '') },
        el('div', { class: 'filehead', role: 'button', tabindex: '0', 'aria-expanded': String(open),
          onclick: () => { opened.set(key, !open); redraw(); },
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opened.set(key, !open); redraw(); } } },
          el('span', { class: 'twist' }, open ? '▾' : '▸'),
          el('span', { class: 'path mono' }, slash >= 0 && el('span', { class: 'dir' }, g.path.slice(0, slash + 1)), g.path.slice(slash + 1)),
          word && el('span', { class: 'word' }, word),
          el('span', { class: 'plus' }, '+' + g.added), el('span', { class: 'minus' }, '−' + g.removed),
          changeBar(g.added, g.removed)),
        open && (g.unseen ? cutNote : fileDiff(key, g, cut && cutNote)));
    }));
}
// Undo is the other answer to finished work: take back exactly what this thread changed, and say why.
function undoNode(c) {
  if (!c.done) return null;
  if (undoing !== c.id) return el('button', { style: 'margin-top: 10px', onclick: () => { undoing = c.id; redraw(); } }, '↩ Undo this thread');
  const why = el('input', { placeholder: 'What was wrong with it? In your words' });
  const go = (how) => { undoing = ''; post('undo', { id: c.id, why: why.value, drop: how === 'drop', now: how === 'now' }, how === 'drop' ? 'Undone and dropped' : how === 'now' ? 'Undone. It is back in Build, with your words on it.' : 'Undone. It waits in the backlog, with your words on it.'); };
  return el('div', { class: 'undo' }, why,
    el('div', { class: 'acts' },
      el('button', { class: 'go', onclick: () => go('wait') }, 'Undo, and keep it in the backlog'),
      el('button', { onclick: () => go('now') }, 'Undo, to be done again now'),
      el('button', { onclick: () => go('drop') }, 'Undo, and drop it'),
      el('button', { onclick: () => { undoing = ''; redraw(); } }, 'Cancel')));
}

// What a thread is, told plainly and in parts: the kind of work, what changes, how it helps the project,
// when it is done, and why an agent thought of it. A spec with no parts falls back to the human's words.
const KINDS = {
  change: ['🛠', 'A change', 'built, checked, and shipped in small commits'],
  audit: ['🔍', 'An audit', 'a look and a report; each finding is filed as its own thread'],
  plan: ['🗺', 'A plan', 'worked out and split into parts; nothing is built here'],
};
const ABOUT_ICON = { what: '🧵', why: '🌱', done: '🏁', other: '📝' };
function describeNode(c, b) {
  const t = c.thread;
  const parts = t.about.slice();
  if (!parts.some((p) => p.key === 'what') && t.said.length) parts.unshift({ key: 'what', label: 'What was asked for', text: t.said[0].text });
  const kind = KINDS[c.type] || KINDS.change;
  const sized = c.difficulty ? ' · ' + c.difficulty.toLowerCase() + ' job' : '';
  const part = (icon, label, text, key) => el('div', { class: 'part ' + key },
    el('div', { class: 'icon' }, icon),
    el('div', {}, el('div', { class: 'label' }, label), el('pre', {}, rich(text))));
  return el('details', { class: 'desc', open: true, 'data-keep': 'about' },
    el('summary', {}, '🧶 About this thread'),
    el('div', { class: 'kind' }, kind[0] + ' ' + kind[1] + sized, el('span', {}, ' — ' + kind[2])),
    // How it helps is said of the project it is in, by its own name.
    parts.map((p) => part(ABOUT_ICON[p.key], p.key === 'why' && b.project ? p.label + ' ' + b.project : p.label, p.text, p.key)),
    c.suggested && part('✨', 'Why an agent suggested it', c.suggested, 'idea'));
}

// At the top of a ticket, when the thread cannot move on by itself: what it waits on, and what would move it.
function waitNode(c, b) {
  const w = c.waiting;
  if (!w) return null;
  const link = (t) => el('a', { href: '#' + t.id, onclick: (e) => { e.preventDefault(); openThread(t.id); } }, el('span', { class: 'key' }, t.id), ' ' + t.title);
  const said = w.kind === 'stuck' && lastWords(c, b);
  const parts = {
    you: ['Needs you', [
      el('div', { class: 'what' }, w.text),
      c.question && optionsNode(c.question),
      w.on.map(link)]],
    thread: ['Waiting on ' + (w.on.length === 1 ? 'another thread' : w.on.length + ' other threads'), [
      w.on.map(link),
      el('div', { class: 'soft' }, 'It starts by itself once ' + (w.on.length === 1 ? 'that one is' : 'those are') + ' done.')]],
    hold: ['On hold', [
      el('div', { class: 'what' }, w.text),
      el('button', { onclick: () => post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title) }, '▶ Build it now')]],
    stuck: ['The agent stopped without finishing', [
      el('div', { class: 'what' }, 'It ' + w.text + '.' + (said ? ' It last said: “' + said + '”' : '')),
      w.refused.length > 0 && el('div', { class: 'soft' }, 'It was refused: ', w.refused.map((r, i) => [i ? ', ' : '', el('span', { class: 'mono' }, r)])),
      el('div', { class: 'soft' }, 'It waits in Build. Reply below to tell the next agent what to do differently.')]],
  }[w.kind];
  return el('div', { class: 'notice ' + w.kind, role: 'status' }, el('div', { class: 'head' }, parts[0]), parts[1]);
}

// At the top of the ticket of a thread the human stopped: that they did, and the way on.
function stoppedNode(c, b) {
  if (!stoppedOf(c, b)) return null;
  return el('div', { class: 'notice', role: 'status' }, el('div', { class: 'head' }, 'Stopped'),
    el('div', { class: 'what' }, 'You stopped the agent that was building this. Nothing builds it until you carry on.'), carryOnNode(c, 'go'));
}

// A ticket, the way a board has always shown one: the story on the left, its fields on the right.
function threadNode(c, b) {
  const t = c.thread;
  const save = (fields, done) => post('edit', { id: c.id, ...fields }, done);
  // Pictures pasted into the box go with the reply, to the thread it landed on; with no words, they go alone.
  const reply = async () => {
    if (!box.value.trim()) return pendingOf(c.id).length > 0 && sendPictures(c.id, c.id);
    const landed = await post('note', { id: c.id, text: box.value }, 'Posted to the thread');
    if (landed) { drafts.delete(c.id); await sendPictures(landed === true ? c.id : landed, c.id); }
  };
  const ready = () => { send.disabled = !box.value.trim() && !pendingOf(c.id).length; };
  // Enter sends, as in any chat; Shift+Enter is a new line. A word still being composed (an IME) is left to finish.
  const box = el('textarea', { placeholder: 'Post your reply', rows: 2,
    oninput: (e) => { drafts.set(c.id, e.target.value); ready(); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); reply(); } } });
  box.value = drafts.get(c.id) || '';
  const send = el('button', { class: 'go', onclick: reply, disabled: !box.value.trim() && !pendingOf(c.id).length }, 'Reply');
  takePictures(box, c.id);
  const lineage = [
    ...t.cameFrom.map((f) => 'Came out of: ' + f.title),
    ...t.parts.map((p) => 'Part: ' + p.title + ' (' + p.state + ')'),
    // A call an agent made is already a post in the conversation.
    ...t.questions.filter((q) => !t.feed.some((p) => p.ref === q.id)).map((q) => 'Asked: ' + q.title + (q.choice ? ' → ' + q.choice : ' → not answered yet')),
  ];
  // A thread can be finished more than once: the steps are for how it stands now, so they go under the last result.
  const shipped = t.feed.findLast((p) => p.kind === 'shipped');

  const title = el('h2', { contenteditable: 'plaintext-only', spellcheck: 'false', title: 'Click to rename',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = c.title; e.target.blur(); e.stopPropagation(); } },
    onblur: (e) => { const now = e.target.textContent.trim(); if (now && now !== c.title) save({ title: now }, 'Renamed'); else e.target.textContent = c.title; } }, c.title);

  const story = el('div', {},
    el('div', { class: 'key' }, c.n != null && '#' + c.n + ' · ', el('span', { class: 'copyid', title: 'Copy the id', onclick: () => copyId(c.id) }, c.id), copyLinkNode(c.id)),
    title,
    waitNode(c, b),
    stoppedNode(c, b),
    proposalsNode(c),
    describeNode(c, b),

    // The thread itself: a conversation, oldest first. You said, Claude answered, and the moves in between.
    el('div', { class: 'feed' },
      folded(c.id, t.feed).map((p) => {
        if (p.kind === 'fold') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }),
            el('button', { class: 'fold', onclick: () => { unfolded.add(c.id); redraw(); } }, p.text));
        }
        if (p.kind === 'event') {
          return el('div', { class: 'event' }, el('div', { class: 'dot' }), el('div', {}, speaker(p.who).name + ' ', rich(p.text), p.at && [el('span', { class: 'sep' }, '·'), stamp(p.at)]));
        }
        if (p.kind === 'decided') return decidedNode(p.who, p.at, p.ref, p.text, b, t);
        const asking = p.kind === 'asked' && c.question && c.question.title === p.text;
        return el('div', { class: 'post' }, avatar(p.who),
          el('div', {}, byline(p.who, p.at),
            p.kind === 'shipped' && el('span', { class: 'badge' }, '✓ Shipped'),
            p.kind === 'asked' && el('span', { class: 'badge ask' }, '❓ Needs a call from you'),
            (p.text || !p.pictures) && el('pre', {}, rich(p.text)),
            picturesNode(c, p),
            p === shipped && proofNode(c),
            p === shipped && c.steps.length > 0 && [el('div', { class: 'note' }, 'To check'), stepsNode(c.steps)],
            p === shipped && t.checked && el('div', { class: 'badge', style: 'display: block' }, '✓ Check passed: ' + t.checked),
            p === shipped && t.commits.length > 0 && el('div', { class: 'mono', style: 'margin-top: 6px; color: var(--soft)' }, (t.commits.length === 1 ? 'commit ' : 'commits ') + t.commits.join(' · ')),
            asking && answersNode(c.question)));
      }),
      // A question with no line of its own in the log still has to be answerable here.
      c.question && !t.feed.some((p) => p.kind === 'asked' && p.text === c.question.title) && el('div', { class: 'post' }, avatar(t.by || 'agent'),
        el('div', {}, byline(t.by || 'agent', ''), el('span', { class: 'badge ask' }, '❓ Needs a call from you'), el('pre', {}, c.question.title),
          answersNode(c.question))),
      // So does a call made for it with no line of its own, and a skill it taught.
      callsFor(b, c.id).filter((x) => !t.feed.some((p) => p.ref === x.id)).map((x) => decidedNode(x.by || 'agent', '', x.id, x.title + ' → ' + x.choice, b, t)),
      skillsFor(b, c.id).map(skillPost),
      livePost(c, b),
      !t.feed.length && !c.question && !c.live && el('div', { class: 'empty' }, 'Nothing has been said here yet.')),

    t.report && el('details', { class: 'desc', open: true, 'data-keep': 'report' }, el('summary', {}, c.type === 'plan' ? 'The plan' : 'The report'), el('pre', {}, rich(t.report))),

    lineage.length > 0 && [el('h3', {}, 'Linked'), lineage.map((l) => el('div', { class: 'note' }, l))],

    el('div', { class: 'compose' }, avatar('human'),
      el('div', {}, box, trayNode(c.id, ready),
        el('div', { class: 'acts' }, el('span', { class: 'hint' }, 'Enter to send · Shift+Enter for a new line · Paste a picture to show it'), send))),
    changesNode(c),
    c.done && el('div', { class: 'finish' }, c.complete
      ? el('div', { class: 'ok' }, '✓ Complete. You approved this change.')
      // A plan's parts wait for his go-ahead, and this is where he gives it.
      : planWaits(b, c.id) ? el('button', { class: 'go', onclick: () => post('approve', { id: c.id }, 'The plan has your go-ahead') }, '✓ Go ahead with the plan')
      : el('button', { class: 'go', onclick: () => post('complete', { id: c.id }, 'Marked as complete') }, '✓ Mark as complete'),
      undoNode(c)));

  const field = (label, ...kids) => el('div', { class: 'field' }, el('label', {}, label), kids);
  const choose = (options, value, onchange) => {
    const node = el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, name]) => el('option', { value: v }, name)));
    node.value = value;
    return node;
  };
  // Which model builds it and how hard it thinks: left to itself, what its size gives (the smallest
  // model that can do it), or one model up where its last run did not work. The human's pick always wins.
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
  const models = [...new Set([...MODELS, c.model].filter(Boolean))];
  const why = c.suggest.why || 'by its size';
  const stepped = why !== 'by its size';
  const leave = (what, given) => given ? given + ', ' + (!stepped ? 'by its size' : why.startsWith('kept') ? 'kept' : 'stepped up') : what;
  const leftTo = stepped ? 'the step up' : 'its size';
  // Stepped up, a quiet line under the model says from what, and why.
  const stepSays = () => !c.model && stepped && el('div', { class: 'hint' }, cap(why));
  // A run that has been, or is going on, is shown as what it really had, and only that: its agent's
  // command named a model or an effort. A run that named neither (an agent that is not claude, or
  // one a chat started) says nothing about it, and the boxes are the choice for the next run.
  const ran = (c.done || c.column === 'building') && c.run && (c.run.model || c.run.effort) ? c.run : null;
  const next = () => (c.done || c.column === 'building') && !ran && el('div', { class: 'hint' }, 'For the next run');
  const modelPick = ran
    ? el('div', { class: 'val', title: ran.why ? 'Why: ' + ran.why : '' }, cap(ran.model) || 'As your agent runs')
    : [choose([['', leave('As your agent runs', cap(c.suggest.model))], ...models.map((m) => [m, cap(m)])], c.model,
        (v) => save({ model: v }, v ? 'Model: ' + cap(v) : 'Model left to ' + leftTo)),
      stepSays(), next()];
  const effortPick = ran
    ? el('div', { class: 'val' }, ran.effort || 'Default effort')
    : [choose([['', leave('Default effort', c.suggest.effort)], ...EFFORTS.map((e) => [e, e])], c.effort,
        (v) => save({ effort: v }, v ? 'Effort: ' + v : 'Effort left to ' + leftTo)),
      next()];
  const movable = c.column === 'proposed' || c.column === 'build';
  const status = movable
    ? choose([['proposed', '🟠 Proposed'], ['build', '🟢 Build']], c.column, (to) => post('move', { id: c.id, to }, to === 'build' ? 'In build' : 'Back to proposed', moveBack(c.id, c.column, to)))
    : c.column === 'building' ? el('div', { class: 'val' }, '🔵 Building' + (t.by ? ', by ' + whoIs(t.by) : '') + ' ', abortNode(c, ''))
    : el('div', { class: 'val' }, c.complete ? '✅ Done · complete' : '✅ Done · for you to check');
  const addTag = el('input', { placeholder: 'Add a tag', list: 'known-tags',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      e.preventDefault();
      save({ tags: [...c.tags, e.target.value.trim()] }, 'Tagged');
    } });
  const version = el('input', { placeholder: 'None', list: 'known-versions',
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    onchange: (e) => { if (e.target.value.trim() !== c.version) save({ version: e.target.value }, e.target.value.trim() ? 'Version set' : 'Version cleared'); } });
  version.value = c.version;

  const side = el('div', { class: 'side' },
    field('Status', status),
    field('Priority', c.done ? el('div', { class: 'val' }, c.priority) : choose(PRIORITIES.map((name, i) => [String(i), name]), String(c.p), (v) => save({ priority: Number(v) }, 'Priority: ' + PRIORITIES[Number(v)]))),
    field('Difficulty', c.done ? el('div', { class: 'val' }, c.difficulty || 'Not sized') : choose([['', 'Not sized'], ...SIZES], c.size, (v) => v && save({ size: v }, 'Difficulty changed'))),
    field('Model', modelPick),
    field('Effort', effortPick),
    field('Tags',
      el('div', { class: 'chips', style: 'margin: 0 0 7px' }, c.tags.map((tag) => el('span', { class: 'chip tag' }, '#' + tag,
        el('b', { title: 'Remove', onclick: () => save({ tags: c.tags.filter((x) => x !== tag) }, 'Tag removed') }, '✕')))),
      addTag, el('datalist', { id: 'known-tags' }, b.tags.filter((x) => !c.tags.includes(x)).map((x) => el('option', { value: x })))),
    field('Version', version, el('datalist', { id: 'known-versions' }, b.versions.map((x) => el('option', { value: x })))),
    field('Sprint', choose([['', 'None'], ...b.sprints.filter((x) => x.status !== 'done' || x.id === c.sprint).map((x) => [x.id, x.name])], c.sprint,
      (v) => post('assign', { id: c.id, sprint: v }, v ? 'In the sprint' : 'Back in the backlog'))),
    c.type !== 'change' && field('Type', el('div', { class: 'val' }, c.type)),
    (c.column === 'building' || c.done) && field('Built by', el('div', { class: 'val' }, whoIs(t.by))),
    c.done && field('Check', el('div', { class: 'val' }, t.checked ? '✓ Passed: ' + t.checked : 'None was run')),
    c.suggested && field('Came from', el('div', { class: 'val' }, '✨ AI suggested')),
    field('Created', el('div', { class: 'val' }, stamp(c.created, true))),
    field('Updated', el('div', { class: 'val' }, stamp(c.updated, true))));

  return [el('button', { class: 'x', onclick: closeThread, title: 'Close' }, '✕'), el('div', { class: 'ticket' }, story, side)];
}

// The open ticket is drawn again only when something in it changed. While an agent works, the
// board changes every second (its log, its seconds), and rebuilding the ticket for that threw the
// reader's place away: the live log jumped to its top under them. Now those parts are updated
// where they stand, and a full redraw puts every box that scrolls (or folds) back as it was.
// Which ticket is on screen, and the board it was drawn from (redraw() clears that, to draw it again).
let drawnId = null;
let drawnFrom = '';
// The list of projects is left out too: it carries what each agent said last, and the ticket draws none of it.
const steady = (b) => JSON.stringify(b, (k, v) => (k === 'seconds' || k === 'lines' || k === 'workspace' ? undefined : v));
function atFoot(node) { return node.scrollHeight - node.scrollTop - node.clientHeight < 8; }

function drawThread(b) {
  const pane = document.getElementById('thread');
  const veil = document.getElementById('veil');
  const c = openId && everyCard(b).find((x) => x.id === openId);
  pane.hidden = veil.hidden = !c;
  if (!c) { openId = drawnId = null; return; }
  const from = steady(b);
  const same = drawnId === openId;
  if (same && from === drawnFrom && pane.firstChild) { liveInPlace(pane, c, b); return; }
  drawnId = openId;
  drawnFrom = from;
  const at = pane.scrollTop;
  // Where each kept box was: how far down, whether at its foot, whether open.
  const kept = new Map();
  if (same) for (const node of pane.querySelectorAll('[data-keep]')) kept.set(node.dataset.keep, { top: node.scrollTop, foot: atFoot(node), open: node.open });
  pane.replaceChildren(...threadNode(c, b));
  for (const node of pane.querySelectorAll('[data-keep]')) {
    const was = kept.get(node.dataset.keep);
    if (was && node.tagName === 'DETAILS') node.open = was.open;
    // A box that follows (the live log) starts at its foot, and stays there while the human leaves it there.
    if (node.dataset.follow && (!was || was.foot)) node.scrollTop = node.scrollHeight;
    else if (was) node.scrollTop = was.top;
  }
  pane.scrollTop = same ? at : 0;
}

// What changes from second to second while an agent works, changed in place: the nodes stay, and so does the reader.
function liveInPlace(pane, c, b) {
  const run = liveOf(c, b);
  const now = pane.querySelector('.livenow .nowtext');
  if (now && run && run.lines.length) now.textContent = run.lines.at(-1);
  const log = pane.querySelector('.livelog');
  if (log && run) {
    const text = run.lines.join('\n') || 'starting…';
    if (log.textContent !== text) {
      const foot = atFoot(log);
      const top = log.scrollTop;
      log.textContent = text;
      log.scrollTop = foot ? log.scrollHeight : top;
    }
  }
}

// ---- the page

function draw(b) {
  YOU = b.you || '';
  document.getElementById('project').textContent = b.project;
  // A page over several projects: the switcher, and the home view of them all when it is up.
  if (drawProjects(b)) return;
  drawTab(b);
  document.getElementById('where').textContent = b.version ? 'v' + b.version : '';
  // Two things are still worth a line: a project where the gate is off, because there the board
  // cannot promise that nothing builds by itself; and what the page has to say about itself, when
  // it is rebuilding Spool or could not.
  const rule = document.getElementById('rule');
  const lines = [b.gate ? '' : 'The build gate is off in this project: new threads go straight to Build.', b.notice || ''].filter(Boolean);
  rule.textContent = lines.join(' ');
  rule.hidden = !lines.length;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('on', tab.dataset.view === view);

  // Quick filters: one pill a sprint, and whatever tag or version the board is narrowed to.
  const sprints = b.sprints.filter((s) => s.status !== 'done');
  document.getElementById('quick').replaceChildren(...[
    ...(view === 'board' && sprints.length ? [
      el('button', { class: 'pill' + (only ? '' : ' on'), onclick: () => { only = null; redraw(); } }, 'All'),
      ...sprints.map((s) => el('button', { class: 'pill' + (only && only.kind === 'sprint' && only.value === s.id ? ' on' : ''), onclick: () => narrow('sprint', s.id) }, s.name + ' · ' + s.done + '/' + s.total)),
    ] : []),
    only && only.kind !== 'sprint' && el('button', { class: 'pill on', onclick: () => narrow(only.kind, only.value) }, (only.kind === 'tag' ? '#' : 'v') + only.value + '  ✕'),
  ].filter(Boolean));

  // Who builds what is in Build: this page, headless, or a Claude Code chat running the loop.
  const chat = b.runner.builder === 'chat';
  const builder = document.getElementById('builder');
  builder.hidden = false;
  for (const pick of builder.children) {
    const mine = pick.dataset.builder === b.runner.builder;
    pick.className = mine ? 'on' : '';
    pick.setAttribute('aria-pressed', String(mine));
    pick.title = pick.dataset.builder === 'chat'
      ? 'A Claude Code chat builds what is in Build: one running /spool-loop in this project. This page starts no agents.'
      : 'This page builds what is in Build itself, with no chat open. It runs: ' + b.runner.agent;
    pick.onclick = () => { if (!mine) post('builder', { builder: pick.dataset.builder }, ''); };
  }
  // One button says how the agents are doing. Headless, they are the page's own, and it is their switch.
  // With a chat building, the page cannot switch a chat on: it says whether one is building or listening.
  const runner = document.getElementById('runner');
  const lately = b.runner.recent.length ? ' Last: ' + b.runner.recent[0].title + ' — ' + b.runner.recent[0].outcome : '';
  // How many threads the page's own agents are on right now.
  const running = b.runner.running.length;
  runner.hidden = false;
  if (chat) {
    const building = b.columns.building.length > 0;
    const live = building || b.runner.watching;
    runner.className = 'runner' + (live ? ' on' : '');
    runner.textContent = building ? '● Agents: building' : b.runner.watching ? '● Agents: watching' : 'Agents: off';
    runner.title = building ? 'A thread is being built.' + (running ? ' What this page had started is being built to the end.' : '')
      : b.runner.watching ? 'A Claude Code chat is watching this spool. It builds what you move to Build.'
      : 'No Claude Code chat is watching this spool, so nothing in Build is built. Say /spool-loop in one, in this project.';
    runner.onclick = () => say(live ? runner.title : 'Nobody is building. Say /spool-loop in a Claude Code chat in this project.');
  } else {
    runner.className = 'runner' + (b.runner.on ? ' on' : '');
    runner.textContent = b.runner.on ? (running ? '● Agents: building' + (running > 1 ? ' ' + running : '') : '● Agents: on') : 'Agents: off';
    runner.title = (b.runner.on ? 'This page is building what is in Build. Click to switch it off.' : 'Click to have this page build what is in Build, with no chat open.')
      + ' It runs: ' + b.runner.agent + (b.runner.parallel > 1 ? ', on up to ' + b.runner.parallel + ' threads at once' : '') + '.' + lately;
    runner.onclick = () => post('runner', { on: !b.runner.on }, '');
  }
  drawTarget(b);
  drawTakeOver(b);
  drawNotices(b);
  drawElsewhere(b);
  document.getElementById('board').hidden = view !== 'board';
  document.getElementById('backlog').hidden = view !== 'backlog';
  document.getElementById('roadmap').hidden = view !== 'roadmap';
  drawBrief(b);
  if (view === 'board') drawBoard(b); else if (view === 'roadmap') drawRoadmap(b); else drawBacklog(b);
  drawJump();
  const box = document.querySelector('.adding textarea, .adding input');
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  drawThread(b);
  markFocus();
}

// ---- the usage target: in Chat mode, how much of the Claude plan the chat that builds may use

// The plan's limits a target can be set on: the key the board and the command use, and its name.
const LIMITS = [['weekly', 'Weekly'], ['fiveHour', '5-hour']];
let targetsOpen = false;
// What the slider of a limit with no target starts at, once it is switched on.
const TARGET_START = 80;
// The target's changes, sent in turn, and each limit's slider waiting for its keys to stop.
let targetSends = Promise.resolve();
const targetWait = {};
const usedOf = (u, key) => (u.read && u.read.used[key] != null ? u.read.used[key] : null);
const pct = (n) => (Math.round(n * 10) / 10) + '%';

// The limit the header shows: the one nearest its target, or the first that has one.
function shownLimit(u) {
  const set = LIMITS.filter(([key]) => u.target[key] != null);
  const near = (key) => (usedOf(u, key) == null ? -1 : usedOf(u, key) / u.target[key]);
  return set.sort((a, z) => near(z[0]) - near(a[0]))[0] || null;
}

// In the header, Chat mode only: the limit's name, a meter of what is used with a tick at the
// target, and the two numbers. With no target it is a button that says what it is for.
function drawTarget(b) {
  const chip = document.getElementById('target');
  const chat = b.runner.builder === 'chat';
  chip.hidden = !chat;
  if (!chat) return closeTargets();
  const u = b.usage;
  const shown = shownLimit(u);
  chip.className = 'target' + (shown ? ' set' : '') + (u.reached.length ? ' reached' : '');
  chip.onclick = () => (targetsOpen ? closeTargets() : openTargets());
  const change = ' Click to change it.';
  if (!shown) {
    chip.replaceChildren(el('span', { class: 'label' }, 'Usage target'));
    chip.title = 'No usage target: the chat that builds takes what is in Build, whatever the usage. Set how much of your Claude plan it may use, and it works up to that, then takes no new thread.';
  } else {
    const [key, name] = shown;
    const used = usedOf(u, key);
    const goal = u.target[key];
    chip.replaceChildren(
      el('span', { class: 'label' }, name),
      el('span', { class: 'meter', 'aria-hidden': 'true' },
        el('i', { class: 'used', style: 'width: ' + Math.min(100, used || 0) + '%' }),
        el('i', { class: 'mark', style: 'left: ' + goal + '%' })),
      el('span', { class: 'num' }, (used == null ? 'to ' : Math.round(used) + ' / ') + goal + '%'));
    chip.title = u.reached.length
      ? 'Usage target reached: ' + u.reached.map((k) => LIMITS.find(([x]) => x === k)[1].toLowerCase() + ' ' + pct(usedOf(u, k)) + ' of ' + u.target[k] + '%').join(', ') + '. The chat that builds takes no new thread until it is under again, or you raise it.' + change
      : used == null ? name + ' target: ' + goal + '% of your Claude plan. No usage read yet: the chat that builds reads it before each thread.' + change
      : name + ' usage ' + pct(used) + ' of your ' + goal + '% target, read ' + ago(u.read.at, true) + ' by ' + u.read.by + '. The chat that builds works up to it, then takes no new thread.' + change;
  }
  // Said in words to a screen reader: the meter is only a picture of them.
  const said = shown && (shown[1] + ' usage ' + (usedOf(u, shown[0]) == null ? 'target ' : pct(usedOf(u, shown[0])) + ' of a target of ') + u.target[shown[0]] + '%');
  chip.setAttribute('aria-label', said || 'Usage target');
  chip.setAttribute('aria-expanded', String(targetsOpen));
  if (targetsOpen) fillTargets(u);
}

// The box under it: for each limit, a switch, a slider and a box to type the number in. The slider
// shows what is used, shaded in, so the target is set against it. Each change is spool target.
function openTargets() {
  closeTakeOvers();
  const box = document.getElementById('targets');
  targetsOpen = true;
  const shut = el('button', { class: 'shut', title: 'Close', 'aria-label': 'Close', onclick: closeTargets }, '×');
  box.replaceChildren(
    el('div', { class: 'head' }, el('h3', {}, 'Usage target'), shut),
    el('p', { class: 'what' }, 'The chat that builds here works until your Claude plan’s usage reaches this, then takes no new thread.'),
    ...LIMITS.map(([key, name]) => limitNode(key, name)),
    el('p', { class: 'foot' }));
  box.hidden = false;
  document.getElementById('target').setAttribute('aria-expanded', 'true');
  if (current) fillTargets(current.usage);
}
function closeTargets() {
  if (!targetsOpen) return;
  targetsOpen = false;
  document.getElementById('targets').hidden = true;
  document.getElementById('targets').replaceChildren();
  document.getElementById('target').setAttribute('aria-expanded', 'false');
}
function limitNode(key, name) {
  const on = el('input', { type: 'checkbox' });
  const slide = el('input', { type: 'range', min: '1', max: '100', step: '1', 'aria-label': name + ' target, in percent' });
  const num = el('input', { type: 'number', min: '1', max: '100', step: '1', inputmode: 'numeric', 'aria-label': name + ' target, in percent, typed' });
  const row = el('div', { class: 'limit', 'data-limit': key }, el('label', { class: 'name' }, on, name), slide, el('span', { class: 'box' }, num, '%'), el('div', { class: 'now' }));
  const whole = (v) => Math.min(100, Math.max(1, Math.round(Number(v)) || TARGET_START));
  // Set: the number the slider or the box says, sent once it is let go of, or typed and left.
  // The slider moved by its keys says it changed at every step: it is sent once they stop. Sends go
  // one after another, so the last number given is the one kept, whatever order they would arrive in.
  const set = (value, wait) => {
    clearTimeout(targetWait[key]);
    const send = () => {
      targetSends = targetSends.then(() => {
        const had = current ? current.usage.target[key] : undefined;
        if ((had == null ? null : had) === value) return;
        return post('target', { [key]: value }, value == null ? 'No ' + name.toLowerCase() + ' target.' : name + ' target: ' + value + '%. The chat works up to it.');
      });
    };
    if (wait) targetWait[key] = setTimeout(send, 300); else send();
  };
  on.addEventListener('change', () => { row.classList.toggle('off', !on.checked); slide.disabled = num.disabled = !on.checked; set(on.checked ? whole(num.value) : null); });
  slide.addEventListener('input', () => { num.value = slide.value; });
  slide.addEventListener('change', () => set(whole(slide.value), true));
  num.addEventListener('input', () => { if (Number(num.value) >= 1 && Number(num.value) <= 100) slide.value = String(Math.round(Number(num.value))); });
  num.addEventListener('change', () => { num.value = slide.value = String(whole(num.value)); set(Number(num.value)); });
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } });
  return row;
}
// What the box shows, from the board: each control left alone while it is being used.
function fillTargets(u) {
  const box = document.getElementById('targets');
  const at = document.activeElement;
  for (const row of box.querySelectorAll('.limit')) {
    const key = row.dataset.limit;
    const [on, slide, num] = row.querySelectorAll('input');
    const goal = u.target[key];
    const used = usedOf(u, key);
    const reached = u.reached.includes(key);
    if (at !== on) on.checked = goal != null;
    row.classList.toggle('off', goal == null);
    row.classList.toggle('reached', reached);
    slide.disabled = num.disabled = goal == null;
    if (at !== slide && at !== num) slide.value = num.value = String(goal != null ? goal : (Number(num.value) || TARGET_START));
    slide.style.setProperty('--used', Math.min(100, used || 0) + '%');
    row.querySelector('.now').className = 'now' + (reached ? ' reached' : '');
    row.querySelector('.now').textContent = used == null ? 'Not read yet.' : 'Used ' + pct(used) + (reached ? ': reached, so the chat takes no new thread.' : goal != null ? ', ' + pct(Math.max(0, goal - used)) + ' to go.' : '.');
  }
  box.querySelector('.foot').textContent = u.read
    ? 'Read ' + ago(u.read.at, true) + ' by ' + u.read.by + '. The chat reads it again before each thread.'
    : 'Nothing read yet. The chat that builds reads your usage before each thread, and this fills in.';
}
// A click anywhere else puts the box away. Where the click was is read from its path as it was sent:
// the palette's own row is gone by now, having opened this box.
document.addEventListener('click', (e) => {
  if (targetsOpen && !e.composedPath().some((node) => ['targets', 'target', 'layer'].includes(node.id))) closeTargets();
});

// ---- taking over the backlog: in Chat mode, the chat that builds may move threads to Build itself

let takeOversOpen = false;
const takeOverOf = (b) => b.takeOver || { on: false, next: null, waiting: null };

// In the header, Chat mode only: a switch that says whether the chat takes over, and opens its menu.
function drawTakeOver(b) {
  const chip = document.getElementById('takeover');
  const chat = b.runner.builder === 'chat';
  chip.hidden = !chat;
  if (!chat) return closeTakeOvers();
  const t = takeOverOf(b);
  chip.className = 'takeover' + (t.on ? ' on' : '');
  chip.replaceChildren(el('span', { class: 'knob', 'aria-hidden': 'true' }), el('span', { class: 'label' }, 'Take over'));
  chip.title = t.on
    ? 'The chat takes over the backlog: with Build empty and the usage under your target, it moves the top thread you filed to Build itself, and builds it.' + (t.waiting ? ' Not now: ' + t.waiting + '.' : '') + ' Click for its settings.'
    : 'The chat builds only what you move to Build. Click to let it take over the backlog, up to your usage target.';
  chip.setAttribute('aria-label', 'Take over the backlog: ' + (t.on ? 'on' : 'off'));
  chip.setAttribute('aria-expanded', String(takeOversOpen));
  chip.onclick = () => (takeOversOpen ? closeTakeOvers() : openTakeOvers());
  if (takeOversOpen) fillTakeOvers(b);
}

// The menu under it: the switch, the usage it works up to, and which threads it takes. Each is an
// entry of its own, so more settings for the agents can be added here later.
function openTakeOvers() {
  closeTargets();
  const box = document.getElementById('takeovers');
  takeOversOpen = true;
  const shut = el('button', { class: 'shut', title: 'Close', 'aria-label': 'Close', onclick: closeTakeOvers }, '×');
  const on = el('input', { type: 'checkbox' });
  on.addEventListener('change', () => post('takeover', { on: on.checked }, on.checked
    ? 'The chat takes over the backlog, up to your usage target.'
    : 'The chat builds only what you move to Build.'));
  const change = el('button', { class: 'link', onclick: (e) => { e.stopPropagation(); closeTakeOvers(); openTargets(); } }, 'Change');
  box.replaceChildren(
    el('div', { class: 'head' }, el('h3', {}, 'Take over the backlog'), shut),
    el('div', { class: 'entry switch' },
      el('label', { class: 'name' }, on, 'The chat takes over'),
      el('p', {}, 'With Build empty, the chat that builds moves the top thread you filed to Build itself, and builds it. Each says so on its thread, and Undo takes it back.')),
    el('div', { class: 'entry usage' },
      el('div', { class: 'name' }, 'Works up to', change),
      el('p', { class: 'goal' })),
    el('div', { class: 'entry takes' },
      el('div', { class: 'name' }, 'Takes'),
      el('p', {}, 'Threads you filed, top of the backlog first, one at a time. Never an AI suggested one, one on hold, or one waiting on a question or a plan’s go-ahead.'),
      el('p', { class: 'now' })));
  box.hidden = false;
  document.getElementById('takeover').setAttribute('aria-expanded', 'true');
  if (current) fillTakeOvers(current);
}
function closeTakeOvers() {
  if (!takeOversOpen) return;
  takeOversOpen = false;
  document.getElementById('takeovers').hidden = true;
  document.getElementById('takeovers').replaceChildren();
  document.getElementById('takeover').setAttribute('aria-expanded', 'false');
}
// What the menu shows, from the board: the switch left alone while it is being used.
function fillTakeOvers(b) {
  const box = document.getElementById('takeovers');
  const t = takeOverOf(b);
  const on = box.querySelector('.switch input');
  if (on && document.activeElement !== on) on.checked = t.on;
  box.classList.toggle('off', !t.on);
  const u = b.usage;
  const set = LIMITS.filter(([key]) => u.target[key] != null);
  box.querySelector('.goal').textContent = set.length
    ? set.map(([key, name]) => name + ' ' + (usedOf(u, key) == null ? 'target ' + u.target[key] + '%' : Math.round(usedOf(u, key)) + ' of ' + u.target[key] + '%')).join(', ') + '. It moves nothing more once that is reached.'
    : 'No usage target is set, so it moves nothing. Set one to let it take over.';
  const now = box.querySelector('.takes .now');
  now.className = 'now' + (t.on && t.waiting ? ' not' : '');
  now.textContent = !t.on ? '' : t.waiting ? 'Not now: ' + t.waiting + '.' : t.next ? 'Next: ' + t.next.title : '';
}
document.addEventListener('click', (e) => {
  if (takeOversOpen && !e.composedPath().some((node) => ['takeovers', 'takeover', 'layer'].includes(node.id))) closeTakeOvers();
});

// ---- what notifies him: the events he picked, sent as one line each, and quiet for the rest

// Every event, in the order the command lists them, and what it is in a few words (notices.ts).
const NOTICES = [
  ['started', 'A thread starts'],
  ['done', 'A thread is done'],
  ['question', 'A question is asked'],
  ['sprint', 'A sprint is finished'],
  ['empty', 'Build is empty'],
  ['stuck', 'An agent is stuck or refused'],
  ['budget', 'A run stops at its usage target'],
];
const BELL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z"/><path d="M6.5 14a1.5 1.5 0 0 0 3 0"/></svg>';
let noticesOpen = false;
// The changes, sent one after another, so the last click is the one kept.
let noticeSends = Promise.resolve();

// How each is sent: by the chat in Chat mode, by his notifier headless, or not at all.
function noticesVia(b) {
  if (b.runner.builder === 'chat') return 'The chat that builds sends each as one line, a Claude notification.';
  return b.notices.notifier ? 'This page runs your notifier for each: ' + b.notices.notifier : 'Headless, nothing is sent: no notifier is set. Put one under notify in ~/.config/spool/config.json.';
}
function drawNotices(b) {
  const bell = document.getElementById('notifier');
  const n = b.notices;
  bell.hidden = false;
  bell.innerHTML = BELL;
  bell.className = 'themer notifier' + (n.on.length ? '' : ' quiet');
  const words = n.on.length ? NOTICES.filter(([key]) => n.on.includes(key)).map(([, name]) => name.toLowerCase()).join(', ') : 'nothing';
  bell.title = 'Notifications: ' + words + '. Click to change them.';
  bell.setAttribute('aria-label', 'Notifications: ' + n.on.length + ' of ' + NOTICES.length + ' on');
  bell.setAttribute('aria-expanded', String(noticesOpen));
  bell.onclick = () => (noticesOpen ? closeNotices() : openNotices());
  if (noticesOpen) fillNotices(b);
}
function openNotices() {
  const box = document.getElementById('notices');
  noticesOpen = true;
  const shut = el('button', { class: 'shut', title: 'Close', 'aria-label': 'Close', onclick: closeNotices }, '×');
  box.replaceChildren(
    el('div', { class: 'head' }, el('h3', {}, 'Notifications'), shut),
    el('p', { class: 'what' }, 'What tells you, in every project. Everything else is quiet.'),
    ...NOTICES.map(([key, name]) => {
      const on = el('input', { type: 'checkbox', 'data-event': key });
      on.addEventListener('change', () => {
        const want = on.checked;
        noticeSends = noticeSends.then(() => post('notify', { event: key, on: want }, (want ? 'Notifies you: ' : 'Quiet: ') + name.toLowerCase() + '.'));
      });
      return el('label', { class: 'nrow' }, on, name);
    }),
    el('div', { class: 'foot' }, el('span', { class: 'via' }),
      el('button', { class: 'reset', onclick: () => { noticeSends = noticeSends.then(() => post('notify', { default: true }, 'Notifications back to the defaults.')); } }, 'Defaults')));
  box.hidden = false;
  document.getElementById('notifier').setAttribute('aria-expanded', 'true');
  if (current) fillNotices(current);
}
function closeNotices() {
  if (!noticesOpen) return;
  noticesOpen = false;
  const box = document.getElementById('notices');
  box.hidden = true;
  box.replaceChildren();
  document.getElementById('notifier').setAttribute('aria-expanded', 'false');
}
// What the box shows, from the board: a box being clicked is left alone.
function fillNotices(b) {
  const box = document.getElementById('notices');
  for (const on of box.querySelectorAll('input[data-event]')) if (document.activeElement !== on) on.checked = b.notices.on.includes(on.dataset.event);
  box.querySelector('.via').textContent = noticesVia(b);
  box.querySelector('.reset').hidden = b.notices.default;
}
document.addEventListener('click', (e) => {
  if (noticesOpen && !e.composedPath().some((node) => ['notices', 'notifier', 'layer'].includes(node.id))) closeNotices();
});

// The board lives in a background tab, where its title and icon are all that shows. Both say what
// waits on him, as a count: an open question, a plan wanting its go-ahead, an agent that stopped
// and wants a word. The server counts it, so the tab, the brief and the list of projects agree.
// Failing that, a dot while agents build. With nothing going on, the title is the project's name
// and the icon is the yarn alone.
function waitsOnYou(b) {
  return b.waitsOnYou || 0;
}
let drawnTab = '';
function drawTab(b) {
  const waits = waitsOnYou(b);
  const building = b.columns.building.length > 0;
  document.title = (waits ? '(' + waits + ') ' : '') + (building ? '● ' : '') + b.project;
  const mark = waits ? 'waits-' + waits : building ? 'building' : '';
  if (mark === drawnTab) return;
  drawnTab = mark;
  // The yarn, with a badge in the colour of what waits on him, or a dot in the colour of an agent at work.
  const yarn = "<text y='.9em' font-size='90'>🧶</text>";
  const badge = waits ? "<circle cx='70' cy='30' r='30' fill='#b45309' stroke='#fff' stroke-width='5'/><text x='70' y='44' font-size='" + (waits > 9 ? 32 : 42) + "' font-weight='700' fill='#fff' text-anchor='middle' font-family='sans-serif'>" + (waits > 9 ? '9+' : waits) + '</text>'
    : building ? "<circle cx='78' cy='22' r='19' fill='#1d4ed8' stroke='#fff' stroke-width='5'/>" : '';
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" + yarn + badge + '</svg>';
  document.getElementById('icon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// On a phone the board is one column at a time, swiped sideways. A row of the columns' names, with
// what each holds, says which is in view and goes to another. It is hidden wider than that.
function drawJump() {
  const nav = document.getElementById('jump');
  nav.hidden = view !== 'board';
  if (nav.hidden) return;
  const cols = [...document.querySelectorAll('#board .col')];
  nav.replaceChildren(...cols.map((col, i) => {
    const count = col.querySelector('h2 .count');
    return el('button', { 'data-column': col.dataset.column, onclick: () => document.getElementById('board').scrollTo({ left: col.offsetLeft - cols[0].offsetLeft }) },
      COLUMNS[i][1] + (count ? ' ' + count.textContent : ''));
  }));
  inView();
}
// Which column is in view, marked in the row of names.
function inView() {
  const board = document.getElementById('board');
  const cols = [...board.querySelectorAll('.col')];
  if (!cols.length) return;
  const step = cols.length > 1 ? cols[1].offsetLeft - cols[0].offsetLeft : 1;
  const at = Math.min(cols.length - 1, Math.max(0, Math.round(board.scrollLeft / step)));
  for (const button of document.getElementById('jump').children) button.classList.toggle('on', button.dataset.column === cols[at].dataset.column);
}
document.getElementById('board').addEventListener('scroll', inView);

// Draw again from what is already here: a view, a filter or a box changed, and nothing on disk did.
function redraw() { drawnFrom = ''; if (current) draw(current); }

// The server is now another build of Spool than the one this page came from: load the page again,
// so what is on screen is what was built. Once for each build, so a page that cannot get onto it
// does not spin. True if the page is going.
function renew(build) {
  try {
    if (sessionStorage.getItem('spool-renewed') === build) return false;
    sessionStorage.setItem('spool-renewed', build);
    sessionStorage.setItem('spool-drafts', JSON.stringify([...drafts]));
  } catch (e) {}
  location.reload();
  return true;
}

// How many looks in a row found no server, and when one last did. A page restarting onto a new
// build is away for a moment, so it takes a few missed looks before the page says it is not connected.
let misses = 0;
let heard = Date.now();
function connected(yes) {
  const banner = document.getElementById('away');
  if (yes) {
    heard = Date.now();
    misses = 0;
    if (banner.hidden) return;
    banner.hidden = true;
    document.body.classList.remove('away');
    // Draw the board again even if it is just as it was, so the agents' switch says what it is.
    last = '';
    // A server that came back may be a new one, with a new token: get it before the next click needs it.
    freshToken().catch(() => {});
    return;
  }
  if (++misses < 3 || !banner.hidden) return;
  const icon = el('span', { class: 'icon', 'aria-hidden': 'true' });
  icon.innerHTML = AWAY_ICON;
  banner.replaceChildren(icon, el('span', { class: 'words' }, 'Not connected to the Spool server. Last heard from it ',
    el('span', { 'data-since': new Date(heard).toISOString() }, took(new Date(heard).toISOString())), ' ago. Trying again…'));
  banner.hidden = false;
  document.body.classList.add('away');
  unknown();
}
const AWAY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.75 14.75 13.5H1.25z"/><path d="M8 6.25v3.25M8 11.5v.01"/></svg>';
// With no server, nobody can say whether agents are on or who builds: the switch and the picks say
// so, greyed, until the server answers and the board is drawn again.
function unknown() {
  const runner = document.getElementById('runner');
  runner.className = 'runner unknown';
  runner.textContent = 'Agents: ?';
  runner.title = 'Not connected to the Spool server, so whether agents are on is not known.';
  runner.onclick = () => say(runner.title);
  for (const pick of document.getElementById('builder').children) {
    pick.className = 'unknown';
    pick.setAttribute('aria-pressed', 'false');
    pick.onclick = () => say('Not connected to the Spool server. Trying again…');
  }
}
async function load(now) {
  // Never redraw under someone's typing or choosing; a redraw that was asked for goes ahead.
  const at = document.activeElement;
  if (!now && (busy || (at && at.id !== 'search' && (['TEXTAREA', 'INPUT', 'SELECT'].includes(at.tagName) || at.isContentEditable)))) return;
  try {
    const res = await fetch(boardUrl());
    if (!res.ok) throw new Error('no board');
    const text = await res.text();
    connected(true);
    if (text === last) return;
    const b = JSON.parse(text);
    if (!fromHere(b)) return;
    if (b.build && b.build !== BUILD && renew(b.build)) return;
    last = text;
    current = b;
    draw(current);
  } catch (e) {
    connected(false);
  }
}

// The theme: one button in the bar, going round System, Light and Dark, drawn as the one in force.
const THEMES = [
  ['system', 'System', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>'],
  ['light', 'Light', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>'],
  ['dark', 'Dark', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>'],
];
function drawTheme() {
  const at = THEMES.findIndex(([key]) => key === paintTheme());
  const [, name, icon] = THEMES[at];
  const button = document.getElementById('themer');
  button.innerHTML = icon;
  button.title = 'Theme: ' + name + '. Click for ' + THEMES[(at + 1) % THEMES.length][1] + '.';
  button.setAttribute('aria-label', 'Theme: ' + name);
}
document.getElementById('themer').addEventListener('click', () => {
  const at = THEMES.findIndex(([key]) => key === paintTheme());
  try { localStorage.setItem('spool-theme', THEMES[(at + 1) % THEMES.length][0]); } catch (e) {}
  drawTheme();
});
drawTheme();

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    view = tab.dataset.view;
    try { localStorage.setItem('spool-view', view); } catch (e) {}
    adding = null;
    redraw();
  });
}
document.getElementById('search').addEventListener('input', (e) => { query = e.target.value.trim(); redraw(); });
// On a phone the search is a button, and the box opens over the bar's second row. It folds away
// again when it is left empty.
function openSearch() {
  document.querySelector('.bar').classList.add('searching');
  document.getElementById('search').focus();
}
document.getElementById('searchbtn').addEventListener('click', openSearch);
document.getElementById('search').addEventListener('blur', (e) => { if (!e.target.value) document.querySelector('.bar').classList.remove('searching'); });
if (/^#t-[a-z0-9]+$/.test(location.hash)) openId = location.hash.slice(1);
document.getElementById('veil').addEventListener('click', closeThread);

// ---- the keyboard: one table of keys, one handler for them, and the boxes they open

// The thread the keyboard is on, by its id: the cards are built again every second, so a node would not last.
let focusId = null;
// The lists j and k move along: each column of the board, or the Backlog view's rows top to bottom.
function lanes() {
  if (view === 'board') return [...document.querySelectorAll('#board .col')].map((col) => [...col.querySelectorAll('.card[data-id]')]);
  if (view === 'roadmap') return [...document.querySelectorAll('#roadmap .lane')].map((lane) => [...lane.querySelectorAll('.rrow[data-id]')]);
  return [[...document.querySelectorAll('#backlog .row[data-id]')]];
}
function markFocus() {
  for (const node of document.querySelectorAll('.kfocus')) node.classList.remove('kfocus');
  const node = focusId && lanes().flat().find((n) => n.dataset.id === focusId);
  if (node) node.classList.add('kfocus');
  return node;
}
function focusOn(id) {
  focusId = id;
  const node = markFocus();
  if (node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
// Where the focus is: which list, and how far down it. With none, the first thread there is.
function spot() {
  const all = lanes();
  for (let i = 0; i < all.length; i++) {
    const at = all[i].findIndex((n) => n.dataset.id === focusId);
    if (at >= 0) return { all, lane: i, at };
  }
  return { all, lane: -1, at: -1 };
}
function firstThread(all) {
  const lane = all.find((l) => l.length);
  if (lane) focusOn(lane[0].dataset.id);
}
function upDown(by) {
  const { all, lane, at } = spot();
  if (lane < 0) return firstThread(all);
  const list = all[lane];
  focusOn(list[Math.max(0, Math.min(list.length - 1, at + by))].dataset.id);
}
// h and l: the next column that has a card in it, as near the same height as it has.
function across(by) {
  const { all, lane, at } = spot();
  if (lane < 0) return firstThread(all);
  for (let i = lane + by; i >= 0 && i < all.length; i += by) {
    if (all[i].length) return focusOn(all[i][Math.min(at, all[i].length - 1)].dataset.id);
  }
}
// The focused thread as the board knows it, and whether it is an archived one.
function focused() {
  if (!current || !focusId) return null;
  const live = everyCard(current).find((c) => c.id === focusId);
  if (live) return live;
  const gone = current.archived.find((c) => c.id === focusId);
  return gone ? { ...gone, archived: true } : null;
}
function openFocused() {
  const c = focused();
  if (c && !c.archived) openThread(c.id);
}
// b and x do just what the card's own buttons do, Undo on the toast included, and only where the card shows them.
function buildFocused() {
  const c = focused();
  if (c && !c.archived && c.column === 'proposed') post('move', { id: c.id, to: 'build' }, 'In build: ' + c.title, moveBack(c.id, 'proposed', 'build'));
}
function archiveFocused() {
  const c = focused();
  if (!c || c.archived || c.column !== 'proposed') return;
  // The card is about to go: the focus moves on to the one after it, or before it at the foot.
  const { all, lane, at } = spot();
  const list = lane >= 0 ? all[lane] : [];
  const next = list[at + 1] || list[at - 1];
  // Only once it has gone: a failed archive leaves the focus where it was.
  post('archive', { id: c.id }, 'Archived: ' + c.title, () => post('unarchive', { id: c.id }, 'Back in the backlog: ' + c.title)).then((ok) => { if (ok) focusId = next ? next.dataset.id : null; });
}
function goTo(where) {
  const tab = document.querySelector('.tab[data-view="' + where + '"]');
  if (tab) tab.click();
}

// What is over the page: nothing, or one of the keyboard's boxes ('keys').
let layer = null;
function closeLayer() {
  layer = null;
  document.getElementById('layer').hidden = document.getElementById('layerveil').hidden = true;
  document.getElementById('layer').replaceChildren();
}
function openLayer(kind) {
  const box = document.getElementById('layer');
  layer = kind;
  box.replaceChildren(...LAYERS[kind]().flat(3).filter(Boolean));
  box.setAttribute('aria-label', { keys: 'Keys', add: 'Quick add', find: 'Find' }[kind]);
  box.hidden = document.getElementById('layerveil').hidden = false;
  const input = box.querySelector('textarea, input');
  if (input) input.focus();
}
document.getElementById('layerveil').addEventListener('click', closeLayer);

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
// Every key the page answers to. The sheet that ? opens is drawn from this table, so it cannot fall behind.
// "board" keys act on the focused thread, and wait while a ticket is open.
const KEYS = [
  { key: 'j', label: 'j  k', says: 'Next and previous thread in a column or list', run: () => upDown(1), board: true },
  { key: 'k', run: () => upDown(-1), board: true },
  { key: 'h', label: 'h  l', says: 'The column to the left, and to the right', run: () => across(-1), board: true },
  { key: 'l', run: () => across(1), board: true },
  { key: 'Enter', label: 'Enter', says: 'Open its ticket', run: openFocused, board: true },
  { key: 'b', label: 'b', says: 'Move it to Build, from the backlog', run: buildFocused, board: true },
  { key: 'x', label: 'x', says: 'Archive it, from the backlog', run: archiveFocused, board: true },
  { key: 'g b', label: 'g then b', says: 'Go to the Board', run: () => goTo('board'), board: true },
  { key: 'g l', label: 'g then l', says: 'Go to the Backlog', run: () => goTo('backlog'), board: true },
  { key: 'g r', label: 'g then r', says: 'Go to the Roadmap', run: () => goTo('roadmap'), board: true },
  { key: '/', label: '/', says: 'Search', run: () => openSearch(), board: true },
  { key: 'c', label: 'c', says: 'Add a thread to the backlog, from anywhere', run: () => openLayer('add') },
  { key: 'mod k', label: MAC ? '⌘ K' : 'Ctrl K', says: 'Find a thread, or run an action by name' },
  { key: 'Escape', label: 'Esc', says: 'Close what is open, or let go of the thread' },
  { key: '?', label: '?', says: 'This list', run: () => (layer === 'keys' ? closeLayer() : openLayer('keys')) },
];

const LAYERS = {
  keys: () => [
    el('h3', {}, 'Keys'),
    KEYS.filter((k) => k.label).map((k) => el('div', { class: 'keyrow' },
      el('span', {}, k.label.split(' ').filter(Boolean).map((part) => [part === 'then' ? part : el('kbd', {}, part), ' '])), el('span', {}, k.says))),
    el('div', { class: 'foot' }, 'Keys wait while you type in a box. Esc closes this.'),
  ],
  add: quickAddNode,
  find: findNode,
};

// The palette: any thread on the board by its name, id or tag, and anything the page can do by name.
function actionsOf(b) {
  const chat = b.runner.builder === 'chat';
  return [
    { name: 'Go to the Board', hint: 'g b', run: () => goTo('board') },
    { name: 'Go to the Backlog', hint: 'g l', run: () => goTo('backlog') },
    { name: 'Go to the Roadmap', hint: 'g r', run: () => goTo('roadmap') },
    { name: 'Switch who builds to ' + (chat ? 'Headless' : 'Chat'), run: () => post('builder', { builder: chat ? 'headless' : 'chat' }, '') },
    !chat && { name: b.runner.on ? 'Switch agents off' : 'Switch agents on', run: () => post('runner', { on: !b.runner.on }, '') },
    chat && { name: 'Set the usage target', run: () => openTargets() },
    { name: 'Choose what notifies you', run: () => openNotices() },
    ...b.sprints.filter((x) => x.waiting > 0).map((x) => ({ name: 'Play sprint: ' + x.name, run: () => post('play', { id: x.id }, x.name + ' is running') })),
    { name: 'Add a thread', hint: 'c', run: () => openLayer('add') },
    { name: 'Show the keys', hint: '?', run: () => openLayer('keys') },
  ].filter(Boolean).map((a) => ({ ...a, kind: 'action', others: [] }));
}
// How well a name matches: it starts with what was typed, then a word in it does (or an id or a tag), then anywhere.
function rankOf(q, name, others) {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if ((' ' + n).includes(' ' + q) || others.some((o) => o.startsWith(q))) return 1;
  if (n.includes(q) || others.some((o) => o.includes(q))) return 2;
  return -1;
}
function findAll(words) {
  if (!current) return [];
  const q = words.trim().toLowerCase();
  const threads = [...everyCard(current), ...current.archived.map((c) => ({ ...c, archived: true }))]
    .map((c) => ({ kind: 'thread', c, name: c.title, others: [c.id, ...c.tags.map((t) => '#' + t)] }));
  const all = [...actionsOf(current), ...threads];
  if (!q) return all.slice(0, 10);
  return all.map((x, i) => ({ x, i, r: rankOf(q, x.name, x.others) })).filter((m) => m.r >= 0)
    .sort((a, z) => a.r - z.r || a.i - z.i).map((m) => m.x).slice(0, 10);
}
function runHit(x, copying) {
  if (!x) return;
  closeLayer();
  if (x.kind === 'action') return x.run();
  if (copying) return copyId(x.c.id);
  // An archived thread has no ticket: it is shown where it is kept, at the foot of the Backlog view.
  if (x.c.archived) {
    showArchived = true;
    focusId = x.c.id;
    if (view !== 'backlog') goTo('backlog'); else redraw();
    return focusOn(x.c.id);
  }
  focusId = x.c.id;
  openThread(x.c.id);
}
let finding = { list: [], at: 0 };
function findNode() {
  const hits = el('div', { class: 'hits', role: 'listbox' });
  const mark = () => [...hits.children].forEach((n, i) => { n.classList.toggle('on', i === finding.at); n.setAttribute('aria-selected', String(i === finding.at)); });
  const list = () => {
    finding = { list: findAll(input.value), at: 0 };
    hits.replaceChildren(...(finding.list.length ? finding.list.map((x, i) => el('div', { class: 'hit', role: 'option',
      onmousemove: () => { if (finding.at !== i) { finding.at = i; mark(); } },
      onclick: (e) => runHit(x, e.shiftKey) },
      el('span', { class: 'name' }, x.name),
      x.kind === 'thread'
        ? [el('span', { class: 'soft mono' }, x.c.id), el('span', { class: 'state ' + x.c.column }, x.c.archived ? 'Archived' : STATE[x.c.column])]
        : el('span', { class: 'soft' }, x.hint ? x.hint : 'Action'))) : [el('div', { class: 'empty' }, 'Nothing matches.')]));
    mark();
  };
  const input = el('input', { placeholder: 'Find a thread, or an action', autocomplete: 'off', oninput: list,
    onkeydown: (e) => {
      const by = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (by && finding.list.length) { e.preventDefault(); finding.at = (finding.at + by + finding.list.length) % finding.list.length; mark(); }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runHit(finding.list[finding.at], e.shiftKey); }
    } });
  list();
  return [input, hits, el('div', { class: 'foot' }, 'Enter opens or runs it. Shift+Enter copies a thread\'s id. Esc closes.')];
}

// Quick add: one box over the page, filed to the backlog as + Add files it. A #word in it is a tag
// and !0 to !3 its priority, shown under the box and left out of the name; the words are kept whole.
let quickDraft = '';
function quickParse(words) {
  const tags = [];
  let priority = null;
  const rest = words.replace(/(^|\s)(?:#([a-z][a-z0-9-]*)|!([0-3]))(?=\s|$)/gi, (all, before, tag, p) => {
    if (tag && !tags.includes(tag.toLowerCase())) tags.push(tag.toLowerCase());
    if (p) priority = Number(p);
    return before;
  });
  return { tags, priority, title: rest.split('\n')[0].replace(/\s+/g, ' ').trim() };
}
function quickAddNode() {
  const chips = el('div', { class: 'chips' });
  const show = () => {
    const { tags, priority } = quickParse(box.value);
    chips.replaceChildren(...[priority != null && el('span', { class: 'chip' }, ARROWS[priority] + ' ' + PRIORITIES[priority]), ...tags.map((t) => el('span', { class: 'chip' }, '#' + t))].filter(Boolean));
  };
  const save = async () => {
    const words = box.value.trim();
    const { tags, priority, title } = quickParse(words);
    if (!title) return;
    quickDraft = '';
    closeLayer();
    // If it could not be saved, the box comes back with their words in it.
    const made = await post('add', { text: words, to: 'proposed', title, tags, ...(priority != null ? { priority } : {}) }, 'Added to the backlog: ' + title);
    if (!made) {
      quickDraft = words;
      openLayer('add');
    } else await sendPictures(made, 'quick');
  };
  const box = el('textarea', { rows: 2, placeholder: 'What do you want added?   #tag  !0 to !3 for priority',
    oninput: () => { quickDraft = box.value; show(); },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } } });
  box.value = quickDraft;
  show();
  takePictures(box, 'quick');
  return [box, chips, trayNode('quick'), el('div', { class: 'foot' }, 'Enter adds it to the backlog. Shift+Enter is a new line. Paste a picture to send it too. Esc closes, and keeps what you typed.')];
}

// Esc closes the nearest thing: a box over the page, then the search, then the ticket, then lets go of the thread.
function escape(at, typing) {
  if (layer) return closeLayer();
  if (targetsOpen) { closeTargets(); document.getElementById('target').focus(); return; }
  if (noticesOpen) { closeNotices(); document.getElementById('notifier').focus(); return; }
  if (at && at.id === 'search') { at.value = ''; query = ''; at.blur(); redraw(); return; }
  if (openId && !adding && !(at && at.isContentEditable)) return closeThread();
  if (!typing && focusId) { focusId = null; markFocus(); }
}

// g waits a moment for the key that says where to go.
let chord = '';
let chordAt = 0;
document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const at = document.activeElement;
  const typing = at && (['TEXTAREA', 'INPUT', 'SELECT'].includes(at.tagName) || at.isContentEditable);
  // The palette's own shortcut works from anywhere, a box being typed in included.
  if ((MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return layer === 'find' ? closeLayer() : openLayer('find');
  }
  if (e.key === 'Escape') return escape(at, typing);
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  let name = e.key;
  if (chord && Date.now() - chordAt < 1500) name = chord + ' ' + e.key;
  chord = '';
  if (name === 'g' && !layer && !openId) { chord = 'g'; chordAt = Date.now(); e.preventDefault(); return; }
  const hit = KEYS.find((k) => k.key === name && k.run);
  if (!hit) return;
  // A box over the page takes no keys but its own; a ticket that is open takes none of the board's.
  if (layer && hit.key !== '?') return;
  if (hit.board && openId) return;
  // Enter on a button or a link presses it, as it always has.
  if (hit.key === 'Enter' && at && at !== document.body && at.matches('button, a, summary, [tabindex]')) return;
  e.preventDefault();
  hit.run();
});
load();
setInterval(load, 1500);
// The clock: how long an agent has been at it, and how long ago things were said, kept current in place.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = took(node.dataset.since);
  for (const node of document.querySelectorAll('[data-at]')) node.textContent = ago(node.dataset.at, !!node.dataset.alone);
}, 1000);
`;
