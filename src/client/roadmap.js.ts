/**
 * The Roadmap view's script: put after the page's own script by `page.html.ts`, so it uses the
 * page's helpers (`el`, `post`, `openThread`, `dragOf`, `dropInto`, `goTo`) as they are.
 *
 * The project's goals, then its sprints in a row: the ones reached, quiet; the one being played,
 * open; the ones planned, each with its Play; and the threads in no sprint. A thread row opens its
 * ticket, and dragged onto another sprint it moves there, as the Backlog view's rows do. Inside
 * the string: no backticks and no `${`.
 */

export const ROADMAP_JS = String.raw`
// ---- the roadmap: the goals, and the sprints in order, reached, playing and to come

// Where the project is going, as a small block of its own: a quiet heading, what it is for, then
// one line for each thing it is heading towards. Where nothing is set, how to set it.
function goalsNode(b) {
  const g = b.goals;
  if (!g) return el('div', { class: 'rgoals none' }, 'No goals set for this project. Say where it is heading to an agent, or: ', el('code', {}, 'spool goals --edit -'));
  return el('section', { class: 'rgoals', 'aria-label': 'Goals' },
    el('h3', {}, 'Goals'),
    g.for && el('div', { class: 'rfor' }, el('span', { class: 'rlabel' }, 'For: '), inline(g.for)),
    g.towards.length > 0 && el('ul', { class: 'rtowards' }, g.towards.map((t) => el('li', {}, inline(t)))));
}

// Which of the goals a sprint is for, where it says so: one quiet line on its card.
const servesNode = (s) => s.serves && el('div', { class: 'serves', title: 'The goal this sprint serves' }, 'serves ', inline(s.serves));

// What a thread is doing, said the way the board says it, for a row on the roadmap.
function rowState(c) {
  if (c.done) return el('span', { class: 'state done' }, 'Done');
  if (c.question || (c.waiting && (c.waiting.kind === 'you' || c.waiting.kind === 'stuck'))) return el('span', { class: 'state you' }, 'Needs you');
  if (c.column === 'building') return el('span', { class: 'state building' }, el('span', { class: 'pulse' }), 'Building');
  if (c.column === 'build') return el('span', { class: 'state build' }, 'In build');
  return el('span', { class: 'state' }, 'In backlog');
}

// One thread in a sprint, in a line: its state and its name. It opens its ticket, and it can be dragged to another sprint.
function roadRow(c) {
  const moves = !c.done && c.column !== 'building';
  const node = el('div', { class: 'rrow', draggable: moves && 'true', 'data-id': c.id, title: c.title, onclick: () => openThread(c.id) },
    rowState(c), el('span', { class: 'rtitle' }, c.title));
  if (moves) dragOf(node, c, 'row');
  return node;
}

const MONTH_DAY = (at) => { const d = new Date(at); return isNaN(d) ? '' : MONTHS[d.getMonth()] + ' ' + d.getDate(); };
const threadCount = (n) => n + (n === 1 ? ' thread' : ' threads');

// A sprint reached: quiet, its name, the version it became, when, and how many threads.
function reachedLane(s) {
  return el('section', { class: 'lane past', 'data-sprint': s.id, 'aria-label': s.name },
    el('div', { class: 'lhead' }, el('span', { class: 'gname' }, s.name), s.version && el('span', { class: 'chip' }, 'v' + s.version)),
    servesNode(s),
    el('div', { class: 'gmeta' }, [s.reached && 'Reached ' + MONTH_DAY(s.reached), threadCount(s.total)].filter(Boolean).join(' · ')),
    el('button', { class: 'act', onclick: () => openReview(s.id) }, 'Review'));
}

// What a sprint is for, as the Backlog view words it: its goal, the reason, and when it is done.
function forNode(s, all) {
  return el('div', { class: 'about' },
    s.goal && el('div', {}, el('b', {}, 'Goal '), s.goal),
    all && s.why && el('div', {}, el('b', {}, 'Why '), s.why),
    all && s.doneWhen && el('div', {}, el('b', {}, 'Done when '), s.doneWhen));
}

function progressNode(s) {
  return el('div', { class: 'rprog' },
    el('span', { class: 'prog' }, el('i', { style: 'width: ' + (s.total ? Math.round((100 * s.done) / s.total) : 0) + '%' })),
    el('span', { class: 'gmeta' }, s.done + ' of ' + s.total + ' done'));
}

// Play: the same press as the Backlog view's, everything in the sprint not yet in build moves there.
const playNode = (s, words) => el('button', { class: 'go', title: 'Everything in it moves to Build', onclick: () => post('play', { id: s.id }, s.name + ' is running') }, words);

// The sprint being played: open and in front, with his words for it, how far along it is, and every thread in it.
function playingLane(s, rows) {
  return dropInto(el('section', { class: 'lane now', 'data-sprint': s.id, 'aria-label': s.name },
    el('div', { class: 'lhead' }, el('span', { class: 'gname' }, s.name), el('span', { class: 'state running' }, 'Playing'),
      el('span', { class: 'push' }, s.waiting > 0 && playNode(s, '▶ Play ' + s.waiting + ' more'))),
    servesNode(s),
    s.vision && el('blockquote', { class: 'vision' }, s.vision),
    forNode(s, true),
    progressNode(s),
    el('div', { class: 'rrows' }, rows.length ? rows.map(roadRow) : el('div', { class: 'empty' }, 'Nothing in it yet.')),
    s.done > 0 && el('button', { class: 'act', onclick: () => openReview(s.id) }, 'Review so far')), s.id);
}

// A sprint still to come: its goal, how much is in it, and its Play.
function plannedLane(s, rows) {
  const sizes = SIZES.map(([key]) => [key, rows.filter((c) => c.size === key).length]).filter(([, n]) => n);
  return dropInto(el('section', { class: 'lane', 'data-sprint': s.id, 'aria-label': s.name },
    el('div', { class: 'lhead' }, el('span', { class: 'gname' }, s.name), el('span', { class: 'state' }, 'Planned')),
    servesNode(s),
    forNode(s, false),
    el('div', { class: 'gmeta' }, s.total ? threadCount(s.total) : 'Empty: drag threads here',
      sizes.length > 0 && [' · ', sizes.map(([key, n], i) => [i > 0 && ' ', el('span', { class: 'size', title: n + ' ' + SIZES.find((x) => x[0] === key)[1].toLowerCase() }, (n > 1 ? n + '×' : '') + key.toUpperCase())])]),
    rows.length > 0 && el('div', { class: 'rrows' }, rows.map(roadRow)),
    s.waiting > 0 && el('div', { class: 'acts' }, playNode(s, '▶ Play sprint'))), s.id);
}

function drawRoadmap(b) {
  const box = document.getElementById('roadmap');
  if (reviewing) return drawReview(b, box);
  // A sprint's threads in the order they go: what is done, what is being built, what is in build, what waits.
  const rank = (c) => ['done', 'building', 'build', 'proposed'].indexOf(c.column);
  const inSprint = (s) => everyCard(b).filter((c) => c.sprint === s.id).map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
  const reached = b.sprints.filter((s) => s.status === 'done');
  const playing = b.sprints.filter((s) => s.status === 'running');
  const planned = b.sprints.filter((s) => s.status === 'planned');
  const loose = b.columns.proposed.filter((c) => !c.sprint);
  box.replaceChildren(goalsNode(b),
    el('div', { class: 'lanes' },
      reached.map(reachedLane),
      playing.map((s) => playingLane(s, inSprint(s))),
      planned.map((s) => plannedLane(s, inSprint(s))),
      dropInto(el('section', { class: 'lane past loose', 'aria-label': 'In no sprint' },
        el('div', { class: 'lhead' }, el('span', { class: 'gname' }, 'In no sprint')),
        el('button', { class: 'act', title: 'Open the Backlog view', onclick: () => goTo('backlog') }, threadCount(loose.length) + ' in the backlog')), '')),
    b.sprints.length ? '' : el('div', { class: 'empty' }, 'No sprints yet. Make one in the Backlog view, or ask an agent to plan one with you.'));
}
`;
