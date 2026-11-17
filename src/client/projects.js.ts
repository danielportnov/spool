/**
 * Every project on one page: the switcher in the bar, and the home view of them all.
 *
 * A page started in a folder of projects knows them all (`workspace` on the board). With more
 * than one, the project's name in the bar opens a menu of them, and the address says which one
 * is shown (`?project=<name>`), so a link opens the right board. With no project named, a page
 * started at the top opens on "All projects": a row for each, and the brief across them. Plain
 * browser JavaScript, joined after `page.js.ts` into the same script, using its `el()`, `post()`
 * and the board it holds. Inside the string: no backticks and no `${`.
 *
 * What runs before the first board arrives (`boardUrl`, `withProject`) reads only the address, so
 * nothing here is asked for before it is set.
 */

export const PROJECTS_JS = String.raw`
// ---- every project on one page

// The project the address names, if it names one.
function chosenProject() { return new URLSearchParams(location.search).get('project') || ''; }
// Asked for all of them, on a page started for one: the address says so, as it names a project.
function allAsked() { return new URLSearchParams(location.search).has('all'); }

// Where the board is asked for: the project the address names, or the page's own. The home view,
// once the page knows it is up, also asks for the brief across every project.
function boardUrl() { return '/api/board' + (chosenProject() ? projectQuery() : current && atHome(current) ? '?home=1' : ''); }
// How a link names the project it was copied on, so it opens on the same board.
function projectQuery() { const p = chosenProject(); return p ? '?project=' + encodeURIComponent(p) : ''; }
// Everything the page does is for the project it is showing: its name goes with each POST, and
// the server checks it against its own list.
function withProject(body) {
  const p = chosenProject();
  return p ? Object.assign({ project: p }, body) : body;
}

function severalOf(b) { return !!b.workspace && b.workspace.projects.length > 1; }
// Whether the home view is up: several projects, and none named in the address.
function atHome(b) { return severalOf(b) && !chosenProject() && (b.workspace.opens === '' || allAsked()); }
function shownProject(b) { return b.workspace ? b.workspace.projects.find((p) => p.name === b.workspace.current) : null; }

// A board that arrives for another project than the address now names is an old answer: it is not drawn.
// A name the workspace does not have is taken out of the address, and the page's own is shown.
function fromHere(b) {
  if (!b.workspace) return true;
  const p = chosenProject();
  if (!p) return true;
  if (!b.workspace.projects.some((x) => x.name === p)) {
    const params = new URLSearchParams(location.search);
    params.delete('project');
    const search = params.toString();
    history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash);
    return true;
  }
  return b.workspace.current === p;
}

let menuOpen = false;
function closeMenu() { if (menuOpen) { menuOpen = false; redraw(); } }

// Show another project, or all of them, without loading the page again. The address says which,
// beside the view it already names; a ticket that is opened goes after it.
function goProject(name, id) {
  const params = new URLSearchParams(location.search);
  params.delete('all');
  params.delete('project');
  if (name) params.set('project', name);
  else if (current && current.workspace && current.workspace.opens) params.set('all', '1');
  const search = params.toString();
  history.pushState(null, '', location.pathname + (search ? '?' + search : '') + (id ? '#' + id : ''));
  enterProject(id);
}
function enterProject(id) {
  menuOpen = false;
  openId = id || null;
  only = null;
  adding = null;
  last = '';
  load(true);
}
window.addEventListener('popstate', () => enterProject(/^#t-[a-z0-9]+$/.test(location.hash) ? location.hash.slice(1) : null));
document.addEventListener('click', (e) => { if (menuOpen && !e.target.closest('.pswitch, .pmenu')) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (!menuOpen || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeMenu();
  const button = document.querySelector('.pswitch');
  if (button) button.focus();
}, true);

const plural = (k, one, many) => k + ' ' + (k === 1 ? one : many || one + 's');
// What a project holds, in a few words: what is moving first.
function countsOf(p) {
  const c = p.counts;
  return [c.building && c.building + ' building', c.build && c.build + ' in build', c.check && c.check + ' to check', c.backlog && c.backlog + ' in backlog']
    .filter(Boolean).join(' · ') || 'Nothing open';
}
const needsNode = (p) => p.counts.needs > 0 && el('span', { class: 'pneeds', title: plural(p.counts.needs, 'thing waits', 'things wait') + ' on you' }, p.counts.needs + ' need' + (p.counts.needs === 1 ? 's' : '') + ' you');

function menuNode(b, home) {
  const w = b.workspace;
  const item = (name, label, sub, on, needs, go) => el('button', { class: 'pitem' + (on ? ' on' : ''), role: 'menuitemradio', 'aria-checked': String(on), 'data-project': name, onclick: go },
    el('span', { class: 'pname' }, label, needs), el('span', { class: 'psub' }, sub));
  const waits = w.projects.reduce((k, p) => k + p.counts.needs, 0);
  return el('div', { class: 'pmenu', role: 'menu', 'aria-label': 'Projects' },
    item('', 'All projects', plural(w.projects.length, 'project'), home, waits > 0 && el('span', { class: 'pneeds' }, waits + ' need' + (waits === 1 ? 's' : '') + ' you'), () => goProject('')),
    el('div', { class: 'psep' }),
    w.projects.map((p) => item(p.name, p.name, countsOf(p), !home && p.name === w.current, needsNode(p), () => goProject(p.name))));
}

// The project in the bar, as a switcher where there is more than one. With one, nothing changes.
function drawSwitcher(b, home) {
  const old = document.querySelector('.pmenu');
  if (old) old.remove();
  if (!severalOf(b)) return;
  const waits = b.workspace.projects.reduce((k, p) => k + p.counts.needs, 0);
  document.getElementById('project').replaceChildren(el('button', { class: 'pswitch', 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), title: 'Show another project',
    onclick: () => { menuOpen = !menuOpen; redraw(); } },
    el('span', { class: 'pnow' }, home ? 'All projects' : b.project),
    home && waits > 0 && el('span', { class: 'pdot', title: plural(waits, 'thing waits', 'things wait') + ' on you' }),
    el('span', { class: 'pcaret', 'aria-hidden': 'true' })));
  if (menuOpen) document.querySelector('.bar').append(menuNode(b, home));
}

// Draws the switcher, and the home view where it is up. True when it is: the board is not drawn then.
function drawProjects(b) {
  const home = atHome(b);
  drawSwitcher(b, home);
  let box = document.getElementById('home');
  if (!box) {
    box = el('main', { id: 'home', hidden: true });
    document.getElementById('board').before(box);
  }
  box.hidden = !home;
  document.body.classList.toggle('at-home', home);
  if (!home) { box.replaceChildren(); return false; }
  drawHome(b, box);
  return true;
}

// Where a project's agents are not this page's to run, the switch says so in one quiet line instead.
function drawElsewhere(b) {
  const p = shownProject(b);
  const away = !!p && !p.built;
  const runner = document.getElementById('runner');
  if (!away) {
    if (runner && severalOf(b) && b.workspace.opens === '' && b.runner.builder !== 'chat') runner.title += ' It builds every project on this page.';
    return;
  }
  // Its agents are another page's, or a chat's: the status says so, in place of theirs.
  document.getElementById('status').replaceChildren(el('span', { id: 'elsewhere', class: 'elsewhere' }, 'Agents for ' + b.project + ' are run by its own page, or a chat.'));
}

// ---- the home view: a row for each project, and the brief across them all

function homeBrief(r) {
  if (!r) return null;
  const n = r.needsYou;
  const line = (mark, title, project, sub, id) => el('button', { class: 'hline', onclick: () => goProject(project, id) },
    el('span', { class: 'htitle' }, mark + ' ' + title), el('span', { class: 'psub' }, project + (sub ? ' · ' + sub : '')));
  // A question is not listed here: it is asked on its thread alone, and the project's row counts it.
  const needs = [
    ...n.plans.map((t) => line('📋', 'Plan: ' + t.title, t.project, 'waits for your go-ahead', t.id)),
    ...n.stopped.map((t) => line('↺', t.title, t.project, t.why, t.id)),
  ];
  const worth = r.worthALook.map((t) => line('', t.title, t.project, t.reasons.join(' · '), t.id));
  return el('section', { class: 'hbrief', 'aria-label': 'While you were away' },
    el('div', { class: 'hhead' }, r.headline),
    needs.length > 0 && [el('h2', {}, 'Needs you', el('span', { class: 'count' }, String(needs.length))), needs],
    worth.length > 0 && [el('h2', {}, 'Worth a look', el('span', { class: 'count' }, String(worth.length))), worth]);
}

function homeRow(p) {
  const open = () => goProject(p.name);
  return el('article', { class: 'prow' + (p.counts.needs ? ' waits' : ''), 'data-project': p.name },
    el('button', { class: 'phead', onclick: open, title: 'Open the board of ' + p.name },
      el('span', { class: 'pname' }, p.name), needsNode(p), el('span', { class: 'psub' }, countsOf(p))),
    p.building.map((t) => el('div', { class: 'live' }, el('span', { class: 'pulse' }),
      el('span', { class: 'for' }, t.title), t.said && el('span', { class: 'now', title: t.said }, t.said))),
    p.needs.map((x) => el('div', { class: 'hneed' }, '📋 Plan: ' + x.title)),
    p.sprint && el('div', { class: 'hsprint' }, el('span', {}, '▶ ' + p.sprint.name),
      el('span', { class: 'hbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.sprint.total), 'aria-valuenow': String(p.sprint.done) },
        el('span', { style: 'width: ' + (p.sprint.total ? Math.round((100 * p.sprint.done) / p.sprint.total) : 0) + '%' })),
      el('span', { class: 'psub' }, p.sprint.done + '/' + p.sprint.total)),
    !p.built && el('div', { class: 'psub' }, 'Its agents are run by its own page, or a chat.'));
}

function drawHome(b, box) {
  const w = b.workspace;
  const waits = w.projects.reduce((k, p) => k + p.counts.needs, 0);
  const building = w.projects.some((p) => p.counts.building > 0);
  document.title = (waits ? '(' + waits + ') ' : '') + (building ? '● ' : '') + 'All projects';
  document.getElementById('where').textContent = '';
  document.getElementById('rule').hidden = true;
  document.getElementById('quick').replaceChildren();
  // The first look did not know the home view was up, so it carried no brief: ask again now, for it.
  if (!('brief' in w)) setTimeout(() => { last = ''; load(true); });
  box.replaceChildren(homeBrief(w.brief), el('div', { class: 'prows' }, w.projects.map(homeRow)));
}
`;
