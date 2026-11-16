/**
 * Every project on one page: a page started in a folder of projects lists them all on its board,
 * shows any one of them by name, and does what is done on one project's board to that project only.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

/** A folder of three projects: the top one and two below it, each with a spool of its own. */
function studio(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio', '--gate');
  s.cd('games/sky_hop').sp('init', '--gate');
  s.cd('apps/tidy_up').sp('init', '--gate');
  return s;
}

test('a page started over several projects knows them all, and each board is that project\'s alone', async () => {
  const s = studio();
  const game = s.cd('games/sky_hop');
  const app = s.cd('apps/tidy_up');
  const jump = game.id('task', 'Tighten the jump arc');
  const coins = game.id('task', 'Readable coins');
  game.sp('build', coins);
  const chores = app.id('task', 'Weekly chores');
  app.sp('ask', 'Sunday or Monday?', '--option', 'Sunday', '--option', 'Monday', '--for', chores);
  const top = s.id('task', 'A shared logo');

  const page = await startPage(s);
  try {
    const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(page.url)).text())![1]!;
    const board = async (query = '') => (await (await fetch(`${page.url}api/board${query}`)).json()) as Record<string, any>;
    const post = (action: string, body: unknown) =>
      fetch(`${page.url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });

    // The list: every project, where it is from the top, and what it holds.
    let b = await board();
    assert.equal(b.project, 'studio', 'with no project named, the board is the top one\'s, as it always was');
    assert.equal(b.workspace.current, 'studio');
    assert.equal(b.workspace.opens, '', 'started at the top, the page opens on all of them');
    assert.deepEqual(
      b.workspace.projects.map((p: any) => [p.name, p.folder, p.counts, p.built]),
      [
        ['studio', '', { backlog: 1, build: 0, building: 0, check: 0, needs: 0 }, true],
        ['apps/tidy_up', 'apps/tidy_up', { backlog: 1, build: 0, building: 0, check: 0, needs: 1 }, true],
        ['games/sky_hop', 'games/sky_hop', { backlog: 1, build: 1, building: 0, check: 0, needs: 0 }, true],
      ],
    );
    assert.deepEqual(b.workspace.projects[1].needs.map((n: any) => n.title), ['Sunday or Monday?']);
    assert.deepEqual(b.columns.proposed.map((c: any) => c.id), [top], 'the top board holds the top project\'s threads only');

    // Named in the address, another project's board, and only its own threads.
    b = await board('?project=games/sky_hop');
    assert.equal(b.project, 'games/sky_hop');
    assert.equal(b.workspace.current, 'games/sky_hop');
    assert.deepEqual([b.columns.proposed.map((c: any) => c.id), b.columns.build.map((c: any) => c.id)], [[jump], [coins]]);
    // A name not on the list is not looked for: the page's own board comes back.
    assert.equal((await board('?project=../../etc')).workspace.current, 'studio');
    assert.equal((await board('?project=sky')).workspace.current, 'studio', 'only the exact name: no guessing');

    // An action on Sky Hop's board changes Sky Hop's spool, and nobody else's.
    assert.equal((await post('move', { project: 'games/sky_hop', id: jump, to: 'build' })).status, 200);
    assert.equal(game.json('show', jump).item.state, 'ready');
    assert.equal((await post('add', { project: 'games/sky_hop', to: 'proposed', text: 'A daily challenge level' })).status, 200);
    assert.equal((await post('note', { project: 'games/sky_hop', text: 'a mute button' })).status, 200);
    assert.equal((await post('sprint', { project: 'games/sky_hop', name: 'Polish' })).status, 200);
    b = await board('?project=games/sky_hop');
    assert.ok(b.columns.proposed.some((c: any) => c.title === 'A daily challenge level'), 'added to Sky Hop');
    assert.deepEqual(b.needs.notes.map((n: any) => n.text), ['a mute button'], 'the note is in Sky Hop\'s inbox');
    assert.equal(b.sprints.length, 1);
    const studioBoard = await board('?project=studio');
    assert.deepEqual([studioBoard.columns.proposed.map((c: any) => c.id), studioBoard.needs.notes, studioBoard.sprints], [[top], [], []], 'the top project is untouched');
    const appBoard = await board('?project=apps/tidy_up');
    assert.deepEqual([appBoard.columns.proposed.map((c: any) => c.id), appBoard.needs.notes, appBoard.sprints], [[chores], [], []], 'and so is Tidy Up');

    // A thread of one project is not moved from another's board, and a project not on the list is refused.
    const refused = await post('move', { project: 'apps/tidy_up', id: jump, to: 'proposed' });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { text: string }).text, /another project's/);
    assert.equal(game.json('show', jump).item.state, 'ready', 'not moved');
    assert.equal((await post('move', { project: '/tmp', id: chores, to: 'build' })).status, 400);
    assert.equal(app.json('show', chores).item.state, 'proposed');

    // Who builds is each project's own pick.
    assert.equal((await post('builder', { project: 'apps/tidy_up', builder: 'chat' })).status, 200);
    assert.equal((await board('?project=apps/tidy_up')).runner.builder, 'chat');
    assert.equal((await board('?project=games/sky_hop')).runner.builder, 'headless');
    assert.equal((await board()).runner.builder, 'headless');

    // The home view's brief, across every project, comes only when the home view asks for it.
    assert.equal((await board()).workspace.brief, null);
    const home = await board('?home=1');
    assert.deepEqual(home.workspace.brief.needsYou.questions.map((q: any) => [q.title, q.project]), [['Sunday or Monday?', 'apps/tidy_up']]);
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('a page started for one project builds that one only, and says so on the others', async () => {
  const s = studio();
  const page = await startPage(s, '--project', 'sky_hop');
  try {
    const b = (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
    assert.equal(b.project, 'games/sky_hop');
    assert.equal(b.workspace.opens, 'games/sky_hop', 'it opens on its own project');
    assert.deepEqual(b.workspace.projects.map((p: any) => [p.name, p.built]), [['studio', false], ['apps/tidy_up', false], ['games/sky_hop', true]]);
    const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(page.url)).text())![1]!;
    const refused = await fetch(`${page.url}api/runner`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify({ project: 'studio', on: true }) });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { text: string }).text, /run by its own page, or a chat/);
  } finally {
    await page.stop();
    s.cleanup();
  }
});

test('with one project, the board carries it alone', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const page = await startPage(s);
  try {
    const b = (await (await fetch(`${page.url}api/board`)).json()) as Record<string, any>;
    assert.deepEqual(b.workspace.projects.map((p: any) => p.name), ['skyhop']);
    assert.equal(b.workspace.opens, 'skyhop', 'nothing to open but its own board');
    assert.equal(b.workspace.brief, null);
  } finally {
    await page.stop();
    s.cleanup();
  }
});
