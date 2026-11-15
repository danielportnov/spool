import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/** A folder of projects, the way a studio keeps them: some with a spool, some without. */
function studio(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  s.write('games/sky_hop/README.md', '# Sky Hop\n\nA platformer about hopping between clouds.\n');
  assert.match(s.cd('games/sky_hop').sp('init'), /sits under .* and shows up there as a project/);
  s.cd('apps/tidy_up').sp('init', '--about', 'A chore tracker');
  s.cd('sites/plain').write('index.html', '<html>');
  // Projects are never looked for inside dependency or build directories.
  s.cd('games/sky_hop/node_modules/dep').sp('init');
  return s;
}

test('a workspace is the spool you are in plus every spool below it', () => {
  const s = studio();
  const status = s.json('status');
  assert.deepEqual(
    status.projects.map((p: { name: string }) => p.name),
    ['studio', 'apps/tidy_up', 'games/sky_hop'],
  );
  assert.match(s.sp('init'), /already set up in studio\. Nothing was changed/);
  assert.match(s.sp('init', 'sky hop'), /already set up in sky_hop {2}· games\/sky_hop\. Nothing was changed/);
  s.cleanup();
});

test('feedback captured at the top is routed into the right project', () => {
  const s = studio();
  const captured = s.json('capture', 'in Sky Hop the jump feels floaty');
  assert.deepEqual(captured.projects, ['games/sky_hop'], 'the project is recognised from what was said');
  assert.equal(captured.note.project, 'studio');

  // Projects answer to the names people actually say.
  const game = s.cd('games/sky_hop');
  for (const said of ['games/sky_hop', 'sky_hop', 'Sky Hop', 'sky']) {
    const id = s.id('task', `Filed via ${said}`, '--from', captured.note.id, '-P', said);
    assert.ok(game.exists(`.spool/items/${id}.md`), `${said} → games/sky_hop`);
    assert.ok(game.item(id).includes('> in Sky Hop the jump feels floaty'), 'the quote travels with the task');
  }
  assert.match(s.fails('task', 'x', '-P', 'nope'), /no project "nope"[\s\S]*Projects here: studio, apps\/tidy_up, games\/sky_hop/);
  s.cleanup();
});

test('the view is scoped to where you stand', () => {
  const s = studio();
  const game = s.cd('games/sky_hop');
  const app = s.cd('apps/tidy_up');
  const gameTask = game.id('task', 'Game task', '-p', '1');
  const appTask = app.id('task', 'App task', '-p', '0');

  // From the top: everything, most urgent first, and it says where to work.
  const next = s.json('next');
  assert.equal(next.task.id, appTask);
  assert.equal(next.task.project, 'apps/tidy_up');
  assert.ok(next.brief.includes(`work in ${app.dir}`));
  assert.equal(s.json('next', '-P', 'sky_hop').task.id, gameTask);

  // From inside a project: only that project, addressed by its own name.
  assert.equal(game.json('next').task.id, gameTask);
  assert.deepEqual(game.json('status').projects.map((p: { name: string }) => p.name), ['sky_hop']);
  assert.match(game.fails('show', appTask), /no item/);

  // Items are found from the top wherever they live, and a question lands beside its task.
  const question = s.id('ask', 'Which font?', '--option', 'Serif', '--option', 'Sans', '--for', gameTask);
  assert.ok(game.exists(`.spool/items/${question}.md`));
  assert.match(s.sp('status'), /1 question blocking 1 task/);
  s.cleanup();
});

test('the recorder is briefed with the projects and what is waiting', () => {
  const s = studio();
  s.cd('games/sky_hop').sp('task', 'One open thing');
  s.sp('ask', 'Ship on Friday?', '--option', 'Yes', '--option', 'No');
  s.sp('capture', 'something unfiled');
  const brief = s.sp('prime', 'recorder');
  assert.match(brief, /# Spool · recorder protocol/);
  assert.match(brief, /apps\/tidy_up +0 open {2}· A chore tracker/);
  assert.match(brief, /games\/sky_hop +1 open {2}· A platformer about hopping between clouds\./);
  assert.match(brief, /WAITING ON THE HUMAN\n.*Ship on Friday\?\n\s+1\) Yes {2}2\) No/);
  assert.match(brief, /INBOX {2}1 unfiled/);

  // A recorder that has the rules from its skill asks only for what is true here.
  const context = s.sp('prime', 'recorder', '--context');
  assert.match(context, /^PROJECTS\n/);
  assert.match(context, /WAITING ON THE HUMAN\n.*Ship on Friday\?/);
  assert.doesNotMatch(context, /recorder protocol|## For every piece/);

  const worker = s.sp('prime');
  assert.match(worker, /# Spool · worker protocol/);
  assert.match(worker, /POLICY \(\.spool\/policy\.md\)[\s\S]*## Ask first/);
  assert.match(worker, /games\/sky_hop\/\.spool\/policy\.md/);
  assert.match(s.fails('prime', 'manager'), /no role "manager"/);
  s.cleanup();
});

test('outside any spool, it says how to start one', () => {
  const s = new Sandbox();
  assert.match(s.fails('status'), /no \.spool\/ here or in any parent directory[\s\S]*spool init/);
  assert.match(s.sp(), /the engine under the Spool skills[\s\S]*\/spool-help/, 'bare `spool` prints help');
  s.sp('init');
  assert.match(s.sp(), /nothing is waiting on you/, 'and status once there is a spool');
  s.cleanup();
});
