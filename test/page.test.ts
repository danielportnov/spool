import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import * as http from 'node:http';
import { test } from 'node:test';
import { CLI, Sandbox } from './helpers.ts';

/** Start the real server for a project and wait for the address it prints. */
function startPage(s: Sandbox, ...args: string[]): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CLI, 'page', '--no-open', '-C', s.root, ...args], {
    env: { ...process.env, HOME: `${s.root}/.home` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the page did not start: ${out}`)), 10_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const found = /Spool page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve({ child, url: found[1]! });
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });
}

test('the page shows the spool as a board, and what is done on it is saved to the spool', async () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  s.write('package.json', JSON.stringify({ name: 'skyhop', version: '1.4.2' }));
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('build', coins);
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  const question = s.json('review').questions[0].id;

  const { child, url } = await startPage(s, '--port', String(41000 + (process.pid % 2000)));
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
    assert.match(html, /Claude[\s\S]*not the official mark/);
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

    // An audit's report is read on its ticket, in full.
    const audit = s.id('audit', 'How does it feel to a new player?');
    s.sp('build', audit);
    s.sp('start', audit);
    assert.equal(s.exec(['done', audit, '-m', 'Two things would make them quit', '--report', '-'], { stdin: '# First hour\n\nThe jump, and the coins.' }).code, 0);
    assert.equal((await board()).columns.done.find((c: any) => c.id === audit).thread.report, '# First hour\n\nThe jump, and the coins.');

    // It refuses what it should: no token, a name that is not this machine, a move it does not offer.
    assert.equal((await post('move', { id: jump, to: 'build' }, {})).status, 403);
    assert.equal(s.json('show', jump).item.state, 'proposed', 'nothing moved without the token');
    // fetch will not send another Host, so this one goes out by hand, the way a rebound name would arrive.
    const asOtherSite = await new Promise<number>((resolve, reject) => {
      http.get(`${url}api/board`, { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
    });
    assert.equal(asOtherSite, 403);
    const refused = await post('move', { id: jump, to: 'done' });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { text: string }).text, /moved to build, or back to proposed/);
    assert.equal((await post('note', { id: coins, text: '   ' })).status, 400);
    assert.equal((await fetch(`${url}nope`)).status, 404);
  } finally {
    child.kill();
    s.cleanup();
  }
});

test('the page says so where there is no spool', () => {
  const s = new Sandbox();
  assert.match(s.fails('page', '--no-open'), /no \.spool|spool init/i);
  s.cleanup();
});
