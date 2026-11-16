import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Sandbox, spool } from './helpers.ts';

test('with the gate on, new work is proposed and nothing builds it until the human moves it to build', () => {
  const s = new Sandbox();
  assert.match(s.sp('init', '--name', 'demo', '--gate'), /The build gate is on: new work starts as proposed/);
  assert.equal(JSON.parse(s.read('.spool/config.json')).gate, true);

  const filed = s.sp('task', 'Tighten the jump arc', '-s', 's');
  assert.match(filed, /^Proposed in demo:\n {2}◇ t-\w+ {2}p2 S {2}Tighten the jump arc {2}· proposed\n {2}It is built only once the human moves it to build: spool build t-/);
  const jump = s.json('list').items[0].id;
  const idea = s.id('task', 'Remember the last level played', '-s', 's', '--suggested', 'the game always opens on level one');

  // No agent can take either: not by asking for the next one, not by name.
  assert.match(s.sp('next', '--claim'), /Nothing is ready\.\n {2}2 tasks proposed — nothing builds them until the human moves them to build/);
  assert.match(s.fails('start', jump), /is proposed, not in build[\s\S]*Only the human moves it to build: spool build/);
  assert.match(s.sp('next'), /Nothing is ready/);
  assert.equal(s.json('show', idea).item.hold, undefined, 'an idea needs no hold where everything waits anyway');

  // The views say so.
  const overview = s.sp('overview');
  assert.match(overview, /^🧶 demo {2}0 threads open · 2 proposed · 0 done\n/);
  assert.match(overview, new RegExp(`🟠 PROPOSED {2}2\\n {2}🧵 Tighten the jump arc {2}· move it to build to start it · p2 S · ${jump}`));
  assert.match(overview, /✨ AI suggested: “the game always opens on level one” · move it to build to start it/);
  assert.deepEqual(s.sp('overview', '--table').split('\n').slice(0, 1), ['**🧶 demo** · 0 threads in build · 2 proposed · 0 done']);
  assert.match(s.sp('overview', '--table'), /\| 1 \| \*\*Tighten the jump arc\*\* \| Small \| Normal \| 🟠 Proposed \|\n\| 2 \| \*\*Remember the last level played\*\* \| Small \| Normal \| 🟠 Proposed · ✨ AI suggested: the game always opens on level one \|/);

  // The human moves one to build: now it can be built, and it says who decided.
  assert.match(s.sp('build', jump), new RegExp(`^In build:\\n {2}○ ${jump} {2}p2 S {2}Tighten the jump arc$`));
  assert.match(s.item(jump), /human: moved to build/);
  assert.ok(s.sp('next', '--claim').startsWith(jump));

  // Something being built cannot be pulled back out; something waiting in build can.
  assert.match(s.fails('propose', jump), /is being built by agent/);
  s.sp('build', idea);
  assert.match(s.sp('propose', idea), /^Proposed:\n {2}◇/);
  assert.equal(s.json('show', idea).item.state, 'proposed');
  assert.match(s.sp('overview', '--table'), /\*\*🧶 demo\*\* · 1 thread in build · 1 proposed · 0 done/);

  // The parts of a plan are proposed like anything else.
  const plan = s.id('plan', 'Add online multiplayer');
  s.sp('build', plan);
  s.sp('start', plan);
  const part = s.id('task', 'Relay server', '--from', plan, '-s', 'm');
  assert.equal(s.json('show', part).item.state, 'proposed');
  s.cleanup();
});

test('the gate is a choice: off unless a project turns it on, and it can be turned on later', () => {
  const s = spool();
  const before = s.id('task', 'Queued the old way');
  assert.equal(s.json('show', before).item.state, 'ready');
  assert.match(s.sp('task', 'Another'), /^Queued in demo:/);

  // Turning it on touches one key and nothing already there.
  assert.match(s.sp('init', '--gate'), /The build gate is on/);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo', gate: true });
  assert.equal(s.json('show', before).item.state, 'ready', 'what was in build stays in build');
  assert.equal(s.json('show', s.id('task', 'Filed after')).item.state, 'proposed');

  // build also takes something off hold: it is the human saying start.
  const parked = s.id('task', 'A Grand Prix mode', '--hold', 'just an idea');
  s.sp('build', parked);
  assert.equal(s.json('show', parked).item.state, 'ready');
  assert.match(s.item(parked), /moved to build \(was on hold: just an idea\)/);
  assert.match(s.fails('build'), /what to build is missing/);

  // Work that is reopened is new work to the gate: it waits to be moved to build again.
  s.sp('start', parked);
  s.sp('done', parked, '-m', 'Built');
  s.sp('edit', parked, '--reopen');
  assert.equal(s.json('show', parked).item.state, 'proposed');
  s.cleanup();
});

test('a thread carries tags and a version, set when it is filed or later, and cleared with none', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc', '--tag', 'Level Design', '--tag', '#feel', '--version', 'v1.2');
  assert.deepEqual([s.json('show', jump).item.tags, s.json('show', jump).item.version], [['level-design', 'feel'], '1.2']);
  assert.match(s.sp('list'), /Tighten the jump arc {2}· v1\.2 · #level-design #feel/);
  assert.match(s.item(jump), /^tags: \[level-design, feel\]\nversion: "?1\.2"?$/m);

  assert.match(s.sp('edit', jump, '--tag', 'physics', '--version', '1.3'), /Updated tags physics, version 1\.3/);
  assert.deepEqual(s.json('show', jump).item.tags, ['physics']);
  s.sp('edit', jump, '--tag', 'none', '--version', 'none');
  assert.deepEqual([s.json('show', jump).item.tags, s.json('show', jump).item.version], [[], undefined]);
  assert.match(s.fails('edit', jump, '--version', 'not a version'), /is not a version/);
  assert.match(s.fails('edit', jump, '--tag', '!!!'), /a tag needs a letter or a digit/);

  // Tags a person wrote by hand, as a list down the page, are read as tags.
  s.write(`.spool/items/${jump}.md`, s.item(jump).replace('status: open', 'status: open\ntags:\n  - idea\n  - art'));
  assert.deepEqual(s.json('show', jump).item.tags, ['idea', 'art']);
  s.cleanup();
});

test('a sprint is a named set of work with no dates: fill it, play it, and it ends when its work does', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'skyhop', '--gate');
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const later = s.id('task', 'A Grand Prix mode');

  const made = s.sp('sprint', 'Polish');
  assert.match(made, /^Sprint made in skyhop:\n {2}▫ r-\w+ {2}Polish {2}· planned · 0 of 0 done/);
  const sprint = s.json('list', '-k', 'sprint').items[0].id;
  assert.match(s.fails('sprint', 'polish'), /there is already a sprint called "polish"/);
  assert.match(s.fails('play', 'Polish'), /Polish is empty/);

  // Backlog work goes into it, by id or by name, and comes out again.
  s.sp('edit', jump, '--sprint', sprint);
  s.sp('edit', coins, '--sprint', 'polish');
  s.sp('edit', later, '--sprint', 'Polish');
  assert.match(s.sp('edit', later, '--sprint', 'none'), /Updated out of its sprint/);
  assert.equal(s.json('show', jump).item.sprint, sprint);
  assert.match(s.sp('overview', '--table'), /\| \*\*Tighten the jump arc\*\* \| Small \| Normal \| 🟠 Proposed · in Polish \|/);
  assert.match(s.sp('next'), /Nothing is ready/, 'being in a sprint does not start anything');

  // Playing it is the human moving everything in it to build, in one word.
  const played = s.sp('play', 'Polish');
  assert.match(played, /^Polish is running: 2 moved to build\./);
  assert.match(s.item(jump), /human: moved to build with the sprint Polish/);
  assert.deepEqual([s.json('show', jump).item.state, s.json('show', coins).item.state, s.json('show', later).item.state], ['ready', 'ready', 'proposed']);
  assert.match(s.sp('list', '-k', 'sprint'), /▸ r-\w+ {2}Polish {2}· running · 0 of 2 done/);

  // It finishes with its last thread, not on a date.
  s.sp('start', jump);
  assert.doesNotMatch(s.sp('done', jump, '-m', 'Snappier'), /Sprint finished/);
  s.sp('start', coins);
  assert.match(s.sp('done', coins, '-m', 'Outlined'), /Sprint finished: Polish\. Everything in it is done\./);
  assert.match(s.sp('list', '-k', 'sprint', '--all'), /Polish {2}· done · 2 of 2 done/);
  assert.match(s.fails('edit', later, '--sprint', 'Polish'), /Polish is finished/);

  // A sprint says what it is for: a goal, the reason, and when it is done. The loop's list leads with it.
  s.sp('sprint', 'Launch', '--goal', 'A build a stranger can finish', '--why', 'the beta opens on Friday', '--done-when', 'three testers clear level five');
  const launch = s.json('list', '-k', 'sprint').items.find((i: { title: string }) => i.title === 'Launch');
  assert.equal(s.json('show', launch.id).item.body, 'Goal: A build a stranger can finish\nWhy: the beta opens on Friday\nDone when: three testers clear level five');
  s.sp('edit', later, '--sprint', 'Launch');
  assert.match(s.sp('overview', '--table'), /^\*\*🧶 skyhop\*\*[^\n]*\n\n🏁 \*\*Launch\*\* · planned · 0 of 1 done — A build a stranger can finish\n\n\| # \|/);
  assert.match(s.sp('sprint', 'Bare'), /say what it is for: spool edit r-\w+ -b "Goal: …/);
  s.cleanup();
});

test('a locked gate: an agent cannot move work to build; a person at a terminal can', () => {
  const s = new Sandbox();
  const made = s.sp('init', '--name', 'skyhop', '--lock');
  assert.match(made, /The build gate is on[\s\S]*It is locked: moving work to build takes you, on the Spool page or at your own terminal\. An agent is refused\./);
  assert.equal(JSON.parse(s.read('.spool/config.json')).gate, 'locked');

  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  const parked = s.id('task', 'A Grand Prix mode', '--hold', 'just an idea');
  assert.equal(s.json('show', jump).item.state, 'proposed', 'locked is the gate, and more');

  // Every command that starts work is refused when a program runs it, whatever it calls itself.
  const refused = /spool build is the human's alone in skyhop: its gate is locked[\s\S]*do not look for a way round/;
  assert.match(s.fails('build', jump), refused);
  assert.match(s.fails('build', jump, '--as', 'human'), refused);
  assert.match(s.exec(['build', jump], { env: { SPOOL_ACTOR: 'human' } }).err, refused);
  assert.match(s.fails('release', parked), /spool release is the human's alone/);
  s.sp('sprint', 'Polish');
  s.sp('edit', jump, '--sprint', 'Polish');
  assert.match(s.fails('play', 'Polish'), /spool play is the human's alone/);
  assert.equal(s.json('show', jump).item.state, 'proposed', 'nothing moved');

  // An agent can still do everything that does not start work: file, size, sort, take things out of build.
  s.sp('edit', jump, '--size', 'm');
  s.sp('capture', 'the coins are hard to see');

  // The same commands, typed by a person at their own terminal, go through.
  const typed = s.exec(['build', jump], { tty: true });
  assert.equal(typed.code, 0, typed.err);
  assert.equal(s.json('show', jump).item.state, 'ready');
  assert.equal(s.exec(['release', parked], { tty: true }).code, 0);
  s.sp('propose', jump);
  assert.equal(s.exec(['play', 'Polish'], { tty: true }).code, 0);
  assert.equal(s.json('show', jump).item.state, 'ready');
  assert.ok(s.sp('next', '--claim').startsWith(jump), 'and an agent builds what a person moved');
  s.cleanup();
});

test('locking is one step up from the gate, and init --gate never undoes it', () => {
  const s = spool();
  const open = s.id('task', 'Queued before any gate');
  assert.match(s.sp('build', open), /^In build:/, 'with no lock, an agent passes on the human\'s word as before');
  assert.match(s.sp('init', '--lock'), /It is locked/);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo', gate: 'locked' });
  s.sp('init', '--gate');
  assert.equal(JSON.parse(s.read('.spool/config.json')).gate, 'locked');
  const later = s.id('task', 'Filed after the lock');
  assert.match(s.fails('build', later), /its gate is locked/);
  s.cleanup();
});

test('done means checked: the project’s own check runs first, and a failure refuses the finish', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc');
  s.sp('start', jump);

  // The human names the check. It is kept on their machine, never in the project.
  assert.match(s.sp('checks'), /demo has no check: a change is done when the agent says so/);
  const set = s.sp('checks', 'test -f passed.txt');
  assert.match(set, /^demo is now checked with: test -f passed\.txt\n {2}Kept in .*\.config\/spool\/config\.json, on this machine, not in the project\./);
  assert.deepEqual(JSON.parse(s.read('.spool/config.json')), { version: 1, name: 'demo' }, 'the project never names a program to run');
  assert.deepEqual(Object.values(JSON.parse(s.read('.home/.config/spool/config.json')).checks), ['test -f passed.txt']);

  // It fails: the thread is not finished, and the agent is told what to do and what not to.
  const refused = s.fails('done', jump, '-m', 'Snappier');
  assert.match(refused, /the check failed \(exit 1\): test -f passed\.txt[\s\S]*It has to pass before this can be finished[\s\S]*that is the human's to change/);
  assert.equal(s.json('show', jump).item.state, 'active');

  // It passes: finished, and the thread says what was run.
  s.write('passed.txt', 'ok');
  assert.match(s.sp('done', jump, '-m', 'Snappier'), /done\.\n {2}check passed: test -f passed\.txt \(\d+s\)/);
  const done = s.json('show', jump).item;
  assert.deepEqual([done.state, done.checked], ['done', 'test -f passed.txt']);
  assert.match(s.item(jump), /agent: check passed: test -f passed\.txt \(\d+s\)/);

  // An audit hands in words, not code: nothing is run for it.
  fs.rmSync(path.join(s.root, 'passed.txt'));
  const audit = s.id('audit', 'How does it feel to a new player?');
  s.sp('start', audit);
  assert.equal(s.exec(['done', audit, '-m', 'Two things', '--report', '-'], { stdin: 'The jump, and the coins.' }).code, 0);

  // An agent cannot switch the check off or swap it for an easier one; the human, at their terminal, can.
  assert.match(s.fails('checks', '--none'), /the check for demo is the human's to change[\s\S]*do not work round it/);
  assert.match(s.fails('checks', 'true'), /the check for demo is the human's to change/);
  assert.match(s.exec(['checks', '--none'], { tty: true }).out, /demo has no check any more/);
  const coins = s.id('task', 'Coins');
  s.sp('start', coins);
  assert.equal(s.json('done', coins, '-m', 'Outlined').task.checked, undefined);
  s.cleanup();
});
