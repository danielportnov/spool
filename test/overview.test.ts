import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, spool } from './helpers.ts';

test('the overview sorts a whole docket under six colours, by who has to move next', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const typo = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const online = s.id('plan', 'Add online multiplayer');
  s.sp('task', 'A Grand Prix mode', '--hold', 'just an idea');
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--for', coins);
  s.sp('start', jump);
  s.sp('capture', 'something nobody has filed');

  const out = s.sp('overview');
  // Each open task appears once, in the group that says what it is waiting for.
  assert.match(out, /^demo {2}4 open · 1 on hold · 0 done\n/);
  assert.match(out, /🔴 NEEDS YOU {2}1\n {2}Outline the coins, or turn them teal\? {2}· a question · blocks 1 task · d-/);
  assert.match(out, new RegExp(`🟣 BREAK DOWN {2}1\\n {2}plan: Add online multiplayer {2}· not planned yet[^\\n]* · ${online}`));
  assert.match(out, new RegExp(`🟡 BLOCKED {2}1\\n {2}Make coins readable at sunset {2}· waiting on your answer: “Outline the coins, or turn them teal\\?” · p2 XS · ${coins}`));
  assert.match(out, new RegExp(`🔵 IN PROGRESS {2}1\\n {2}Tighten the jump arc {2}· agent, \\d+m · p1 S · ${jump}`));
  assert.match(out, new RegExp(`🟢 READY {2}1\\n {2}1\\. Fix the typo on the title screen {2}· p2 XS · ${typo}`));
  assert.match(out, /⚪ ON HOLD {2}1\n {2}A Grand Prix mode {2}· “just an idea”/);
  assert.match(out, /also for you to look over: 1 unfiled/);
  const order = ['🔴', '🟣', '🟡', '🔵', '🟢', '⚪'].map((dot) => out.indexOf(dot));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the human first, what is merely underway last');
  for (const id of [jump, coins, typo, online]) assert.equal(out.split(id).length, 2, `${id} is listed once`);

  // The same thing as data.
  const [data] = s.json('overview').projects;
  assert.deepEqual(
    [data.needsYou.length, data.breakDown.length, data.blocked.length, data.active.length, data.ready.length, data.held.length],
    [1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(data.also, { assumptions: 0, shipped: 0, skills: 0, inbox: 1 });

  // A plan whose parts wait for a go-ahead is the human's move too.
  s.sp('start', online);
  const part = s.id('task', 'Relay server', '--from', online, '--needs', online, '-s', 'm');
  assert.equal(s.exec(['done', online, '-m', 'Races over a relay server', '--report', '-'], { stdin: 'Relay first.' }).code, 0);
  const after = s.sp('overview');
  assert.match(after, /🔴 NEEDS YOU {2}2\n[^🟣🟡]*plan: Add online multiplayer {2}· 1 part waits for your go-ahead/);
  assert.match(after, new RegExp(`🟡 BLOCKED {2}2\\n[\\s\\S]*Relay server {2}· waiting on your go-ahead for “Add online multiplayer” · p2 M · ${part}`));
  assert.doesNotMatch(after, /BREAK DOWN/, 'empty groups are left out');
  s.cleanup();
});

test('the overview takes a project by any reasonable name, or shows every project with something on', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  s.cd('games/sky_hop').sp('init');
  s.cd('apps/tidy_up').sp('init');
  s.cd('games/sky_hop').sp('task', 'Tighten the jump arc');

  const all = s.sp('overview');
  assert.match(all, /^games\/sky_hop {2}1 open · 0 done\n\n🟢 READY {2}1\n/);
  assert.match(all, /nothing open in: studio, apps\/tidy_up$/);

  const one = s.sp('overview', 'sky', 'hop');
  assert.match(one, /^games\/sky_hop {2}1 open/);
  assert.doesNotMatch(one, /nothing open in/);
  assert.match(s.sp('overview', '-P', 'tidy_up'), /^apps\/tidy_up {2}0 open · 0 done\n {2}nothing open$/);
  assert.match(s.fails('overview', 'nope'), /no project "nope"/);
  s.cleanup();
});
