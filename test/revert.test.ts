import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sandbox, spool } from './helpers.ts';

/** A project whose queue is kept in git, which is where undoing code and keeping the queue could collide. */
function repo(): Sandbox {
  const s = spool();
  s.sp('init', '--share');
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

  // Back in the queue, bumped up, with the reason in the user's words.
  const item = s.json('show', task).item;
  // Undoing is saying no: it waits in the backlog, nothing builds it, until it is moved to Build.
  assert.equal(item.status, 'proposed');
  assert.notEqual(item.state, 'ready');
  assert.equal(item.priority, 1);
  assert.deepEqual(item.commits, []);
  assert.ok(item.body.includes('> feels heavy now, not snappy'));
  assert.notEqual(s.json('next').task?.id, task, 'nothing is handed out to build it');
  s.sp('build', task);
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

  // A live repository: the user has just answered something (uncommitted queue change) and
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
  s.sp('build', task);
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
  assert.match(s.sp('revert', task, 'not', 'what', 'I', 'meant'), /back in the backlog\. This is not a git repository, so no code was changed/);
  assert.ok(s.json('show', task).item.body.includes('> not what I meant'));

  s.sp('build', task);
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
  assert.equal(s.json('show', approved).item.status, 'decided', 'what the user confirmed stands');
  assert.equal(s.json('show', shared).item.status, 'assumed', 'and so does a call other work relies on');
  assert.deepEqual(s.json('show', task).item.needs.sort(), [approved, shared].sort());

  // The next attempt is briefed with the user's reason, not with the call that was rejected.
  s.sp('build', task);
  const brief = s.sp('next');
  assert.ok(brief.includes('> too heavy'));
  assert.doesNotMatch(brief, /Raise it to 12  \(an agent's call/);
  s.cleanup();
});

test('revert --now puts it straight back in Build', () => {
  const s = spool();
  const task = s.id('task', 'Again at once');
  s.sp('done', task, '-m', 'did it');
  assert.match(s.sp('revert', task, '--now', '-m', 'again'), /back in Build at p1/);
  assert.equal(s.json('show', task).item.status, 'open');
  s.cleanup();
});

test('reverting again puts the work back: one step, kept on the thread and in the log', () => {
  const s = repo();
  const task = s.id('task', 'Tighten the jump');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  const sha = s.commitAll(`Raise gravity\n\nSpool: ${task}`);
  s.sp('done', task, '-m', 'Gravity 12');
  s.commitAll('queue state');

  s.sp('revert', task, '-m', 'too heavy');
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  const shown = s.json('show', task).item;
  assert.deepEqual(shown.reverted, [sha], 'the thread still knows what it landed');
  assert.equal(shown.revert, s.git('rev-parse', 'HEAD'));
  assert.equal(shown.status, 'proposed');
  s.commitAll('queue state 2');

  const back = s.json('revert', task, '-m', 'it was fine after all');
  assert.equal(s.read('physics.txt'), 'gravity = 12\njump = 5\n');
  assert.deepEqual(back.restored, [sha]);
  const item = s.json('show', task).item;
  assert.equal(item.status, 'done');
  assert.deepEqual(item.commits, [sha]);
  assert.deepEqual(item.reverted ?? [], []);
  assert.match(s.item(task), /human: put the work back, 1 commit\(s\).*: it was fine after all/);
  assert.ok(s.git('log', '-1', '--format=%B').includes(`This reverts commit ${shown.revert}.`));

  // And it can be undone again.
  s.commitAll('queue state 3');
  const again = s.json('revert', task, '-m', 'no, really');
  assert.deepEqual(again.reverted, [sha]);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  s.cleanup();
});

test('cross-thread revert names only blockers, keeps other work and restores the shared undo together', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Retune gravity');
  const newest = s.id('task', 'Retune gravity again');
  const unrelated = s.id('task', 'Add a description');
  const write = (gravity: string, description = '') => s.write('physics.txt', `gravity = ${gravity}\njump = 5\n\n\n\n\n\n${description}`);

  write('9.8');
  s.commitAll('Space the configuration out');
  write('12');
  const a = s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');

  write('14');
  const b = s.commitAll('Retune gravity'); // Older work may be linked only on the item.
  s.write('tuning-notes.txt', 'notes for gravity 14\n');
  const notes = s.commitAll(`Explain the tune\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'gravity is 14', '--commit', b);

  write('14', '# The current tune\n');
  s.commitAll(`Describe the values\n\nSpool: ${unrelated}`);
  s.sp('done', unrelated, '-m', 'describe how the values are used');
  write('16', '# The current tune\n');
  const c = s.commitAll(`Tune again\n\nSpool: ${newest}`);
  s.sp('done', newest, '-m', 'gravity is 16');

  s.write('scratch.txt', 'work in progress\n');
  s.git('add', 'scratch.txt');
  const before = s.git('rev-parse', 'HEAD');
  const error = s.fails('revert', original);
  assert.match(error, new RegExp(`${later} Retune gravity\\b`));
  assert.match(error, new RegExp(`${newest} Retune gravity again`));
  assert.match(error, /--with-later/);
  assert.doesNotMatch(error, new RegExp(unrelated));
  assert.equal(s.git('rev-parse', 'HEAD'), before);
  assert.equal(s.read('physics.txt'), 'gravity = 16\njump = 5\n\n\n\n\n\n# The current tune\n');
  assert.equal(s.json('show', original).item.status, 'done');

  const undone = s.json('revert', original, '--with-later', '-m', 'use the original tune', '--now');
  assert.deepEqual(undone.reverted, [a]);
  assert.deepEqual(undone.later, [{ id: newest, reverted: [c] }, { id: later, reverted: [notes, b] }]);
  const shared = s.git('rev-parse', 'HEAD');
  assert.equal(s.git('rev-parse', 'HEAD^'), before);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n\n\n\n\n\n# The current tune\n');
  assert.equal(s.exists('tuning-notes.txt'), false);
  assert.equal(s.git('diff', '--cached', '--name-only', '--', 'scratch.txt'), 'scratch.txt');
  assert.equal(s.json('show', unrelated).item.status, 'done');
  assert.equal(s.json('show', original).item.status, 'open');
  const body = s.git('show', '-s', '--format=%B', shared);
  const shas = [...body.matchAll(/^This reverts commit ([0-9a-f]+)\.$/gm)].map((m) => m[1]);
  assert.deepEqual(shas, [c, notes, b, a]);
  for (const id of [later, newest]) {
    const thread = s.json('show', id).item;
    assert.equal(thread.status, 'proposed');
    assert.equal(thread.revert, shared);
    assert.ok(body.includes(`Spool-Revert: ${id}`));
    assert.match(s.item(id), new RegExp(`with ${original}.*use the original tune`));
  }

  assert.match(s.sp('revert', newest, '-m', 'put the tune back'), new RegExp(`also put back ${original}`));
  assert.equal(s.read('physics.txt'), 'gravity = 16\njump = 5\n\n\n\n\n\n# The current tune\n');
  assert.ok(s.exists('tuning-notes.txt'));
  for (const [id, commits] of [[original, [a]], [later, [notes, b]], [newest, [c]]] as const) {
    const thread = s.json('show', id).item;
    assert.equal(thread.status, 'done');
    assert.deepEqual(thread.commits, commits);
  }
  assert.equal(s.git('diff', '--cached', '--name-only', '--', 'scratch.txt'), 'scratch.txt');
  assert.equal(s.json('revert', original, '--with-later').later.length, 2, 'restored threads can be undone again');
  s.cleanup();
});

test('cross-thread revert refuses later edits with unknown ownership', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Retune gravity');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.write('physics.txt', 'gravity = 14\njump = 5\n');
  s.commitAll(`Retune gravity\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'gravity is 14');
  s.write('physics.txt', 'gravity = 16\njump = 5\n');
  const unregistered = s.commitAll('Manually change the tune');

  const error = s.fails('revert', original, '--with-later');
  assert.match(error, new RegExp(`${unregistered.slice(0, 7)}: no Spool thread on record`));
  assert.equal(s.git('rev-parse', 'HEAD'), unregistered);
  assert.equal(s.read('physics.txt'), 'gravity = 16\njump = 5\n');
  assert.equal(s.git('status', '--porcelain', '--', 'physics.txt'), '');
  assert.equal(s.json('show', original).item.status, 'done');
  assert.equal(s.json('show', later).item.status, 'done');
  s.cleanup();
});

test('cross-thread revert protects dirty files of later threads and restoration protects new attempts', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Retune gravity');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.write('physics.txt', 'gravity = 14\njump = 5\n');
  s.write('notes.txt', 'new tune\n');
  const before = s.commitAll(`Retune gravity\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'gravity is 14');

  s.write('notes.txt', 'human follow-up\n');
  assert.match(s.fails('revert', original, '--with-later'), /uncommitted changes in the way[\s\S]*notes\.txt/);
  assert.equal(s.read('notes.txt'), 'human follow-up\n');
  assert.equal(s.git('rev-parse', 'HEAD'), before);
  assert.equal(s.json('show', later).item.status, 'done');
  s.git('restore', 'notes.txt');
  const said = s.sp('revert', original, '--with-later', '--now');
  assert.match(said, new RegExp(`The later thread waits in the backlog, each with why on its log: spool build ${later}`));
  assert.equal(s.json('show', original).item.status, 'open', '--now puts only the thread named back in Build');
  assert.equal(s.json('show', later).item.status, 'proposed');
  const shared = s.git('rev-parse', 'HEAD');
  s.sp('build', later);
  s.sp('start', later);
  assert.match(s.fails('revert', original), new RegExp(`${later} has changed since the shared undo`));
  assert.equal(s.git('rev-parse', 'HEAD'), shared);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  assert.equal(s.json('show', later).item.status, 'active');
  s.cleanup();
});

test('cross-thread revert identifies a later deletion of a file', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Delete the config');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.git('rm', 'physics.txt');
  s.commitAll(`Delete the config\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'the config is gone');

  assert.match(s.fails('revert', original), new RegExp(`physics\\.txt[\\s\\S]*${later} Delete the config`));
  s.sp('revert', original, '--with-later');
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  s.cleanup();
});

test('cross-thread revert keeps a later edit on the adjacent line', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Retune gravity');
  const neighbor = s.id('task', 'Raise jump');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.write('physics.txt', 'gravity = 14\njump = 5\n');
  s.commitAll(`Retune gravity\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'gravity is 14');
  s.write('physics.txt', 'gravity = 14\njump = 6\n');
  s.commitAll(`Raise jump\n\nSpool: ${neighbor}`);
  s.sp('done', neighbor, '-m', 'jump is 6');

  const error = s.fails('revert', original);
  assert.match(error, new RegExp(later));
  assert.doesNotMatch(error, new RegExp(neighbor));
  s.sp('revert', original, '--with-later');
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 6\n');
  assert.equal(s.json('show', neighbor).item.status, 'done');
  s.cleanup();
});

test('revert waits for the current landing before editing the checkout or queue', async () => {
  const { landingLock } = await import('../src/worktree.ts');
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  const head = s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');

  const release = landingLock(s.root, 'another-thread');
  try {
    assert.match(s.fails('revert', original, '--with-later'), /another-thread is still landing[\s\S]*Run your undo again/);
    assert.equal(s.git('rev-parse', 'HEAD'), head);
    assert.equal(s.json('show', original).item.status, 'done');
  } finally {
    release();
  }
  s.sp('revert', original);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  s.cleanup();
});

test('cross-thread revert follows conflicts on other files of the later thread', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const later = s.id('task', 'Retune gravity and label it');
  const following = s.id('task', 'Update the label');
  s.write('tune.txt', 'default\n');
  s.commitAll('Add a tune label');
  s.write('physics.txt', 'gravity = 12\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.write('physics.txt', 'gravity = 14\njump = 5\n');
  s.write('tune.txt', 'high\n');
  const b = s.commitAll(`Retune gravity\n\nSpool: ${later}`);
  s.sp('done', later, '-m', 'gravity is 14');
  s.write('tune.txt', 'high, exact\n');
  const c = s.commitAll(`Add a note to the label\n\nSpool: ${following}`);
  s.sp('done', following, '-m', 'labeled it');

  const undone = s.json('revert', original, '--with-later');
  assert.deepEqual(undone.later, [{ id: following, reverted: [c] }, { id: later, reverted: [b] }]);
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\njump = 5\n');
  assert.equal(s.read('tune.txt'), 'default\n');
  s.cleanup();
});

test('cross-thread revert refuses to guess a neighboring edit with repeated preimage text', () => {
  const s = repo();
  const original = s.id('task', 'Raise gravity');
  const neighbor = s.id('task', 'Raise the first jump');
  s.write('physics.txt', 'gravity = 9.8\njump = 5\n# bonus level\njump = 5\n');
  s.commitAll('Describe both levels');
  s.write('physics.txt', 'gravity = 12\njump = 5\n# bonus level\njump = 5\n');
  s.commitAll(`Raise gravity\n\nSpool: ${original}`);
  s.sp('done', original, '-m', 'gravity is 12');
  s.write('physics.txt', 'gravity = 12\njump = 6\n# bonus level\njump = 5\n');
  const before = s.commitAll(`Raise the first jump\n\nSpool: ${neighbor}`);
  s.sp('done', neighbor, '-m', 'first jump is 6');

  assert.match(s.fails('revert', original, '--with-later'), /repeated text/);
  assert.equal(s.read('physics.txt'), 'gravity = 12\njump = 6\n# bonus level\njump = 5\n');
  assert.equal(s.git('rev-parse', 'HEAD'), before);
  assert.equal(s.json('show', neighbor).item.status, 'done');
  s.cleanup();
});
