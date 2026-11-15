import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

function repo(): Sandbox {
  const s = spool();
  s.gitInit();
  s.write('physics.txt', 'gravity = 9.8\njump = 5\n');
  s.commitAll('init');
  return s;
}

test('the commit trailer ties work to its task, and revert takes it all back', () => {
  const s = repo();
  const task = s.id('task', 'Tighten the jump');
  const other = s.id('task', 'Unrelated');

  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  const first = s.commitAll(`Raise gravity\n\nSpool: ${task}`);
  s.write('sound.txt', 'boing\n');
  const unrelated = s.commitAll(`Add a sound\n\nSpool: ${other}`);
  s.write('notes.txt', 'tuned on the first level\n');
  const second = s.commitAll(`Note the tuning\n\nSpool: ${task}\n`);

  const done = s.json('done', task, '-m', 'Gravity 9.8 → 12');
  assert.deepEqual(done.task.commits.sort(), [first, second].sort(), 'only this task’s commits');
  assert.match(s.sp('review'), /2 commits/);
  s.commitAll('queue state');

  const reverted = s.json('revert', task, '-m', 'feels heavy now, not snappy');
  assert.deepEqual(reverted.reverted, [second, first], 'newest first');
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  assert.equal(s.exists('notes.txt'), false);
  assert.equal(s.read('sound.txt'), 'boing\n', 'other tasks’ work is untouched');
  assert.equal(s.git('status', '--porcelain', '--', 'physics.txt', 'notes.txt', 'sound.txt'), '', 'one clean commit');
  assert.deepEqual(s.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['notes.txt', 'physics.txt']);

  const message = s.git('log', '-1', '--format=%B');
  assert.match(message, /^Revert "Tighten the jump"\n\nfeels heavy now, not snappy\n/);
  assert.ok(message.includes(`This reverts commit ${first}.`) && message.includes(`Spool-Revert: ${task}`));
  assert.ok(!message.includes(unrelated));

  // Back in the queue, bumped up, with the reason in the human's words.
  const item = s.json('show', task).item;
  assert.equal(item.state, 'ready');
  assert.equal(item.priority, 1);
  assert.deepEqual(item.commits, []);
  assert.ok(item.body.includes('> feels heavy now, not snappy'));
  assert.equal(s.json('next').task.id, task);

  // The second attempt records only its own commits, not the ones already taken back.
  s.write('physics.txt', 'gravity = 9.8\njump = 4\n');
  const retry = s.commitAll(`Lower the jump instead\n\nSpool: ${task}`);
  assert.deepEqual(s.json('done', task, '-m', 'Jump 5 → 4').task.commits, [retry]);
  s.cleanup();
});

test('the queue is never part of what gets undone', () => {
  const s = repo();
  const task = s.id('task', 'Tighten the jump');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  // The agent finishes first, then commits code and queue together, then the queue moves on.
  s.sp('done', task, '-m', 'Gravity 12');
  const sha = s.commitAll(`Raise gravity\n\nSpool: ${task}`);
  s.sp('log', task, 'a later note on the same file');
  const later = s.id('task', 'Something queued afterwards');
  s.commitAll('more queue state');

  // A live repository: the human has just answered something (uncommitted queue change) and
  // an agent is halfway through an unrelated file. Neither is in the way, and neither is touched.
  const question = s.id('ask', 'Unrelated question?', '--option', 'Yes', '--option', 'No');
  s.commitAll('a question');
  s.sp('answer', question, '1');
  s.write('sound.txt', 'half-written\n');

  const reverted = s.json('revert', task);
  assert.deepEqual(reverted.reverted, [sha]);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  assert.deepEqual(s.git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['physics.txt'], 'the commit holds code only');
  assert.equal(s.read('sound.txt'), 'half-written\n');
  assert.ok(s.exists(`.spool/items/${later}.md`), 'the queue keeps its history');
  assert.match(s.item(task), /a later note on the same file/);
  assert.match(s.item(task), /human: reverted 1 commit\(s\)/);
  assert.equal(s.json('show', question).item.status, 'decided', 'the uncommitted answer survives');
  s.cleanup();
});

test('commits that are merges, off-branch or already undone are left alone, and say so', () => {
  const s = repo();
  const task = s.id('task', 'Tighten the jump');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  const real = s.commitAll(`Raise gravity\n\nSpool: ${task}`);
  s.sp('log', task, 'only the queue changes in this commit');
  const queueOnly = s.commitAll(`Queue bookkeeping\n\nSpool: ${task}`);
  s.git('checkout', '-q', '-b', 'side', 'HEAD~2');
  s.write('side.txt', 'elsewhere\n');
  const offBranch = s.commitAll('On another branch');
  s.git('checkout', '-q', 'main');

  s.sp('done', task, '-m', 'Gravity 12', '--commit', offBranch);
  const first = s.json('revert', task);
  assert.deepEqual(first.reverted, [real]);
  assert.deepEqual(
    first.skipped.map((k: { sha: string; why: string }) => `${k.sha}:${k.why}`).sort(),
    [`${offBranch}:not on this branch`, `${queueOnly}:only touched the queue`].sort(),
  );

  // Done again with nothing new, reverted again: the old commit is not undone twice.
  s.sp('done', task, '-m', 'No change this time');
  const second = s.json('revert', task);
  assert.deepEqual(second.reverted, []);
  assert.ok(second.skipped.some((k: { sha: string; why: string }) => k.sha === real && k.why === 'already reverted'));
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  s.cleanup();
});

test('a revert that cannot be clean changes nothing', () => {
  const s = repo();
  const task = s.id('task', 'Tighten the jump');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${task}`);
  s.sp('done', task, '-m', 'Gravity 12');
  s.commitAll('queue state');

  // Uncommitted work in the way: refuse before touching anything.
  s.write('physics.txt', 'gravity = 12\njump = 6\n');
  assert.match(s.fails('revert', task), /uncommitted changes in the way[\s\S]*physics\.txt/);
  assert.equal(s.read('physics.txt'), 'gravity = 12\njump = 6\n');

  // Later work on the same line: git cannot peel the commit off, so everything is put back.
  s.write('physics.txt', 'gravity = 14\njump = 6\n');
  const head = s.commitAll('Later work on the same line');
  assert.match(s.fails('revert', task, '-m', 'too heavy'), /conflicts with later work in:\nphysics\.txt\nNothing was changed/);
  assert.equal(s.git('rev-parse', 'HEAD'), head);
  assert.equal(s.read('physics.txt'), 'gravity = 14\njump = 6\n');
  assert.equal(s.git('status', '--porcelain', '--', 'physics.txt'), '', 'no conflict markers, nothing staged');
  assert.equal(s.json('show', task).item.status, 'done', 'the task is still done');
  s.cleanup();
});

test('revert without git still reopens the task, and --drop abandons it', () => {
  const s = spool();
  const task = s.id('task', 'No repository here');
  assert.match(s.fails('revert', task), /isn't finished, so there is nothing to revert/);
  assert.match(s.sp('done', task, '-m', 'did it'), /done\./);
  assert.match(s.fails('done', task, '-m', 'x', '--commit', 'HEAD'), /already done/);
  assert.match(s.sp('revert', task, 'not', 'what', 'I', 'meant'), /reopened\. This is not a git repository, so no code was changed/);
  assert.ok(s.json('show', task).item.body.includes('> not what I meant'));

  s.sp('done', task, '-m', 'did it again');
  s.sp('revert', task, '--drop');
  assert.equal(s.json('show', task).item.status, 'dropped');
  s.cleanup();
});

test('done warns when there is nothing to revert by', () => {
  const s = repo();
  const task = s.id('task', 'Untraceable');
  assert.match(s.sp('done', task, '-m', 'changed things'), /No commits found for it/);
  const second = s.id('task', 'Traceable by hand');
  assert.match(s.fails('done', second, '-m', 'x', '--commit', 'nope'), /no commit "nope"/);
  assert.match(s.sp('done', second, '-m', 'x', '--commit', 'HEAD'), /1 commit\(s\) on record/);
  s.cleanup();
});

test('reverting also drops the unconfirmed assumptions the work was built on', () => {
  const s = spool();
  const task = s.id('task', 'Tighten the jump');
  const other = s.id('task', 'Tune the double jump');
  const own = s.id('assume', 'How much gravity?', '--chose', 'Raise it to 12', '--for', task);
  const approved = s.id('assume', 'Keep the jump height?', '--chose', 'Yes', '--for', task);
  const shared = s.id('assume', 'Metric or imperial?', '--chose', 'Metric', '--for', task);
  s.sp('approve', approved);
  s.sp('edit', other, '--needs', shared);
  s.sp('done', task, '-m', 'Gravity 12');

  const reverted = s.json('revert', task, '-m', 'too heavy');
  assert.deepEqual(reverted.voided, [own]);
  assert.equal(s.json('show', own).item.status, 'dropped');
  assert.equal(s.json('show', approved).item.status, 'decided', 'what the human confirmed stands');
  assert.equal(s.json('show', shared).item.status, 'assumed', 'and so does a call other work relies on');
  assert.deepEqual(s.json('show', task).item.needs.sort(), [approved, shared].sort());

  // The next attempt is briefed with the human's reason, not with the call that was rejected.
  const brief = s.sp('next');
  assert.ok(brief.includes('> too heavy'));
  assert.doesNotMatch(brief, /Raise it to 12  \(an agent's call/);
  s.cleanup();
});
