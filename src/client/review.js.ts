/**
 * A sprint's review: put after the page's own script by `page.html.ts`, and drawn in the Roadmap
 * view's place while it is open, with a link back to it.
 *
 * It is a page of its own rather than a box over the board: it is read top to bottom, thread by
 * thread, and a thread's ticket opens over it the way a ticket opens over the board, which a box
 * already over the page could not take. Its data is asked of `/api/review` when it opens, and again
 * only when something in the sprint changed on the board. The steps he ticks are his own, kept in
 * this browser, not in the spool. Inside the string: no backticks and no `${`.
 */

export const REVIEW_JS = String.raw`
// ---- a sprint's review: what it was for, what shipped and how to check each, and its approval

// The sprint being reviewed, if one is, and what the server said of it.
let reviewing = null;
let reviewData = null;
let reviewFor = '';
let reviewAsked = '';
{
  const named = /[?&]review=(r-[a-z0-9]+)\b/.exec(location.search);
  if (named) { reviewing = named[1]; view = 'roadmap'; }
}
// A link to the review names it, so a reload comes back to it.
function reviewUrl() {
  const params = new URLSearchParams(location.search);
  if (reviewing) { params.set('view', 'roadmap'); params.set('review', reviewing); }
  else if (params.has('review')) { params.delete('review'); params.delete('view'); }
  const search = params.toString();
  history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash);
}
function openReview(id) { reviewing = id; reviewData = null; reviewFor = reviewAsked = ''; reviewUrl(); window.scrollTo(0, 0); redraw(); }
function closeReview() { reviewing = null; reviewData = null; reviewUrl(); redraw(); }
// A tab pressed is a view asked for as itself: the Roadmap tab, from a review, goes back to the roadmap.
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => { if (reviewing) closeReview(); });

// What on the board would change the review: its threads' places and marks, the calls waiting, the sprint's state.
function reviewKey(b, s) {
  const cards = everyCard(b).filter((c) => c.sprint === s.id).map((c) => c.id + ':' + c.column + ':' + c.complete).sort().join(' ');
  return [s.status, s.version, s.done, s.total, cards, b.needs.calls.map((x) => x.id).join(' ')].join('|');
}
async function askReview(id, key) {
  reviewAsked = key;
  try {
    const res = await fetch('/api/review?id=' + id);
    if (!res.ok) throw new Error('no review');
    const r = await res.json();
    if (reviewing !== id) return;
    reviewData = r;
    reviewFor = key;
    redraw();
  } catch (e) {
    reviewAsked = '';
    say('The review could not be read.');
  }
}

// The steps he has ticked on a thread, as their words: his, kept in this browser, gone with nothing else.
const tickKey = (id) => 'spool-ticks:' + id;
function ticksOf(id) {
  try { return JSON.parse(localStorage.getItem(tickKey(id)) || '[]'); } catch (e) { return []; }
}
function tick(id, step, on) {
  const now = ticksOf(id).filter((x) => x !== step);
  if (on) now.push(step);
  try { if (now.length) localStorage.setItem(tickKey(id), JSON.stringify(now)); else localStorage.removeItem(tickKey(id)); } catch (e) {}
}
function tickList(t) {
  const done = ticksOf(t.id);
  return el('ol', { class: 'ticks' }, t.steps.map((step) => {
    const box = el('button', { class: 'box', role: 'checkbox', 'aria-checked': String(done.includes(step)), 'aria-label': step });
    const row = el('li', { class: done.includes(step) ? 'on' : '' }, box, el('span', {}, inline(step)));
    const flip = () => {
      const on = box.getAttribute('aria-checked') !== 'true';
      tick(t.id, step, on);
      box.setAttribute('aria-checked', String(on));
      row.classList.toggle('on', on);
    };
    box.addEventListener('click', flip);
    row.lastChild.addEventListener('click', flip);
    return row;
  }));
}

// A call an agent made on the thread: what it chose and why, with Fine and Overrule until he has looked.
function reviewCall(call) {
  return el('div', { class: 'rcall', 'data-call': call.id },
    el('div', {}, el('b', {}, 'Decided: '), call.choice),
    el('div', { class: 'note' }, call.title),
    call.why && el('div', { class: 'note' }, 'Why: ' + call.why),
    call.status === 'assumed' ? callActs(call)
      : call.status === 'overruled' ? el('span', { class: 'badge ask' }, 'You overruled it: ' + call.instead)
      : call.status === 'fine' ? el('span', { class: 'badge' }, '✓ Fine by you') : el('span', { class: 'badge' }, 'Dropped'));
}

const STATE_WORDS = { done: 'Done', active: 'Building', stale: 'Gone quiet', ready: 'In build', blocked: 'Waiting', held: 'On hold', proposed: 'In backlog', archived: 'Archived' };

function reviewThread(t, b) {
  const c = everyCard(b).find((x) => x.id === t.id);
  const open = () => { if (c) openThread(t.id); };
  return el('div', { class: 'card rthread', 'data-id': t.id },
    el('div', { class: 'rtop' }, el('span', { class: 'title', onclick: open }, t.title),
      el('span', { class: 'push' }),
      t.complete ? el('span', { class: 'chip ok' }, '✓ Complete') : el('span', { class: 'state ' + (t.state === 'done' ? 'done' : t.state === 'active' ? 'building' : '') }, STATE_WORDS[t.state] || t.state)),
    t.summary && el('div', { class: 'note' }, inline(t.summary)),
    t.steps.length > 0 && el('div', { class: 'rpart' }, el('div', { class: 'label' }, 'To check'), tickList(t)),
    t.calls.length > 0 && el('div', { class: 'rpart' }, el('div', { class: 'label' }, t.calls.length === 1 ? 'A call its agent made' : 'Calls its agent made'), t.calls.map(reviewCall)),
    el('div', { class: 'meta' },
      el('span', { class: 'key', title: 'Copy the id', onclick: () => copyId(t.id) }, t.id),
      c && el('button', { class: 'act', onclick: open }, 'Ticket'),
      c && t.commits > 0 && el('button', { class: 'act', onclick: () => { openThread(t.id); if (!showing.has(t.id)) showChanges(t.id); } },
        'Changes' + (t.files ? ' · ' + t.files + (t.files === 1 ? ' file' : ' files') : ''))));
}

// How long, said as a person would: 40m, 3h, 2d.
function spanOf(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  if (m < 2880) return Math.round(m / 60) + 'h';
  return Math.round(m / 1440) + 'd';
}

function drawReview(b, box) {
  const s = b.sprints.find((x) => x.id === reviewing);
  if (!s) { reviewing = null; reviewUrl(); return drawRoadmap(b); }
  const key = reviewKey(b, s);
  if (key !== reviewFor && key !== reviewAsked) askReview(s.id, key);
  const r = reviewData && reviewData.sprint.id === s.id ? reviewData : null;
  const back = el('button', { class: 'history back', onclick: closeReview }, '‹ Roadmap');
  if (!r) { box.replaceChildren(back, el('div', { class: 'empty' }, 'Reading the sprint…')); return; }
  const reached = r.sprint.status === 'done';
  const all = r.done === r.total && r.total > 0;
  const headline = (reached ? threadCount(r.total) + ' shipped' : r.done + ' of ' + threadCount(r.total) + ' done so far')
    + (r.took >= 60000 ? ', over ' + spanOf(r.took) : '')
    + (r.files ? ' · ' + r.files + (r.files === 1 ? ' file' : ' files') + ' changed' : '');
  const left = r.toApprove.threads.length + r.toApprove.calls.length;
  box.replaceChildren(el('div', { class: 'review' },
    back,
    el('div', { class: 'lhead' }, el('h2', {}, r.sprint.name),
      el('span', { class: 'state ' + (reached ? 'done' : 'running') }, reached ? 'Reached' : 'So far'),
      r.sprint.version && el('span', { class: 'chip' }, 'v' + r.sprint.version)),
    r.sprint.vision ? el('blockquote', { class: 'vision' }, r.sprint.vision) : r.sprint.goal && el('div', { class: 'rgoal' }, r.sprint.goal),
    el('div', { class: 'about' },
      r.sprint.vision && r.sprint.goal && el('div', {}, el('b', {}, 'Goal '), r.sprint.goal),
      r.sprint.doneWhen && el('div', {}, el('b', {}, 'Done when '), r.sprint.doneWhen,
        el('span', { class: all ? 'plus' : '' }, all ? '  ✓ every thread in it is done: see if it holds' : '  · not yet: ' + (r.total - r.done) + ' to go')),
      r.sprint.serves && el('div', {}, el('b', {}, 'Serves '), r.sprint.serves)),
    el('div', { class: 'rhead' }, headline),
    r.threads.map((t) => reviewThread(t, b)),
    r.undone.length > 0 && [el('h3', {}, 'Undone or stopped along the way'),
      el('div', { class: 'rundone' }, r.undone.map((u) => el('div', { class: 'note' }, el('span', { class: 'title', onclick: () => { if (everyCard(b).some((c) => c.id === u.id)) openThread(u.id); } }, u.title), ': ' + u.what + ' · ' + MONTH_DAY(u.at))))],
    el('div', { class: 'finish' },
      left > 0
        ? el('button', { class: 'go', onclick: () => post('approve-sprint', { id: r.sprint.id }, 'Approved: ' + r.sprint.name) }, 'Approve the sprint')
        : el('div', { class: 'ok' }, r.done ? '✓ Everything finished in it is approved' : 'Nothing in it is finished yet.'),
      left > 0 && el('div', { class: 'note' }, [r.toApprove.threads.length && threadCount(r.toApprove.threads.length) + ' marked complete', r.toApprove.calls.length && r.toApprove.calls.length + (r.toApprove.calls.length === 1 ? ' call' : ' calls') + ' accepted'].filter(Boolean).join(', ') + '.'),
      !r.sprint.version && el('div', { class: 'note' }, reached ? 'It has no version yet: the loop cuts one when a sprint is reached.' : 'When it is reached, the loop cuts its version.'))));
}
`;
