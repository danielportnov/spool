import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SpoolError } from '../src/model.ts';
import { findHome } from '../src/store.ts';
import { landingLock } from '../src/worktree.ts';
import { CLI, Sandbox, spool } from './helpers.ts';

/** A project in a repository of its own, with a folder git ignores that a check would need. */
function repo(share = false): Sandbox {
  const s = spool();
  if (share) s.sp('init', '--share');
  s.gitInit();
  s.write('.gitignore', 'node_modules/\n.home/\n');
  s.write('node_modules/dep/index.js', 'module.exports = 1;\n');
  s.write('physics.txt', 'gravity = 9.8\njump = 5\n');
  s.commitAll('init');
  return s;
}

/** Start a thread in a worktree of its own, and stand in it. */
function open(s: Sandbox, id: string): Sandbox {
  s.sp('start', id, '--worktree');
  return s.cd(`.spool/worktrees/${id}`);
}

test('three threads built at once, each in its own worktree, land as three clean sets of commits', () => {
  const s = repo();
  // The check writes down where it ran, and which of the three files it could see there.
  s.sp('checks', 'echo "$(pwd -P) $(test -f a.txt && echo a)$(test -f b.txt && echo b)$(test -f c.txt && echo c)" >> "$HOME/ran.txt"');
  const base = s.git('rev-parse', 'HEAD');
  const [a, b, c] = ['a', 'b', 'c'].map((name) => s.id('task', `Add ${name}`)) as [string, string, string];
  const dir = (id: string) => path.join(s.dir, '.spool', 'worktrees', id);

  // Each is claimed as ever, and also given a checkout of its own on a branch of its own.
  const started = s.json('start', a, '--worktree').task;
  assert.deepEqual([started.state, started.worktree, started.branch, started.workdir], ['active', `.spool/worktrees/${a}`, `spool/${a}`, dir(a)]);
  const brief = s.sp('start', b, '--worktree');
  assert.ok(brief.includes(`demo · work in ${dir(b)}\nWORKTREE — this thread has a checkout of its own there, on the branch spool/${b}. Work and commit only in it`));
  assert.ok(brief.includes(`worktree        made at .spool/worktrees/${b}, on the branch spool/${b} · node_modules linked from the checkout, not copied`));
  s.sp('start', a);
  const claimed = s.json('next', '--claim', '--worktree');
  assert.deepEqual([claimed.task.id, claimed.task.worktree], [c, `.spool/worktrees/${c}`]);
  assert.ok(claimed.brief.includes(`work in ${dir(c)}`));
  assert.match(s.item(a), new RegExp(`agent: started, in its own worktree on spool/${a}`));
  assert.match(s.sp('show', a), new RegExp(`worktree \\.spool/worktrees/${a} · branch spool/${a}`));

  // The worktrees are out of git's sight, and the folder the check needs is linked in, not committed.
  assert.equal(s.read('.spool/worktrees/.gitignore').trim().split('\n').at(-1), '*');
  assert.equal(s.git('status', '--porcelain'), '');
  assert.equal(s.git('worktree', 'list').split('\n').length, 4);
  const trees = Object.fromEntries([a, b, c].map((id) => [id, s.cd(`.spool/worktrees/${id}`)]));
  for (const [id, name] of [[a, 'a'], [b, 'b'], [c, 'c']] as const) {
    const w = trees[id]!;
    assert.ok(fs.lstatSync(path.join(w.dir, 'node_modules')).isSymbolicLink());
    assert.equal(w.read('node_modules/dep/index.js'), 'module.exports = 1;\n');
    w.write(`${name}.txt`, `${name}\n`);
    w.commitAll(`Add ${name}\n\nSpool: ${id}`);
    assert.equal(w.git('show', '--name-only', '--format=', 'HEAD'), `${name}.txt`, 'git add -A leaves the link alone');
  }
  assert.equal(s.git('rev-parse', 'HEAD'), base, 'nothing reaches the checkout while they are being built');
  assert.equal(s.exists('a.txt'), false);

  // They finish in another order than they began. Each is rebased onto the ones before it, checked there, and landed.
  const first = trees[b]!.sp('done', b, '-m', 'Added b');
  assert.match(first, new RegExp(`${b} done\\.\\n  check passed: .* \\(\\d+s\\), in its worktree\\n  landed 1 commit\\(s\\) on main\\n  worktree and branch spool/${b} removed: work from ${s.dir} now`));
  for (const id of [a, c]) {
    const done = trees[id]!.json('done', id, '-m', 'Added it');
    const head = s.git('rev-parse', 'HEAD');
    assert.deepEqual([done.task.state, done.task.commits, done.landed, done.onto], ['done', [head], [head], 'main']);
    assert.deepEqual([done.task.worktree, done.task.branch, done.task.workdir], [undefined, undefined, undefined]);
    assert.doesNotMatch(s.item(id), /^(worktree|branch): /m, 'the thread no longer says it has one');
  }

  assert.equal(s.git('log', '--format=%s', `${base}..HEAD`), 'Add c\nAdd a\nAdd b', 'one commit a thread, in the order they finished');
  assert.equal(s.git('rev-list', '--merges', 'HEAD'), '', 'a straight line, with no merge commits');
  assert.equal(s.git('log', '-1', '--format=%B').trim(), `Add c\n\nSpool: ${c}\nSpool-Model: opus`, 'its claim named the model, and nobody signed it');
  assert.deepEqual(['a.txt', 'b.txt', 'c.txt'].map((f) => s.read(f)), ['a\n', 'b\n', 'c\n']);
  assert.equal(s.git('status', '--porcelain'), '');
  assert.deepEqual(fs.readFileSync(path.join(s.root, '.home', 'ran.txt'), 'utf8').trim().split('\n'), [`${dir(b)} b`, `${dir(a)} ab`, `${dir(c)} abc`], 'each check ran in its worktree, on the rebased tree');

  // Nothing of the three is left but their commits.
  assert.equal(s.git('worktree', 'list').split('\n').length, 1);
  assert.equal(s.git('branch', '--list', 'spool/*'), '');
  assert.deepEqual(fs.readdirSync(path.join(s.dir, '.spool', 'worktrees')), ['.gitignore']);
  assert.equal(s.read('node_modules/dep/index.js'), 'module.exports = 1;\n', 'the linked folder itself is untouched');
  assert.equal(s.exists('.git/spool-landing.lock'), false);

  // And each can still be taken back by itself.
  s.sp('revert', a, '-m', 'not that one');
  assert.deepEqual([s.exists('a.txt'), s.exists('b.txt'), s.exists('c.txt')], [false, true, true]);
  s.cleanup();
});

test('from inside a thread’s worktree, spool is the project’s one queue, never the copy the worktree carries', () => {
  const s = repo(true);
  const id = s.id('task', 'Tighten the jump');
  s.commitAll('the queue is kept in git here');
  // A worktree where Spool keeps them, made by hand: all that matters here is where it stands.
  s.git('worktree', 'add', '-q', '-b', `spool/${id}`, `.spool/worktrees/${id}`);
  const w = s.cd(`.spool/worktrees/${id}`);
  const copy = `.spool/items/${id}.md`;
  assert.ok(w.exists(copy) && w.exists('.spool/config.json'), 'the worktree holds the queue as it was when it was cut');
  const stale = w.read(copy);

  assert.equal(findHome(w.dir), s.dir);
  assert.equal(findHome(path.join(w.dir, 'src', 'deep')), s.dir);
  assert.equal(findHome(s.dir), s.dir);

  // log, ask, a new thread, show: all of them reach the project's queue, from anywhere in the worktree.
  w.sp('log', id, 'the arc is in physics.txt');
  const question = w.id('ask', 'Snappy or heavy?', '--option', 'Snappy', '--option', 'Heavy');
  const found = w.cd('.spool').id('task', 'Found on the way');
  assert.match(s.item(id), /agent: the arc is in physics\.txt/);
  assert.ok(s.exists(`.spool/items/${question}.md`) && s.exists(`.spool/items/${found}.md`));
  assert.equal(w.json('show', id).item.file, path.join(s.dir, copy));
  assert.match(w.sp('init'), /Spool is already set up in demo[\s\S]*Nothing was changed/);

  // The copy is exactly as git gave it.
  assert.equal(w.read(copy), stale);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, '.spool', 'items')), [`${id}.md`]);
  assert.equal(w.git('status', '--porcelain'), '');
  s.cleanup();
});

test('where the queue is kept in git, a thread in a worktree works the real one and lands past its uncommitted changes', () => {
  const s = repo(true);
  const id = s.id('task', 'Tighten the jump');
  s.commitAll('the queue is kept in git here');
  const w = open(s, id);
  assert.doesNotMatch(s.git('status', '--porcelain'), /worktrees/, 'the worktrees are out of git, though the queue is in it');
  w.sp('log', id, 'the arc is in physics.txt');
  assert.match(s.item(id), /agent: the arc is in physics\.txt/);

  // The checkout's queue has changes git has not seen. They are not in the way: the thread never touched its copy.
  assert.match(s.git('status', '--porcelain'), new RegExp(`M \\.spool/items/${id}\\.md`));
  w.write('physics.txt', 'gravity = 12\njump = 5\n');
  w.commitAll(`Raise gravity\n\nSpool: ${id}`);
  assert.deepEqual(w.git('show', '--name-only', '--format=', 'HEAD'), 'physics.txt');
  assert.equal(w.json('done', id, '-m', 'Heavier').landed.length, 1);
  assert.equal(s.read('physics.txt'), 'gravity = 12\njump = 5\n');
  assert.equal(s.json('show', id).item.state, 'done');
  s.cleanup();
});

test('a project that is a folder of its repository is worked in the same folder of the worktree', () => {
  const s = new Sandbox();
  s.gitInit();
  s.write('.gitignore', 'node_modules/\n.home/\n');
  s.write('node_modules/shared/index.js', '');
  s.write('game/node_modules/own/index.js', '');
  s.write('game/physics.txt', 'gravity = 9.8\n');
  const game = s.cd('game');
  game.sp('init', '--name', 'game');
  const id = game.id('task', 'Tighten the jump');
  const top = path.join(game.dir, '.spool', 'worktrees', id);

  // While none of the project is committed, a worktree would not hold it: refused, with nothing left behind.
  s.git('add', '.gitignore');
  s.git('commit', '-q', '-m', 'only the top');
  assert.match(game.fails('start', id, '--worktree'), /nothing of game is committed yet, so a worktree would not hold it/);
  assert.deepEqual([game.json('show', id).item.state, fs.existsSync(top), s.git('branch', '--list', 'spool/*')], ['ready', false, '']);
  s.commitAll('init');
  game.sp('checks', 'test -f physics.txt && test -d node_modules/own && test -d ../node_modules/shared');

  const started = game.json('start', id, '--worktree').task;
  assert.deepEqual([started.worktree, started.workdir], [`.spool/worktrees/${id}/game`, path.join(top, 'game')]);
  assert.match(game.sp('start', id), /worktree {8}its own from before, at \.spool\/worktrees\/t-\w+, on spool\/t-\w+$/);

  // The agent stands in the project's folder inside the worktree, and spool finds the project from there.
  const w = game.cd(`.spool/worktrees/${id}/game`);
  w.write('physics.txt', 'gravity = 12\n');
  w.commitAll(`Raise gravity\n\nSpool: ${id}`);
  assert.equal(w.git('show', '--name-only', '--format=', 'HEAD'), 'game/physics.txt');
  assert.match(w.sp('done', id, '-m', 'Heavier'), /check passed: .*, in its worktree\n {2}landed 1 commit\(s\) on main/);
  assert.equal(s.read('game/physics.txt'), 'gravity = 12\n');
  assert.equal(fs.existsSync(top), false);
  s.cleanup();
});

test('a thread that conflicts with what landed before it is refused, and both are left as they were', () => {
  const s = repo();
  const first = s.id('task', 'Heavier');
  const second = s.id('task', 'Lighter');
  const one = open(s, first);
  const two = open(s, second);
  one.write('physics.txt', 'gravity = 12\njump = 5\n');
  one.commitAll(`Raise gravity\n\nSpool: ${first}`);
  two.write('physics.txt', 'gravity = 7\njump = 5\n');
  const tip = two.commitAll(`Lower gravity\n\nSpool: ${second}`);
  one.sp('done', first, '-m', 'Gravity 12');
  const head = s.git('rev-parse', 'HEAD');

  const refused = two.fails('done', second, '-m', 'Gravity 7');
  assert.match(refused, new RegExp(`${second} conflicts with what has landed on main since it began, in:\\n  physics\\.txt`));
  assert.match(refused, /Nothing was landed, and the worktree is as it was\. Rebase it there: cd .* && git rebase main\n {2}Resolve each conflict, git add it, git rebase --continue\. Then run spool done again\./);
  assert.deepEqual([s.git('rev-parse', 'HEAD'), s.read('physics.txt')], [head, 'gravity = 12\njump = 5\n'], 'the checkout is where it was');
  assert.deepEqual([two.git('rev-parse', 'HEAD'), two.git('status', '--porcelain'), two.read('physics.txt')], [tip, '', 'gravity = 7\njump = 5\n'], 'and so is the worktree, with no rebase left half done');
  const still = s.json('show', second).item;
  assert.deepEqual([still.state, still.worktree], ['active', `.spool/worktrees/${second}`]);
  assert.equal(s.exists('.git/spool-landing.lock'), false, 'and the next thread can land');

  // The agent does what it was told: rebase there, settle the conflict, finish again.
  assert.throws(() => two.git('rebase', 'main'));
  two.write('physics.txt', 'gravity = 10\njump = 5\n');
  two.git('add', 'physics.txt');
  two.git('-c', 'core.editor=true', 'rebase', '--continue');
  assert.equal(two.json('done', second, '-m', 'Gravity 10').landed.length, 1);
  assert.equal(s.read('physics.txt'), 'gravity = 10\njump = 5\n');
  assert.equal(s.git('log', '--format=%s', '-2'), 'Lower gravity\nRaise gravity');
  s.cleanup();
});

test('a failing check lands nothing, loose work is not left behind, and the checkout’s own changes are never run over', () => {
  const s = repo();
  s.sp('checks', 'test -f passed.txt');
  const id = s.id('task', 'Tighten the jump');
  const w = open(s, id);
  w.write('jump.txt', 'snappy\n');
  w.commitAll(`Tighten the jump\n\nSpool: ${id}`);
  const head = s.git('rev-parse', 'HEAD');
  const nothingLanded = () => assert.deepEqual([s.git('rev-parse', 'HEAD'), s.exists('jump.txt'), w.read('jump.txt'), s.json('show', id).item.state], [head, false, 'snappy\n', 'active']);

  // The file the check wants is in the checkout, the user's own and not committed. The check runs in the worktree, so it fails.
  s.write('passed.txt', 'mine\n');
  assert.match(w.fails('done', id, '-m', 'Snappier'), /the check failed \(exit 1\): test -f passed\.txt[\s\S]*It has to pass before this can be finished/);
  nothingLanded();

  // Work that is not committed would be lost with the worktree: it is named, and nothing is landed.
  w.write('passed.txt', 'ok\n');
  w.write('notes/todo.txt', 'later\n');
  assert.match(w.fails('done', id, '-m', 'Snappier'), new RegExp(`${id} has changes in its worktree that are not committed:\\n  notes/todo\\.txt\\n  passed\\.txt\\n  Commit them there \\(cd .*\\) with the trailer "Spool: ${id}", or throw them away`));
  nothingLanded();
  fs.rmSync(path.join(w.dir, 'notes'), { recursive: true });
  w.commitAll(`Pass the check\n\nSpool: ${id}`);

  // Now it would land on top of the user's file. That is refused before the check is even run.
  const refused = w.fails('done', id, '-m', 'Snappier');
  assert.match(refused, new RegExp(`the checkout has uncommitted changes to files ${id} changed:\\n  passed\\.txt\\n  Nothing was landed\\. Those changes are not this thread's: leave them`));
  nothingLanded();
  assert.equal(s.read('passed.txt'), 'mine\n');

  // Out of the way, it lands: both commits, in order.
  fs.rmSync(path.join(s.dir, 'passed.txt'));
  const done = w.json('done', id, '-m', 'Snappier');
  assert.deepEqual([done.task.checked, done.landed.length, done.task.commits.length], ['test -f passed.txt', 2, 2]);
  assert.deepEqual([s.read('jump.txt'), s.read('passed.txt')], ['snappy\n', 'ok\n']);
  assert.equal(s.git('log', '--format=%s', '-2'), 'Pass the check\nTighten the jump');
  s.cleanup();
});

test('landing stamps each commit with its thread, agent and model, keeps what was there, and leaves the author alone', () => {
  const s = repo();
  // The check sees the stamped commits: it writes down the foot of the branch tip it ran on. Codex
  // builds an unsized thread on its own ladder's Sol, at its lean.
  s.sp('checks', 'git log -1 --format=%B | grep -c "^Spool-Model: gpt-6.1-sol$" > "$HOME/checked.txt"');
  const base = s.git('rev-parse', 'HEAD');
  const id = s.id('task', 'Tighten the jump');
  s.sp('--as', 'Codex GPT-6', 'next', '--claim', '--worktree');
  const w = s.cd(`.spool/worktrees/${id}`);
  w.write('jump.txt', 'snappy\n');
  w.commitAll('Tighten the jump');
  w.write('land.txt', 'soft\n');
  w.commitAll(`Soften the landing\n\n---\nnot a divider\n\nSpool: ${id}\nSpool-Agent: Codex\nCo-Authored-By: Someone <s@example.com>`);
  const authors = w.git('log', '--format=%an <%ae> %at', `${base}..HEAD`);

  const done = w.json('--as', 'Codex GPT-6', 'done', id, '-m', 'Snappier');
  assert.equal(done.landed.length, 2);
  assert.equal(s.read('.home/checked.txt').trim(), '1', 'the check ran on the stamped commits');
  assert.equal(
    s.git('log', '-1', '--format=%B', 'HEAD~1').trim(),
    `Tighten the jump\n\nSpool: ${id}\nSpool-Agent: Codex GPT-6\nSpool-Model: gpt-6.1-sol`,
    'a commit with no trailers gets all three',
  );
  assert.equal(
    s.git('log', '-1', '--format=%B').trim(),
    `Soften the landing\n\n---\nnot a divider\n\nSpool: ${id}\nSpool-Agent: Codex\nCo-Authored-By: Someone <s@example.com>\nSpool-Model: gpt-6.1-sol`,
    'what a commit already said is kept, and not said twice',
  );
  assert.equal(s.git('log', '--format=%an <%ae> %at', `${base}..HEAD`), authors, 'the author is untouched');

  assert.deepEqual([...done.task.commits].sort(), s.git('rev-list', `${base}..HEAD`).split('\n').sort(), 'the stamped commits are the ones on record');
  s.cleanup();
});

test('stamping again after a refused landing doubles nothing, and a run handed to a command takes the model it named', () => {
  const s = repo();
  s.sp('checks', 'test -f passed.txt');
  const id = s.id('task', 'Tighten the jump');
  s.sp('--as', 'Claude Sonnet 5.5', 'start', id, '--worktree');
  // As the page leaves it when it hands a thread to its agent.
  s.sp('--as', 'page', 'log', id, 'handed to `claude -p --model claude-sonnet-5-5 --effort medium`');
  const w = s.cd(`.spool/worktrees/${id}`);
  w.write('jump.txt', 'snappy\n');
  w.commitAll('Tighten the jump');
  w.fails('--as', 'Claude Sonnet 5.5', 'done', id, '-m', 'Snappier');
  w.write('passed.txt', 'ok\n');
  w.commitAll('Pass the check');
  assert.doesNotMatch(w.sp('--as', 'Claude Sonnet 5.5', 'done', id, '-m', 'Snappier'), /not stamped|No commits found/);
  for (const subject of ['Tighten the jump', 'Pass the check']) {
    assert.equal(
      s.git('log', '-1', '--format=%B', `--grep=^${subject}$`).trim(),
      `${subject}\n\nSpool: ${id}\nSpool-Agent: Claude Sonnet 5.5\nSpool-Model: claude-sonnet-5-5`,
    );
  }

  // A claim that says what builds it is believed over what the size would give.
  const next = s.id('task', 'Soften the jump');
  s.sp('--as', 'Claude Opus 5.5', 'start', next, '--worktree', '--model', 'claude-haiku-5');
  const n = s.cd(`.spool/worktrees/${next}`);
  n.write('soft.txt', 'soft\n');
  n.commitAll('Soften the jump');
  n.sp('--as', 'Claude Opus 5.5', 'done', next, '-m', 'Softer');
  assert.match(s.git('log', '-1', '--format=%B'), new RegExp(`\\nSpool: ${next}\\nSpool-Agent: Claude Opus 5\\.5\\nSpool-Model: claude-haiku-5$`));
  s.cleanup();
});

test('taking a thread back removes its worktree and branch; stopping it keeps them for the next start', () => {
  const s = repo();
  const base = s.git('rev-parse', 'HEAD');
  const id = s.id('task', 'Tighten the jump');
  const w = open(s, id);
  w.write('jump.txt', 'snappy\n');
  const tip = w.commitAll(`Tighten the jump\n\nSpool: ${id}`);
  const gone = () => assert.deepEqual([w.exists('.'), s.git('branch', '--list', 'spool/*'), s.git('worktree', 'list').split('\n').length], [false, '', 1]);

  // Stopped, its work kept: the worktree stays, and whoever starts it next is sent back into it.
  s.sp('build', '--abort', id);
  const stopped = s.json('show', id).item;
  assert.deepEqual([stopped.state, stopped.worktree, w.git('rev-parse', 'HEAD')], ['ready', `.spool/worktrees/${id}`, tip]);
  const again = s.sp('start', id);
  assert.ok(again.includes(`work in ${w.dir}\nWORKTREE — `));
  assert.match(again, /worktree {8}its own from before, at \.spool\/worktrees\/t-\w+, on spool\/t-\w+$/);
  assert.equal(w.read('jump.txt'), 'snappy\n');

  // Aborted: the thread goes back to the backlog, and work that never landed goes with its worktree.
  const aborted = s.sp('propose', '--abort', id);
  assert.match(aborted, new RegExp(`${id}: worktree and branch spool/${id} removed, with 1 commit\\(s\\) that never landed \\(it was at ${tip.slice(0, 7)}\\)`));
  gone();
  const back = s.json('show', id).item;
  assert.deepEqual([back.state, back.worktree, back.branch], ['proposed', undefined, undefined]);
  assert.match(s.item(id), /human: aborted while agent was building it; moved back to proposed; worktree and branch spool\/t-\w+ removed, with 1 commit\(s\)/);
  assert.deepEqual([s.git('rev-parse', 'HEAD'), s.git('status', '--porcelain')], [base, ''], 'the checkout never saw any of it');

  // Started again it gets a new worktree, cut from the checkout as it is now. Dropped, that goes too.
  s.sp('build', id);
  const fresh = open(s, id);
  assert.deepEqual([fresh.exists('jump.txt'), fresh.git('rev-parse', 'HEAD')], [false, base]);
  assert.match(s.sp('drop', id, '-m', 'not wanted'), new RegExp(`${id}: worktree and branch spool/${id} removed$`, 'm'));
  gone();

  // Undone from the backlog: nothing of it had landed, so there is nothing to revert, only the worktree to remove.
  const other = s.id('task', 'Outline the coins');
  const o = open(s, other);
  o.write('coins.txt', 'outlined\n');
  o.commitAll(`Outline the coins\n\nSpool: ${other}`);
  const undone = s.json('propose', '--undo', other);
  assert.deepEqual([undone.reverted[other], undone.proposed[0].worktree, o.exists('.')], [[], undefined, false]);
  assert.deepEqual([s.git('rev-parse', 'HEAD'), s.git('branch', '--list', 'spool/*')], [base, '']);
  s.cleanup();
});

test('without --worktree nothing changes, and where there can be no worktree it is refused in words', () => {
  const s = repo();
  const id = s.id('task', 'Tighten the jump');
  const started = s.json('start', id).task;
  assert.deepEqual([started.worktree, started.branch, 'workdir' in started], [undefined, undefined, false]);
  const brief = s.sp('start', id);
  assert.ok(brief.includes(`demo · work in ${s.dir}\n`));
  assert.doesNotMatch(brief, /WORKTREE|worktree/);
  assert.equal(s.exists('.spool/worktrees'), false);
  s.write('jump.txt', 'snappy\n');
  const sha = s.commitAll(`Tighten the jump\n\nSpool: ${id}`);
  const done = s.json('done', id, '-m', 'Snappier');
  assert.deepEqual([done.task.commits, 'landed' in done], [[sha], false]);
  assert.equal(s.git('log', '-1', '--format=%H%n%B').trim(), `${sha}\nTighten the jump\n\nSpool: ${id}`, 'built in the project, it may be pushed: it is not rewritten');
  const other = s.id('task', 'Soften the landing');
  s.sp('start', other);
  s.write('land.txt', 'soft\n');
  s.commitAll(`Soften the landing\n\nSpool: ${other}`);
  assert.match(s.sp('done', other, '-m', 'Softer'), /1 commit\(s\) on record — spool revert .* would undo them\n {2}built in the project's folder, so its commits were not stamped with who built them\n/);
  assert.doesNotMatch(s.item(id), /worktree|branch|landed/);
  assert.deepEqual([s.git('worktree', 'list').split('\n').length, s.git('branch', '--list', 'spool/*')], [1, '']);

  assert.match(s.fails('next', '--worktree'), /--worktree goes with --claim\n {2}spool next --claim --worktree/);

  // No repository: said plainly, and the thread is not claimed either.
  const plain = spool();
  const task = plain.id('task', 'No repository here');
  assert.match(plain.fails('start', task, '--worktree'), new RegExp(`demo is not a git repository, so ${task} cannot have a worktree\\n  Start it where the project is: spool start ${task}`));
  assert.match(plain.fails('next', '--claim', '--worktree'), /is not a git repository/);
  assert.equal(plain.json('show', task).item.state, 'ready');
  assert.equal(plain.exists('.spool/worktrees'), false);

  // A repository with nothing committed has nothing to cut a worktree from.
  plain.gitInit();
  assert.match(plain.fails('start', task, '--worktree'), /nothing is committed in demo yet, so there is nothing to cut a worktree from/);
  assert.equal(plain.json('show', task).item.state, 'ready');
  plain.cleanup();
  s.cleanup();
});

test('threads land one at a time: a second waits for the first, then says it is still waiting', async () => {
  const s = repo();
  const lock = path.join(s.dir, '.git', 'spool-landing.lock');

  // Held by something alive: the wait runs out, and it says who has it and that nothing was touched.
  const release = landingLock(s.dir, 't-one', 50);
  assert.throws(
    () => landingLock(s.dir, 't-two', 150),
    (error) => error instanceof SpoolError && /^t-one is still landing, after /.test(error.message) && /Nothing of t-two was changed/.test(error.hint ?? ''),
  );
  release();
  assert.equal(fs.existsSync(lock), false);
  // Left by something that died holding it: taken over at once.
  fs.writeFileSync(lock, '999999999 t-dead\n');
  landingLock(s.dir, 't-two', 150)();
  assert.equal(fs.existsSync(lock), false);

  // Two real finishes at the same moment, with a check slow enough that they overlap: both land, in turn.
  s.sp('checks', 'sleep 1');
  const base = s.git('rev-parse', 'HEAD');
  const ids = ['coins', 'sound'].map((name) => {
    const id = s.id('task', `Add ${name}`);
    const w = open(s, id);
    w.write(`${name}.txt`, `${name}\n`);
    w.commitAll(`Add ${name}\n\nSpool: ${id}`);
    return id;
  });
  const finish = (id: string) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI, 'done', id, '-m', 'Landed', '--json'],
        { cwd: path.join(s.dir, '.spool', 'worktrees', id), env: { ...process.env, HOME: path.join(s.root, '.home'), XDG_CONFIG_HOME: '' } },
        (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(stdout)),
      );
    });
  const landed = (await Promise.all(ids.map(finish))).map((out) => JSON.parse(out));
  assert.deepEqual(landed.map((d) => [d.task.state, d.task.checked, d.landed.length]), [['done', 'sleep 1', 1], ['done', 'sleep 1', 1]]);
  assert.equal(s.git('rev-list', '--count', `${base}..HEAD`), '2');
  assert.equal(s.git('rev-list', '--merges', 'HEAD'), '');
  assert.deepEqual([s.read('coins.txt'), s.read('sound.txt')], ['coins\n', 'sound\n']);
  assert.deepEqual([fs.existsSync(lock), s.git('worktree', 'list').split('\n').length, s.git('status', '--porcelain')], [false, 1, '']);
  s.cleanup();
});
