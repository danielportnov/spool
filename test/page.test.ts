import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import { Sandbox, startPage } from './helpers.ts';

test('the page shows the spool as a board, and what is done on it is saved to the spool', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const question = s.json('review').questions[0].id;

  const { url, stop } = await startPage(s);
  try {
    // The page carries the token its own buttons need; nothing else on the machine is told it.
    const html = await (await fetch(url)).text();
    assert.match(html, /<title>Spool<\/title>\n<link rel="icon" href="data:image\/svg\+xml,[^"]*🧶/, 'the yarn is the page\'s icon');
    assert.doesNotMatch(html, /document\.title = '🧶/);
    const token = /const TOKEN = '([\w-]{20,})';/.exec(html)![1]!;
    const board = async () => (await (await fetch(`${url}api/board`)).json()) as Record<string, any>;
    const post = (action: string, body: unknown, headers: Record<string, string> = { 'x-spool-token': token }) =>
      fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Four columns, each thread in the one that says where it stands, numbered as the loop numbers them.
    let b = await board();
    assert.deepEqual([b.project, b.gate, b.version], ['skyhop', true, '1.4.2'], 'the version is the project\'s own');
    assert.deepEqual(Object.keys(b.columns), ['proposed', 'build', 'building', 'done']);
    assert.deepEqual(b.columns.proposed.map((c: any) => [c.n, c.id, c.title, c.difficulty, c.priority]), [[2, jump, 'Tighten the jump arc', 'Small', 'High']]);
    assert.deepEqual(b.columns.build.map((c: any) => [c.n, c.id]), [[1, coins]]);
    assert.deepEqual(b.columns.build[0].question, { id: question, title: 'Outline the coins, or turn them teal?', options: ['Outline', 'Teal'], recommend: 1 });

    // Pressing play is the human moving it to build, and it is on the record as theirs.
    assert.equal((await post('move', { id: jump, to: 'build' })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'ready');
    assert.match(s.item(jump), /human: moved to build/);
    assert.equal((await post('move', { id: jump, to: 'proposed' })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'proposed');

    // A note lands on the thread in their words; an idea with no thread waits in the inbox to be filed.
    assert.equal((await post('note', { id: coins, text: 'two pixels, not one -- and "bold"' })).status, 200);
    assert.match(s.item(coins), /> two pixels, not one -- and "bold"\n> — \[\[n-/);
    assert.equal((await post('note', { text: 'add a mute button to settings' })).status, 200);
    assert.match(s.sp('inbox'), /add a mute button to settings/);

    // + Add at the foot of a column makes a thread in that column: named from the first line, all the words kept.
    assert.equal((await post('add', { to: 'proposed', text: 'A daily challenge level\nwith its own leaderboard' })).status, 200);
    assert.equal((await post('add', { to: 'build', text: 'Fix the typo on the title screen' })).status, 200);
    b = await board();
    const daily = b.columns.proposed.find((c: any) => c.title === 'A daily challenge level');
    assert.ok(daily, 'added under Proposed, it is proposed');
    assert.match(s.item(daily.id), /> A daily challenge level\n> with its own leaderboard\n> — \[\[n-/);
    const typo = b.columns.build.find((c: any) => c.title === 'Fix the typo on the title screen');
    assert.ok(typo, 'added under Build, it is in build');
    assert.match(s.item(typo.id), /human: moved to build/);
    assert.equal((await post('add', { to: 'done', text: 'x' })).status, 400);
    assert.equal((await post('add', { to: 'build', text: '  ' })).status, 400);
    assert.doesNotMatch(html, /Add to the spool|id="idea"/, 'no add box at the top');
    assert.doesNotMatch(html, /also waiting for a look|Nothing is built until you move it to Build/, 'the header is the name and the version');
    assert.match(html, /'\+ Add'/);

    // A card opens as its thread: their words, each step and who took it, and what was asked along the way.
    b = await board();
    const coinsThread = b.columns.build.find((c: any) => c.id === coins).thread;
    assert.deepEqual(coinsThread.said.map((x: any) => x.text), ['two pixels, not one -- and "bold"']);
    assert.match(coinsThread.said[0].note, /^n-/);
    assert.deepEqual(coinsThread.steps.map((x: any) => x.who), ['human', 'agent']);
    assert.match(coinsThread.steps[0].what, /^moved to build$/);
    assert.deepEqual(coinsThread.questions.map((q: any) => [q.id, q.status]), [[question, 'open']]);

    // An answer unblocks the thread it was holding.
    assert.equal((await post('answer', { id: question, choice: '2' })).status, 200);
    assert.equal(s.json('show', question).item.choice, 'Teal');
    b = await board();
    assert.equal(b.columns.build[0].question, null);
    assert.equal(b.also.inbox, 1);

    // A ticket's fields are changed from the page: a new name, priority, difficulty, tags and a version.
    assert.equal((await post('edit', { id: jump, title: 'A snappier jump', priority: 0, size: 'm', tags: ['Level Design', 'feel'], version: '1.5' })).status, 200);
    const edited = s.json('show', jump).item;
    assert.deepEqual([edited.title, edited.priority, edited.size, edited.tags, edited.version], ['A snappier jump', 0, 'm', ['level-design', 'feel'], '1.5']);
    b = await board();
    const ticket = b.columns.proposed.find((c: any) => c.id === jump);
    assert.deepEqual([ticket.p, ticket.priority, ticket.size, ticket.difficulty, ticket.tags, ticket.version, ticket.column], [0, 'Urgent', 'm', 'Medium', ['level-design', 'feel'], '1.5', 'proposed']);
    assert.deepEqual([b.tags, b.versions], [['feel', 'level-design'], ['1.5']]);
    assert.equal((await post('edit', { id: jump, tags: [], version: '' })).status, 200);
    assert.deepEqual([s.json('show', jump).item.tags, s.json('show', jump).item.version], [[], undefined]);
    assert.equal((await post('edit', { id: jump, size: 'enormous' })).status, 400);
    assert.equal((await post('edit', { id: jump })).status, 400);

    // Finished work shows who built it, and "Mark as complete" is the human approving it.
    s.sp('start', coins, '--as', 'Claude Fable 5.2');
    s.sp('done', coins, '-m', 'Coins have a teal rim at sunset', '--as', 'Claude Fable 5.2');
    b = await board();
    const shipped = b.columns.done.find((c: any) => c.id === coins);
    assert.deepEqual([shipped.done, shipped.complete, shipped.thread.by, shipped.thread.summary], [true, false, 'Claude Fable 5.2', 'Coins have a teal rim at sunset']);
    assert.deepEqual(shipped.thread.steps.slice(-2).map((x: any) => [x.who, x.what]), [['Claude Fable 5.2', 'started'], ['Claude Fable 5.2', 'done: Coins have a teal rim at sunset']]);
    // The same story as a conversation: what they said, what Claude said back, and the moves in between.
    // (The page's server keeps real time and this test's own commands keep a made-up clock, so only
    // the order within each is checked.)
    const feed = shipped.thread.feed.map((p: any) => `${p.who} · ${p.kind} · ${p.text}`);
    assert.deepEqual([...feed].sort(), [
      'Claude Fable 5.2 · event · started',
      'Claude Fable 5.2 · shipped · Coins have a teal rim at sunset',
      'agent · asked · Outline the coins, or turn them teal?',
      'human · event · moved to build',
      'human · said · two pixels, not one -- and "bold"',
    ]);
    assert.ok(feed.indexOf('human · event · moved to build') < feed.indexOf('agent · asked · Outline the coins, or turn them teal?'));
    assert.ok(feed.indexOf('Claude Fable 5.2 · event · started') < feed.indexOf('Claude Fable 5.2 · shipped · Coins have a teal rim at sunset'));
    assert.match(html, /const CLAUDE = '<svg viewBox="0 0 24 24" fill="#D97757" role="img" aria-label="Claude"><path d="m4\.7144 15\.9555/, 'Claude is shown by its own mark');
    assert.equal((await post('complete', { id: coins })).status, 200);
    assert.ok(s.json('show', coins).item.reviewed, 'approved, as the human');
    assert.equal((await board()).columns.done.find((c: any) => c.id === coins).complete, true);
    assert.equal((await post('complete', { id: jump })).status, 400, 'only finished work can be marked complete');

    // A reply on finished work is feedback on it: it becomes a new thread, proposed, linked to the one it answers.
    const reply = await post('note', { id: coins, text: 'the rim is too thin on the gold coins' });
    assert.equal(reply.status, 200);
    assert.match(((await reply.json()) as { text: string }).text, /new proposed thread linked to it/);
    const followUp = (await board()).columns.proposed.find((c: any) => c.title === 'the rim is too thin on the gold coins');
    assert.ok(followUp);
    assert.deepEqual(followUp.thread.cameFrom, [{ id: coins, title: 'Make coins readable at sunset' }]);
    assert.match(html, /Mark as complete/);

    // Finished work is kept. One call marks everything still to check as complete, and only threads.
    const mute = s.id('task', 'A mute button');
    s.sp('build', mute);
    s.sp('start', mute);
    s.sp('done', mute, '-m', 'Mute is in settings');
    s.sp('assume', 'Where does mute live?', '--chose', 'Settings', '--why', 'it is where sound is');
    b = await board();
    assert.deepEqual([b.columns.done.filter((c: any) => !c.complete).map((c: any) => c.id), b.history], [[mute], 1]);
    assert.equal((await post('complete-all', {})).status, 200);
    b = await board();
    assert.deepEqual([b.columns.done.filter((c: any) => !c.complete).length, b.history, b.columns.done.length], [0, 2, 2], 'kept as history, not removed');
    assert.equal(s.json('review').assumptions.length, 1, 'a call an agent made is not swept in with the threads');
    assert.match(html, /Mark all ' \+ cards\.length \+ ' as complete/);

    // Sprints: made on the page, filled from the backlog, and played, which moves what is in one to build.
    assert.equal((await post('sprint', { name: 'Polish' })).status, 200);
    b = await board();
    const polish = b.sprints.find((x: any) => x.name === 'Polish');
    assert.deepEqual([polish.status, polish.total, polish.waiting], ['planned', 0, 0]);
    assert.equal((await post('play', { id: polish.id })).status, 400, 'an empty sprint has nothing to play');
    assert.equal((await post('assign', { id: jump, sprint: polish.id })).status, 200);
    assert.equal((await post('assign', { id: followUp.id, sprint: polish.id })).status, 200);
    assert.equal((await post('assign', { id: followUp.id, sprint: '' })).status, 200);
    b = await board();
    assert.deepEqual([b.sprints[0].total, b.sprints[0].waiting, b.columns.proposed.find((c: any) => c.id === jump).sprint], [1, 1, polish.id]);
    assert.equal(b.columns.proposed.find((c: any) => c.id === followUp.id).sprint, '');
    assert.equal((await post('play', { id: polish.id })).status, 200);
    b = await board();
    assert.deepEqual([b.sprints[0].status, b.sprints[0].waiting], ['running', 0]);
    assert.ok(b.columns.build.some((c: any) => c.id === jump), 'playing the sprint moved its thread to build');
    assert.match(s.item(jump), /human: moved to build with the sprint Polish/);
    // What a sprint is for is written on the page, and read back from it.
    assert.equal((await post('sprint-about', { id: polish.id, goal: 'Everything feels tight', why: 'the beta opens on Friday', doneWhen: 'no floaty jumps' })).status, 200);
    const about = (await board()).sprints[0];
    assert.deepEqual([about.goal, about.why, about.doneWhen], ['Everything feels tight', 'the beta opens on Friday', 'no floaty jumps']);
    assert.equal((await post('sprint', { name: 'Later' })).status, 200);
    const laterSprint = (await board()).sprints.find((x: any) => x.name === 'Later');
    assert.equal((await post('drop-sprint', { id: laterSprint.id })).status, 200);
    assert.deepEqual((await board()).sprints.map((x: any) => x.name), ['Polish']);
    assert.match(html, /data-view="backlog">Backlog</);
    assert.match(html, /\[hidden\] \{ display: none !important; \}/, 'the view that is not up is really gone, not left above the other');
    assert.match(html, /id="search"/);

    // What waits on the human besides building, with what each is holding up: shown on its thread, or in the backlog's strip.
    b = await board();
    assert.deepEqual(b.needs.calls.map((c: any) => [c.title, c.choice, c.why]), [['Where does mute live?', 'Settings', 'it is where sound is']]);
    assert.deepEqual([b.needs.questions.length, b.needs.plans.length, b.needs.skills.length], [0, 0, 0]);
    assert.deepEqual(b.needs.notes.map((n: any) => n.text), ['add a mute button to settings']);
    assert.equal((await post('approve', { id: b.needs.calls[0].id })).status, 200);
    assert.equal((await post('note-aside', { id: b.needs.notes[0].id })).status, 200);
    b = await board();
    assert.deepEqual([b.needs.calls.length, b.needs.notes.length], [0, 0]);
    assert.equal((await post('approve', { id: 'x-nope' })).status, 400);

    // An audit's report is read on its ticket, in full.
    const audit = s.id('audit', 'How does it feel to a new player?');
    s.sp('build', audit);
    s.sp('start', audit);
    assert.equal(s.exec(['done', audit, '-m', 'Two things would make them quit', '--report', '-'], { stdin: '# First hour\n\nThe jump, and the coins.' }).code, 0);
    assert.equal((await board()).columns.done.find((c: any) => c.id === audit).thread.report, '# First hour\n\nThe jump, and the coins.');

    // It refuses what it should: no token, a name that is not this machine, a move it does not offer.
    assert.equal((await post('move', { id: jump, to: 'proposed' }, {})).status, 403);
    assert.equal(s.json('show', jump).item.state, 'ready', 'nothing moved without the token');
    // fetch will not send another Host, so this one goes out by hand, the way a rebound name would arrive.
    const asOtherSite = await new Promise<number>((resolve, reject) => {
      http.get(`${url}api/board`, { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
    });
    assert.equal(asOtherSite, 403);
    const refused = await post('move', { id: jump, to: 'nowhere' });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { text: string }).text, /moved to the backlog, build, building or done/);
    assert.equal((await post('note', { id: coins, text: '   ' })).status, 400);
    assert.equal((await fetch(`${url}nope`)).status, 404);
  } finally {
    await stop();
    s.cleanup();
  }
});

test('a finished ticket shows what its commits changed, and Undo takes exactly that back', async () => {
  const s = new Sandbox();
  s.gitInit();
  s.write('physics.txt', 'gravity = 9.8\njump = 5\n');
  s.commitAll('init');
  s.sp('init', '--name', 'skyhop', '--gate');
  s.commitAll('set up spool');
  const jump = s.id('task', 'Tighten the jump arc');
  const sound = s.id('task', 'Add a landing sound');
  s.sp('build', jump, sound);
  s.sp('start', jump);
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${jump}`);
  s.sp('done', jump, '-m', 'Snappier');
  s.sp('start', sound);
  s.write('sound.txt', 'boing\n');
  s.commitAll(`Add a sound\n\nSpool: ${sound}`);
  s.sp('done', sound, '-m', 'It goes boing');

  const { url, stop } = await startPage(s);
  try {
    const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())![1]!;
    const post = (action: string, body: unknown) =>
      fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });

    // The diff of one thread: its files, its lines, its patch, and nothing of the other thread's.
    const diff = (await (await fetch(`${url}api/diff?id=${jump}`)).json()) as Record<string, any>;
    assert.deepEqual(diff.files, [{ path: 'physics.txt', added: 1, removed: 1 }]);
    assert.deepEqual(diff.commits.map((c: any) => c.subject), ['Raise gravity']);
    assert.match(diff.patch, /-gravity = 9\.8\n\+gravity = 12/);
    assert.doesNotMatch(diff.patch, /boing/);
    assert.equal((await fetch(`${url}api/diff?id=nope`)).status, 400);

    // Undo, with the reason: that thread's change is taken back, the other's is untouched, and it is to be done again.
    assert.equal((await post('undo', { id: jump, why: 'too heavy now, I wanted snappy' })).status, 200);
    assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
    assert.equal(s.read('sound.txt'), 'boing\n');
    assert.match(s.item(jump), /too heavy now, I wanted snappy/);
    assert.notEqual(s.json('show', jump).item.status, 'done');

    // Undo and drop: taken back, and not to be done again.
    assert.equal((await post('undo', { id: sound, drop: true })).status, 200);
    assert.equal(s.exists('sound.txt'), false);
    assert.equal(s.json('show', sound).item.status, 'dropped');
  } finally {
    await stop();
    s.cleanup();
  }
});

test('where the gate is locked, the page is where work is moved to build', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--lock');
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('sprint', 'Polish');
  s.sp('edit', jump, '--sprint', 'Polish');
  assert.match(s.fails('build', jump), /its gate is locked/);

  const { url, stop } = await startPage(s);
  try {
    const token = /const TOKEN = '([\w-]{20,})';/.exec(await (await fetch(url)).text())![1]!;
    const post = (action: string, body: unknown) =>
      fetch(`${url}api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-spool-token': token }, body: JSON.stringify(body) });
    assert.equal(((await (await fetch(`${url}api/board`)).json()) as { locked: boolean }).locked, true);

    // A click on the page is the human: play on a thread, and play on a sprint, both go through.
    assert.equal((await post('move', { id: jump, to: 'build' })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'ready');
    s.sp('propose', jump);
    const sprint = s.json('list', '-k', 'sprint').items[0].id;
    assert.equal((await post('play', { id: sprint })).status, 200);
    assert.equal(s.json('show', jump).item.state, 'ready');
    assert.match(s.item(jump), /human: moved to build with the sprint Polish/);
  } finally {
    await stop();
    s.cleanup();
  }
});

test('the page says so where there is no spool', () => {
  const s = new Sandbox();
  assert.match(s.fails('page', '--no-open'), /no \.spool|spool init/i);
  s.cleanup();
});

test('a spec reads as plain parts: what changes, how it helps, when it is done', async () => {
  const { aboutOf } = await import('../src/page.ts');
  const parts = aboutOf('What: pull issues in.\nWhy: Spool sits beside the tools a project has.\nDone when: an issue shows up\nas a thread.\n\nSee also the API notes.');
  assert.deepEqual(parts.map((p) => [p.key, p.label, p.text]), [
    ['what', 'What changes', 'pull issues in.'],
    ['why', 'How it helps', 'Spool sits beside the tools a project has.'],
    ['done', 'Done when', 'an issue shows up\nas a thread.'],
    ['other', 'More detail', 'See also the API notes.'],
  ]);
  assert.deepEqual(aboutOf('Just a sentence: nothing labelled.').map((p) => p.key), ['other']);
  assert.deepEqual(aboutOf(''), []);
});

test('You get a mark of your own in each spool, the way GitHub draws one', async () => {
  const { identicon } = await import('../src/page.ts');
  const a = identicon('skyhop');
  assert.equal(identicon('skyhop'), a, 'the same spool always draws the same mark');
  assert.notEqual(identicon('spool'), a, 'another spool draws another');
  assert.match(a, /^<svg [^>]*aria-label="You"/);
  // Mirrored left to right: every filled cell has its twin across the middle column.
  const cells = [...a.matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  for (const [x, y] of cells) assert.ok(cells.some(([u, v]) => u === 6 - x! && v === y), `${x},${y} has its twin`);
});

test('a Building card says what the agent is doing now, and since when', async () => {
  const { board } = await import('../src/page.ts');
  const { Workspace } = await import('../src/store.ts');
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('build', jump);
  // Read on the sandbox's own day, so the claim is fresh and not gone quiet.
  const live = () => board(Workspace.open(s.root, () => new Date('2026-01-01T00:30:00Z'))).columns.building.find((c) => c.id === jump)?.live;
  assert.equal(live(), undefined, 'not yet building, so no live line');

  s.sp('start', jump);
  const started = /^started: '?([^'\n]+)'?$/m.exec(s.item(jump))![1]!;
  assert.match(started, /^2026-01-01T00:\d\d:00\.000Z$/);
  assert.deepEqual(live(), { since: started, note: '' }, 'just taken: only starting');

  s.sp('log', jump, 'measuring the arc at three speeds');
  assert.deepEqual(live(), { since: started, note: 'measuring the arc at three speeds' });
  s.sp('log', jump, 'the peak is now 20% lower');
  s.sp('edit', jump, '--size', 'm');
  assert.equal(live()?.note, 'the peak is now 20% lower', 'the line changes as the agent works; bookkeeping does not count');
  s.cleanup();
});

test('what waits on the human says which thread it is about, and a call reads as a post there', async () => {
  const { board } = await import('../src/page.ts');
  const { Workspace } = await import('../src/store.ts');
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop');
  const pause = s.id('task', 'Pause button under the score', '-s', 'xs');
  s.sp('assume', 'Which font for the score?', '--chose', 'The pixel font', '--why', 'it matches the title screen', '--for', pause);
  s.sp('assume', 'How loud is the coin sound?', '--chose', 'Half volume');
  s.sp('ask', 'Pause on the left, or the right?', '--option', 'Left', '--option', 'Right', '--for', pause);
  const taught = s.exec(['skill', 'add', 'pause-menus', '-d', 'How this game pauses: use when adding a menu.', '--from', pause, '-b', '-'], { stdin: '1. Freeze the clock.\n' });
  assert.equal(taught.code, 0, taught.err);
  const read = () => board(Workspace.open(s.root, () => new Date('2026-01-01T00:30:00Z')));

  let b = read();
  assert.deepEqual(b.needs.calls.map((c) => [c.title, c.threads]), [['Which font for the score?', [pause]], ['How loud is the coin sound?', []]], 'a call made for no thread is about none');
  assert.deepEqual(b.needs.questions.map((q) => q.threads), [[pause]]);
  assert.deepEqual(b.needs.skills.map((k) => [k.name, k.threads]), [['pause-menus', [pause]]]);
  const ticket = () => Object.values(b.columns).flat().find((c) => c.id === pause)!;
  const thread = ticket().thread;
  const call = b.needs.calls[0]!;
  assert.deepEqual(thread.feed.filter((p) => p.kind === 'decided').map((p) => [p.text, p.ref]), [['Which font for the score? → The pixel font', call.id]]);
  assert.deepEqual(thread.questions.find((q) => q.id === call.id), { id: call.id, title: 'Which font for the score?', status: 'assumed', choice: 'The pixel font', why: 'it matches the title screen' });

  // Accepted, it leaves what waits on him, and the thread still has it on record.
  s.sp('approve', call.id);
  b = read();
  assert.deepEqual(b.needs.calls.map((c) => c.title), ['How loud is the coin sound?']);
  assert.equal(ticket().thread.questions.find((q) => q.id === call.id)!.status, 'decided');
  s.cleanup();
});
