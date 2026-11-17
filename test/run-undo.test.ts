import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, spool } from './helpers.ts';

/** Every item file of a spool, by name, as it is on disk. `skip` leaves some out. */
function items(s: Sandbox, skip: string[] = []): Record<string, string> {
  const dir = path.join(s.dir, '.spool', 'items');
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (!skip.includes(name.replace(/\.md$/, ''))) out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

/** Run commands the way an agent in a run does: with SPOOL_RUN set on each. */
function under(s: Sandbox, run: string): (...args: string[]) => string {
  return (...args) => {
    const result = s.exec(args, { env: { SPOOL_RUN: run } });
    if (result.code !== 0) throw new Error(`spool ${args.join(' ')} failed under ${run}: ${result.err || result.out}`);
    return result.out;
  };
}

interface Line {
  at: string;
  item: string;
  change: string;
  was: Record<string, unknown>;
  now: Record<string, unknown>;
  said: string[];
  command: string;
  hash: string;
  project?: string;
  since?: boolean;
  undone?: boolean;
}

function journal(s: Sandbox, run: string): Line[] {
  return s
    .read(`.spool/runs/${run}/journal.jsonl`)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);
}

test('a run that sizes five threads, drops one and files two is undone in one step, byte for byte', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  const note = s.id('capture', 'say which sprint a thread is in, I look for it every morning');
  const titles = ['Tighten the jump arc', 'Make coins readable at sunset', 'Remember the last level played', 'A Grand Prix mode', 'Shake the screen on landing'];
  const threads = titles.map((title) => s.id('task', title));
  const shipped = s.id('task', 'Retry a failed check once', '-s', 's');
  const run = s.id('audit', 'Tidy the backlog');
  const before = items(s, [run]);

  const as = under(s, run);
  for (const [i, id] of threads.entries()) as('edit', id, '--size', ['xs', 's', 'm', 's', 'l'][i]!);
  as('edit', threads[0]!, '-p', '1');
  as('log', threads[0]!, 'a bug that bites now');
  as('drop', shipped, '-m', 'Shipped in 1672c3d: its Done-when holds');
  const idea = JSON.parse(as('task', 'Show the sprint on the card', '--from', note, '-s', 's', '--json')).task.id as string;
  const other = JSON.parse(as('task', 'Sort Done by when it shipped', '--suggested', 'the newest is what you check first', '--json')).task.id as string;
  as('log', run, 'a note on the run itself');

  // Each item is copied once, as it was, before the run first wrote it; what the run made has a marker instead.
  assert.equal(s.read(`.spool/runs/${run}/before/${shipped}.md`), before[`${shipped}.md`]);
  assert.equal(s.read(`.spool/runs/${run}/before/${threads[0]}.md`), before[`${threads[0]}.md`], 'the copy is of the first state, not the one between two writes');
  assert.equal(s.read(`.spool/runs/${run}/before/${idea}.absent`), '');
  assert.equal(s.exists(`.spool/runs/${run}/before/${run}.md`), false, 'the run’s own thread is not recorded');
  assert.match(s.read('.spool/runs/.gitignore'), /^\*$/m, 'kept out of git, like the transcripts');

  // The journal says when, which item, what changed, by which command, and what the file was left as.
  const lines = journal(s, run);
  assert.ok(lines.every((l) => l.item !== run && /^[0-9a-f]{64}$/.test(l.hash) && !Number.isNaN(Date.parse(l.at))));
  const sized = lines.find((l) => l.item === threads[1])!;
  assert.deepEqual([sized.change, sized.command, sized.was, sized.now, sized.said], ['changed', 'edit', { size: null }, { size: 's' }, ['edited: size s']]);
  const dropped = lines.find((l) => l.item === shipped)!;
  assert.deepEqual([dropped.command, dropped.was.status, dropped.now.status, dropped.said], ['drop', 'proposed', 'dropped', ['dropped: Shipped in 1672c3d: its Done-when holds']]);
  assert.deepEqual(lines.filter((l) => l.item === threads[0]).map((l) => l.said[0]), ['edited: size xs', 'edited: priority p1', 'a bug that bites now']);
  const made = lines.find((l) => l.item === other)!;
  assert.deepEqual([made.change, made.command, made.now.suggested], ['created', 'task', 'the newest is what you check first']);
  assert.deepEqual(lines.find((l) => l.item === note)!.now, { status: 'filed' }, 'the note it filed from is a write too');
  assert.notDeepEqual(items(s, [run]), before);

  // One undo, and the spool is as it was, apart from the run's own thread.
  const out = s.sp('revert', run, '-m', 'too eager, I size them myself');
  assert.match(out, new RegExp(`^${run} undone: 7 items put back as they were, 2 items it had made removed\\. No code was touched\\.\\n`));
  assert.match(out, /Your reason is kept as a lesson every agent here reads first\. To forget it: spool lessons --drop 1$/);
  assert.deepEqual(items(s, [run]), before, 'byte for byte');
  assert.equal(s.exists(`.spool/items/${idea}.md`), false);
  assert.equal(s.json('show', note).item.status, 'new', 'the note is unfiled again');

  // The reason is a lesson, the run's thread says what happened, and it is not left to be built again.
  assert.match(s.read('.spool/policy.md'), new RegExp(`- "too eager, I size them myself" \\(${run}, 2026-01-01\\)`));
  assert.equal(s.json('show', run).item.state, 'dropped');
  assert.match(s.item(run), /human: undone: 7 items put back as they were, 2 items it had made removed\. Why: too eager, I size them myself/);
  assert.match(s.item(run), /agent: a note on the run itself/);

  // It is undone once, and takes no more writes.
  assert.match(s.fails('revert', run), /was undone already/);
  const late = s.exec(['edit', threads[0]!, '--size', 'xl'], { env: { SPOOL_RUN: run } });
  assert.equal(late.code, 1);
  assert.match(late.err, new RegExp(`the run ${run} was undone, so nothing more is done under it\\n {2}Unset SPOOL_RUN`));
  assert.deepEqual(items(s, [run]), before);
  s.cleanup();
});

test('an item changed by hand since the run is named and left as it is', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset');
  const music = s.id('task', 'Fade the music between levels');
  const untouched = s.id('task', 'A Grand Prix mode');
  const run = s.id('audit', 'Tidy the backlog');
  const before = items(s, [run]);
  const as = under(s, run);
  for (const id of [jump, coins, music]) as('edit', id, '--size', 's');
  const idea = JSON.parse(as('task', 'Show the sprint on the card', '--suggested', 'you look for it', '--json')).task.id as string;

  // After the run: a priority set with no run, an edit in an editor to what the run made, and a file deleted.
  s.sp('edit', jump, '-p', '0');
  s.write(`.spool/items/${idea}.md`, s.item(idea).replace('Show the sprint on the card', 'Show the sprint on every card'));
  fs.rmSync(path.join(s.dir, '.spool', 'items', `${music}.md`));
  const byHand = [s.item(jump), s.item(idea)];

  const out = s.sp('revert', run);
  assert.match(out, new RegExp(`^${run} undone: 1 item put back as it was, 3 left as they are\\. No code was touched\\.\\nLeft as they are:\\n`));
  assert.match(out, new RegExp(`${jump} {2}p0 S {2}Tighten the jump arc {2}· changed since\\n`));
  assert.match(out, new RegExp(`${music} {2}Fade the music between levels {2}· deleted since\\n`));
  assert.match(out, new RegExp(`${idea} {2}p2 {2}Show the sprint on every card.* · changed since$`));
  assert.doesNotMatch(out, /lesson/, 'no reason was given, so none is kept');
  assert.deepEqual([s.item(jump), s.item(idea)], byHand, 'as they were left by hand');
  assert.equal(s.exists(`.spool/items/${music}.md`), false);
  assert.equal(s.item(coins), before[`${coins}.md`]);
  assert.equal(s.item(untouched), before[`${untouched}.md`]);
  s.cleanup();
});

test('what someone else did to an item while the run was on is never taken back with the run', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  const jump = s.id('task', 'Tighten the jump arc');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const run = s.id('audit', 'Tidy the backlog');
  const as = under(s, run);
  as('edit', jump, '--size', 's');
  as('build', coins);

  // Meanwhile, with no run set: the user replies on one, and an agent starts building the other.
  const note = s.id('capture', 'and make it snappier on the way down');
  s.sp('file', note, '--into', jump);
  s.sp('start', coins, '--as', 'Claude');
  const meanwhile = [s.item(jump), s.item(coins)];

  // The run goes on to write both again. From here its copies are of what the others left.
  as('edit', jump, '-p', '1');
  as('log', coins, 'worth doing first');
  assert.deepEqual(journal(s, run).map((l) => [l.item, !!l.since]), [[jump, false], [coins, false], [jump, true], [coins, true]]);

  const out = s.sp('revert', run);
  assert.equal(
    out,
    `${run} undone: 2 items put back as they were. No code was touched.\n` +
      'Put back only as far as what someone else did to them while the run was on, which is kept:\n' +
      `  ${jump}  Tighten the jump arc\n  ${coins}  Make coins readable at sunset`,
  );
  assert.deepEqual([s.item(jump), s.item(coins)], meanwhile, 'as the user and the builder left them');
  assert.match(s.item(jump), /and make it snappier on the way down/);
  assert.deepEqual([s.json('show', coins).item.state, s.json('show', coins).item.by], ['active', 'Claude'], 'the thread being built is not pulled from under its agent');
  s.cleanup();
});

test('a thread built since the run moved it to build keeps its commits, and is listed with its own undo', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.gitInit();
  s.write('physics.txt', 'gravity = 9.8\n');
  s.commitAll('Start');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 's');
  const run = s.id('audit', 'Tidy the backlog');
  const as = under(s, run);
  as('build', jump, coins);

  // One is built before the undo, with no run set; the other still waits in build.
  s.sp('start', jump);
  s.write('physics.txt', 'gravity = 12\n');
  s.commitAll(`Raise gravity\n\nSpool: ${jump}`);
  s.sp('done', jump, '-m', 'Gravity 9.8 to 12');
  const head = s.git('rev-parse', 'HEAD');

  const undone = s.json('revert', run, '-m', 'not tonight');
  assert.deepEqual(undone.built, [{ id: jump, undo: `spool revert ${jump}` }]);
  assert.deepEqual([undone.restored, undone.removed, undone.left], [[coins], [], []]);
  assert.equal(undone.lesson, 'not tonight');
  assert.equal(s.json('show', coins).item.state, 'proposed', 'what nobody had started is back in the backlog');
  assert.equal(s.json('show', jump).item.state, 'done');
  assert.equal(s.git('rev-parse', 'HEAD'), head, 'no commit was made');
  assert.equal(s.read('physics.txt'), 'gravity = 12\n', 'and no code was changed');
  assert.match(s.item(run), /undone: 1 item put back as it was, 1 left as it is\. Why: not tonight/);

  // The thread's own undo still takes its commits back.
  s.sp('revert', jump, '-m', 'too heavy');
  assert.equal(s.read('physics.txt'), 'gravity = 9.8\n');
  s.cleanup();
});

test('one being built when the run is undone is told apart, with the command that takes it back', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const run = s.id('audit', 'Tidy the backlog');
  under(s, run)('build', jump);
  s.sp('start', jump, '--as', 'Claude');
  const out = s.sp('revert', run);
  assert.match(out, /undone: 1 left as it is\. No code was touched\.\nBuilt since the run moved them to build\. Their commits are their own, and so is their undo:\n/);
  assert.match(out, new RegExp(`▶ ${jump} .*\\n {6}spool propose --undo ${jump}$`));
  assert.equal(s.json('show', jump).item.state, 'active');
  s.cleanup();
});

test('SPOOL_RUN must name a thread, and a run that is over takes no more writes', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc');
  for (const bad of ['t-nope', '../../outside', 'T-ABCD']) {
    const refused = s.exec(['edit', jump, '--size', 's'], { env: { SPOOL_RUN: bad } });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /SPOOL_RUN names ".*", which is not a thread here/);
  }
  assert.equal(s.json('show', jump).item.size, undefined, 'a refused command wrote nothing');
  assert.equal(fs.existsSync(path.join(s.root, 'outside')), false);
  assert.equal(s.exec(['list'], { env: { SPOOL_RUN: 't-nope' } }).code, 0, 'reading is never refused');

  // Finished, a run takes no more writes; the undo itself is still run from the shell it was set in.
  const run = s.id('audit', 'Tidy the backlog');
  under(s, run)('edit', jump, '--size', 's');
  assert.equal(s.exec(['done', run, '-m', 'Tidied'], { env: { SPOOL_RUN: run } }).code, 1, 'an audit still needs its report');
  assert.equal(s.exec(['done', run, '-m', 'Tidied', '--report', '-'], { env: { SPOOL_RUN: run }, stdin: 'One thread sized.' }).code, 0);
  const late = s.exec(['edit', jump, '--size', 'm'], { env: { SPOOL_RUN: run } });
  assert.match(late.err, new RegExp(`the run ${run} is done, so nothing more is done under it`));
  const undone = s.exec(['revert', run, '--json'], { env: { SPOOL_RUN: run } });
  assert.equal(undone.code, 0);
  assert.deepEqual(JSON.parse(undone.out).restored, [jump]);
  assert.equal(s.json('show', jump).item.size, undefined);

  // A thread with no journal is undone the way it always was.
  const plain = s.id('task', 'Fix the typo');
  assert.match(s.fails('revert', plain), /isn't finished, so there is nothing to revert/);
  s.cleanup();
});

test('a run at the top of a folder of projects puts back what it changed in the projects below', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const game = s.cd('games/sky_hop');
  game.sp('init');
  const jump = s.id('task', 'Tighten the jump arc', '-P', 'sky_hop');
  const was = game.item(jump);
  const run = s.id('audit', 'Tidy the backlog');
  const as = under(s, run);
  as('edit', jump, '--size', 's');
  const made = JSON.parse(as('task', 'Shake the screen on landing', '-P', 'sky_hop', '--json')).task.id as string;
  assert.deepEqual(journal(s, run).map((l) => l.project), ['games/sky_hop', 'games/sky_hop'], 'the journal is the run’s project’s, and says where each item lives');
  assert.equal(game.exists(`.spool/runs`), false);

  assert.match(s.sp('revert', run), /1 item put back as it was, 1 item it had made removed/);
  assert.equal(game.item(jump), was);
  assert.equal(game.exists(`.spool/items/${made}.md`), false);
  s.cleanup();
});

test('a skill’s record is put back, and the undo says its files are not the queue’s to put back', () => {
  const s = spool();
  const skill = s.id('skill', 'add', 'ship-a-beta', '-d', 'How a beta is cut and sent to testers. Use when asked to ship a beta.', '-b', '1. Bump the build.\n2. Archive it.');
  assert.ok(s.exists('.claude/skills/ship-a-beta/SKILL.md'));
  const was = s.item(skill);
  const run = s.id('audit', 'Tidy the backlog');
  under(s, run)('drop', skill, '-m', 'nobody uses it');
  assert.equal(s.exists('.claude/skills/ship-a-beta/SKILL.md'), false, 'dropping a skill deletes its folder');

  const out = s.sp('revert', run);
  assert.match(out, new RegExp(`\\nNot undone: the files of 1 skill \\(${skill}\\)\\. A skill's folder is outside the queue, so what the run wrote or deleted there is as the run left it\\.$`));
  assert.equal(s.item(skill), was);
  assert.equal(s.exists('.claude/skills/ship-a-beta/SKILL.md'), false);
  s.cleanup();
});

test('the brief does not read a run’s journal as something an agent said', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc');
  const run = s.id('audit', 'Tidy the backlog');
  s.sp('start', run, '--as', 'Claude');
  under(s, run)('log', jump, 'the check failed here once');
  // Gone quiet for a day, the run is one of the things that stopped: with what its agent last said, not a line of its journal.
  s.advance(24);
  const brief = s.json('brief');
  const stopped = brief.needsYou.stopped.find((t: { id: string }) => t.id === run);
  assert.equal(stopped.lastSaid, null);
  s.cleanup();
});
