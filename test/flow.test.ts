import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLI, spool } from './helpers.ts';

test('feedback becomes a task that carries the user’s exact words', () => {
  const s = spool();
  const words = 'the jump feels floaty, like I\'m on the moon: fix "it"';
  const note = s.id('capture', words);
  assert.match(s.sp('inbox'), new RegExp(note));

  const task = s.id('task', 'Tighten the jump arc', '--from', note, '-p', '1');
  const file = s.item(task);
  assert.match(file, /^priority: 1$/m);
  assert.match(file, new RegExp(`^from: \\[${note}\\]$`, 'm'));
  assert.ok(file.includes(`> ${words}`), 'the quote is verbatim');
  assert.ok(file.includes(`[[${note}]]`), 'and links back to the note');

  assert.equal(s.json('show', note).item.status, 'filed');
  assert.equal(s.sp('inbox'), 'The inbox is empty.');
  s.cleanup();
});

test('one note can become several tasks, or join an existing one', () => {
  const s = spool();
  const first = s.id('capture', 'coins are hard to see and the music is too loud');
  const coins = s.id('task', 'Make coins easier to see', '--from', first);
  const music = s.id('task', 'Lower the music volume', '--from', first);
  assert.notEqual(coins, music);

  const second = s.id('capture', 'coins still blend into the sand at sunset');
  s.sp('file', second, '--into', coins);
  const file = s.item(coins);
  assert.ok(file.includes('> coins are hard to see') && file.includes('> coins still blend into the sand at sunset'));
  assert.deepEqual(s.json('show', coins).item.from, [first, second]);

  // Filing into finished work is refused: it is new work, and the error says how to queue it.
  s.sp('done', coins, '-m', 'Coins now have an outline');
  const third = s.id('capture', 'the coin outline is too thick');
  assert.match(s.fails('file', third, '--into', coins), /already done, so this is new work[\s\S]*spool task/);
  s.sp('file', third, '--drop', '-m', 'duplicate');
  assert.equal(s.json('show', third).item.status, 'dropped');
  s.cleanup();
});

test('capture points at work that looks related', () => {
  const s = spool();
  s.sp('task', 'Tighten the jump arc so it feels less floaty');
  s.sp('task', 'Add a settings screen');
  const data = s.json('capture', 'jump is still floaty over the long gap');
  assert.equal(data.related.length, 1);
  assert.match(data.related[0].title, /jump arc/);
  s.cleanup();
});

test('next hands out the most urgent ready task, oldest first', () => {
  const s = spool();
  const normal = s.id('task', 'Normal thing');
  const someday = s.id('task', 'Someday thing', '-p', '3');
  const urgent = s.id('task', 'Urgent thing', '-p', 'p0');
  const alsoNormal = s.id('task', 'Another normal thing');

  const order: string[] = [];
  for (let i = 0; i < 4; i++) order.push(s.json('next', '--claim').task.id);
  assert.deepEqual(order, [urgent, normal, alsoNormal, someday]);
  assert.match(s.sp('next'), /Nothing is ready\.\n {2}4 tasks being worked/);
  assert.equal(s.json('next').task, null);
  s.cleanup();
});

test('a question stops its task, tells the user, and lets everything else carry on', () => {
  const s = spool();
  const logo = s.id('task', 'Refresh the logo', '-p', '1');
  const other = s.id('task', 'Fix the typo');
  s.sp('start', logo);

  const marker = path.join(s.root, 'notified.txt');
  const asked = s.exec(
    ['ask', 'Which direction for the logo?', '--option', 'Repaint the wordmark, as is', '--option', 'New emblem', '--recommend', '2', '--why', 'Reads better small', '--for', logo, '--json'],
    { env: { SPOOL_NOTIFY: `echo "$SPOOL_EVENT $SPOOL_ID $SPOOL_TITLE" > "${marker}"` } },
  );
  assert.equal(asked.code, 0, asked.err);
  const d = JSON.parse(asked.out).decision.id as string;
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), `ask ${d} Which direction for the logo?`);

  // The claim is released and the task is blocked — derived, not stored.
  const blocked = s.json('show', logo).item;
  assert.equal(blocked.status, 'open');
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.blockedBy, [d]);
  assert.match(s.fails('start', logo), /blocked on/);
  assert.equal(s.json('next').task.id, other);

  const review = s.sp('review');
  assert.match(review, /NEEDS YOU/);
  assert.match(review, /2\) New emblem {2}← recommended/);
  assert.match(review, new RegExp(`spool answer ${d} 2`));

  // An option containing a comma is one option, and a number picks it.
  assert.match(s.fails('answer', d, '3'), /no option 3/);
  const answer = s.json('answer', d, '1');
  assert.equal(answer.decision.choice, 'Repaint the wordmark, as is');
  assert.equal(answer.decision.by, 'human');
  assert.deepEqual(answer.unblocked, [logo]);
  assert.equal(s.json('next').task.id, logo, 'p1, so it goes first again');
  assert.match(s.sp('next'), /DECISIONS\n.*Which direction for the logo\?.*→ Repaint the wordmark, as is/);
  s.cleanup();
});

test('an assumption does not block; the user can approve it', () => {
  const s = spool();
  const task = s.id('task', 'Tighten the jump');
  s.sp('start', task);
  const d = s.id('assume', 'How much gravity?', '--chose', 'Raise it to 12', '--why', 'Shorter hang time', '--for', task);
  assert.equal(s.json('show', task).item.state, 'active');
  assert.match(s.sp('review'), /WENT AHEAD[\s\S]*chose: Raise it to 12/);

  assert.match(s.fails('assume', 'No choice given'), /--chose is missing/);
  s.sp('approve', d);
  const decided = s.json('show', d).item;
  assert.equal(decided.status, 'decided');
  assert.equal(decided.by, 'agent', 'it stays on record as the agent’s call');
  assert.ok(decided.reviewed);
  assert.equal(s.sp('review'), 'Nothing is waiting on you.');
  s.cleanup();
});

test('overruling an assumption queues rework that names what was built on it', () => {
  const s = spool();
  const built = s.id('task', 'Tighten the jump');
  const pending = s.id('task', 'Tune the double jump');
  const d = s.id('assume', 'How much gravity?', '--chose', 'Raise it to 12', '--for', built);
  s.sp('edit', pending, '--needs', d);
  s.sp('done', built, '-m', 'Gravity is 12 now');

  const result = s.json('answer', d, 'Leave gravity alone; halve the jump height');
  assert.equal(result.decision.status, 'decided');
  assert.equal(result.decision.by, 'human');
  const rework = s.json('show', result.rework).item;
  assert.equal(rework.priority, 1);
  assert.deepEqual(rework.from, [d]);
  assert.ok(rework.body.includes(`[[${built}]]`) && rework.body.includes(`spool revert ${built}`));
  assert.ok(rework.body.includes('**Was:** Raise it to 12'));

  // Work that had not shipped yet just learns the answer changed.
  assert.match(s.item(pending), new RegExp(`${d} changed: now "Leave gravity alone; halve the jump height"`));
  s.cleanup();
});

test('only finished work and assumptions can be approved', () => {
  const s = spool();
  const task = s.id('task', 'A thing');
  const question = s.id('ask', 'Which?', '--option', 'A', '--option', 'B');
  const note = s.id('capture', 'words');
  assert.match(s.fails('approve', task), /isn't finished/);
  assert.match(s.fails('approve', question), /is a question, not an assumption[\s\S]*spool answer/);
  assert.match(s.fails('approve', note), /is a note/);
  assert.match(s.fails('approve'), /what to approve is missing/);
  assert.match(s.fails('ask', 'Bad', '--option', 'A', '--recommend', '2'), /--recommend must be an option number/);
  assert.equal(s.sp('approve', '--all'), 'Nothing to approve.');
  s.cleanup();
});

test('finished work needs a summary and waits in review until acknowledged', () => {
  const s = spool();
  const a = s.id('task', 'First');
  const b = s.id('task', 'Second');
  assert.match(s.fails('done', a), /the summary is missing/);
  s.sp('done', a, '-m', 'Did   the\nfirst thing');
  s.sp('done', b, 'Did the second thing');
  assert.equal(s.json('show', a).item.summary, 'Did the\nfirst thing');
  assert.match(s.fails('done', a, '-m', 'again'), /already done/);

  const review = s.json('review');
  assert.deepEqual(review.shipped.map((t: { id: string }) => t.id), [b, a], 'newest first');
  assert.match(s.sp('approve', '--all'), /Approved 2/);
  assert.equal(s.json('review').shipped.length, 0);
  s.cleanup();
});

test('a task that needs another waits for it', () => {
  const s = spool();
  const first = s.id('task', 'Build the engine', '-p', '3');
  const second = s.id('task', 'Paint the car', '-p', '0', '--needs', first);
  assert.equal(s.json('next').task.id, first, 'the urgent one is blocked, so the low one goes');
  assert.match(s.sp('list', '-s', 'blocked'), new RegExp(`${second}.*needs ${first}`));
  const done = s.json('done', first, '-m', 'Engine built');
  assert.deepEqual(done.unblocked, [second]);
  assert.match(s.sp('next'), /COMES AFTER\n.*Build the engine {2}\(done\) — Engine built/);

  // Dropping a dependency also frees what waited on it.
  const third = s.id('task', 'Wax the car', '--needs', second);
  assert.deepEqual(s.json('drop', second, '-m', 'no paint').unblocked, [third]);
  assert.match(s.fails('edit', third, '--needs', third), /cannot need itself/);
  s.cleanup();
});

test('a claim that goes quiet is offered again after the lease', () => {
  const s = spool();
  const task = s.id('task', 'Long job');
  s.exec(['start', task, '--as', 'alice']);
  assert.equal(s.json('next').task, null);
  assert.match(s.exec(['start', task, '--as', 'bob']).err, /being worked by alice/);

  s.advance(3);
  s.exec(['log', task, 'still going; the build takes a while', '--as', 'alice']);
  s.advance(3);
  assert.equal(s.json('next').task, null, 'the log entry renewed the lease');

  s.advance(2);
  assert.equal(s.json('show', task).item.state, 'stale');
  const taken = s.exec(['next', '--claim', '--as', 'bob', '--json']);
  assert.equal(JSON.parse(taken.out).task.by, 'bob');
  assert.match(s.item(task), /bob: picked up after the last claim went quiet/);
  assert.match(s.item(task), /alice: still going; the build takes a while/);
  s.cleanup();
});

test('ids resolve the way people type them', () => {
  const s = spool();
  const id = s.id('task', 'Findable');
  assert.equal(s.json('show', id.toUpperCase()).item.id, id);
  assert.equal(s.json('show', id.replace('-', '')).item.id, id);
  assert.equal(s.json('show', id.slice(0, 4)).item.id, id);
  assert.equal(s.json('show', `[[${id}]]`).item.id, id);
  assert.match(s.fails('show', 't-zzzz'), /no item "t-zzzz"/);
  assert.match(s.fails('answer', id, 'x'), /is a task, not a decision/);
  s.cleanup();
});

test('list finds things, including what was already decided', () => {
  const s = spool();
  const open = s.id('task', 'Open task about coins');
  const done = s.id('task', 'Finished task about coins');
  s.sp('done', done, '-m', 'ok');
  const d = s.id('ask', 'Should coins spin?', '--option', 'Yes', '--option', 'No');
  s.sp('answer', d, '1');

  const ids = (data: { items: { id: string }[] }) => data.items.map((i) => i.id).sort();
  assert.deepEqual(ids(s.json('list')), [open]);
  assert.deepEqual(ids(s.json('list', '--all')), [d, done, open].sort());
  assert.deepEqual(ids(s.json('list', '--search', 'coins')), [d, done, open].sort(), 'search reaches closed items');
  assert.deepEqual(ids(s.json('list', '-k', 'decision', '--search', 'spin')), [d]);
  assert.deepEqual(ids(s.json('list', '-s', 'done')), [done]);
  assert.equal(s.sp('list', '--search', 'nothing-like-this'), 'Nothing matches.');
  assert.match(s.fails('list', '-k', 'epic'), /no kind "epic"/);
  s.cleanup();
});

test('errors are instructive, and structured under --json', () => {
  const s = spool();
  const bad = s.exec(['show', 't-none', '--json']);
  assert.equal(bad.code, 1);
  assert.deepEqual(Object.keys(JSON.parse(bad.out)), ['error', 'hint']);
  assert.match(s.fails('frobnicate'), /no command "frobnicate"/);
  assert.match(s.fails('task', 'x', '--bogus'), /Unknown option '--bogus'[\s\S]*usage: spool task/);
  assert.match(s.fails('task', 'x', '-p', '9'), /must be 0 to 3/);
  assert.match(s.fails('task'), /the title is missing/);
  assert.match(s.sp('help'), /the engine under the Spool skills[\s\S]*next[\s\S]*only on their word[\s\S]*capture[\s\S]*review/);
  assert.match(s.sp('help', 'ask'), /spool ask <question…>/);
  assert.match(s.sp('--version'), /^\d+\.\d+\.\d+$/);
  s.cleanup();
});

test('check reports a broken file without taking the queue down', () => {
  const s = spool();
  const a = s.id('task', 'A', '-b', 'Why: it is the first');
  const b = s.id('task', 'B', '--needs', a, '-b', 'Why: it comes after A');
  assert.match(s.sp('check'), /0 error\(s\), 0 warning\(s\)/);

  // A hand-made loop, a dangling link and a file that isn't an item at all.
  s.write(`.spool/items/${a}.md`, s.item(a).replace('status: open', `status: open\nneeds: [${b}, t-gone]`));
  s.write('.spool/items/t-junk.md', 'not an item');
  const check = s.exec(['check']);
  assert.equal(check.code, 1);
  assert.match(check.out, /t-junk\.md: no frontmatter/);
  assert.match(check.out, /needs form a loop/);
  assert.match(check.out, new RegExp(`${a} needs t-gone, which is not in this workspace`));
  assert.equal(s.exec(['status']).code, 0, 'everything else still works');
  s.cleanup();
});

test('fields Spool does not own survive its edits', () => {
  const s = spool();
  const id = s.id('task', 'Tagged elsewhere');
  s.write(`.spool/items/${id}.md`, s.item(id).replace('status: open', 'status: open\naliases:\n  - idea\n  - art'));
  s.sp('edit', id, '--title', 'Renamed', '-p', '0', '-b', 'New body');
  s.sp('log', id, 'a note');
  const file = s.item(id);
  assert.match(file, /^aliases:\n {2}- idea\n {2}- art$/m);
  assert.match(file, /^title: Renamed$/m);
  assert.match(file, /New body\n\n## Log\n- .* agent: edited: title, priority p0, body\n- .* agent: a note/);
  s.cleanup();
});

test('a lock left by a crash is broken; nothing is left behind after a write', () => {
  const s = spool();
  const lock = path.join(s.dir, '.spool', '.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  s.sp('task', 'Written despite the stale lock');
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(
    fs.readdirSync(path.join(s.dir, '.spool', 'items')).filter((f) => !f.endsWith('.md')),
    [],
    'no temp files',
  );
  s.cleanup();
});

test('graph draws the items and how they connect', () => {
  const s = spool();
  const note = s.id('capture', 'make it pop');
  const task = s.id('task', 'Make "it" pop', '--from', note);
  const d = s.id('assume', 'How?', '--chose', 'Brighter', '--for', task);
  const graph = s.sp('graph');
  const n = (id: string) => id.replace('-', '_');
  assert.match(graph, /^flowchart LR/);
  assert.ok(graph.includes(`${n(note)} --> ${n(task)}`));
  assert.ok(graph.includes(`${n(d)} -.->|needs| ${n(task)}`));
  assert.ok(graph.includes(`${n(task)}["${task}: Make 'it' pop"]`));
  assert.equal(s.json('graph').edges.length, 2);
  s.cleanup();
});

test('workers racing in separate processes never claim the same task', async () => {
  const s = spool();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(s.id('task', `Task ${i}`));
  const claim = (worker: number) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI, 'next', '--claim', '--json', '--as', `worker-${worker}`],
        { cwd: s.dir, env: { ...process.env, HOME: path.join(s.root, '.home'), XDG_CONFIG_HOME: undefined } },
        (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout).task.id as string)),
      );
    });
  const claimed = await Promise.all(ids.map((_, i) => claim(i)));
  assert.deepEqual([...claimed].sort(), [...ids].sort(), 'six workers, six different tasks');
  assert.equal(s.json('next').task, null);
  s.cleanup();
});
