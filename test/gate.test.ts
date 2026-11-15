import assert from 'node:assert/strict';
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
  s.cleanup();
});
