import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox, spool } from './helpers.ts';

test('the overview shows a whole spool as threads under six colours, by who has to move next', () => {
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
  assert.match(out, /^🧶 demo {2}4 threads open · 1 on hold · 0 done\n/);
  assert.match(out, /🔴 NEEDS YOU {2}1\n {2}❓ Outline the coins, or turn them teal\? {2}· a question · blocks 1 thread · d-/);
  assert.match(out, new RegExp(`🟣 BREAK DOWN {2}1\\n {2}🧵 plan: Add online multiplayer {2}· not planned yet[^\\n]* · ${online}`));
  assert.match(out, new RegExp(`🟡 BLOCKED {2}1\\n {2}🧵 Make coins readable at sunset {2}· waiting on your answer: “Outline the coins, or turn them teal\\?” · p2 XS · ${coins}`));
  assert.match(out, new RegExp(`🔵 IN PROGRESS {2}1\\n {2}🧵 Tighten the jump arc {2}· agent, \\d+m · p1 S · ${jump}`));
  assert.match(out, new RegExp(`🟢 READY {2}1\\n {2}1\\. 🧵 Fix the typo on the title screen {2}· p2 XS · ${typo}`));
  assert.match(out, /⚪ ON HOLD {2}1\n {2}🧵 A Grand Prix mode {2}· “just an idea”/);
  assert.match(out, /also for you to look over: 1 unfiled/);
  const order = ['🔴', '🟣', '🟡', '🔵', '🟢', '⚪'].map((dot) => out.indexOf(dot));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the human first, what is merely underway last');
  for (const id of [jump, coins, typo, online]) assert.equal(out.split(id).length, 2, `${id} is listed once`);
  assert.equal(out.split('🧵').length - 1, 5, 'every thread is marked as one, the one on hold too');
  assert.equal(out.split('❓').length - 1, 1, 'a question is not a thread');

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
  assert.match(after, /🔴 NEEDS YOU {2}2\n[^🟣🟡]*🧵 plan: Add online multiplayer {2}· 1 part waits for your go-ahead/);
  assert.match(after, new RegExp(`🟡 BLOCKED {2}2\\n[\\s\\S]*🧵 Relay server {2}· waiting on your go-ahead for “Add online multiplayer” · p2 M · ${part}`));
  assert.doesNotMatch(after, /BREAK DOWN/, 'empty groups are left out');
  s.cleanup();
});

test('a thread an agent suggests waits under ✨ for a yes, and keeps saying where it came from', () => {
  const s = spool();
  const asked = s.id('task', 'Fix the typo on the title screen', '-s', 'xs');
  const idea = s.id('task', 'Remember the last level played', '-s', 's', '--suggested', 'the game always opens on level one, and players come back mid-way');

  const out = s.sp('overview');
  assert.match(out, /^🧶 demo {2}1 thread open · 1 suggested · 0 done\n/);
  assert.match(out, new RegExp(`✨ AI SUGGESTED {2}1\\n {2}🧵 Remember the last level played {2}· “the game always opens on level one, and players come back mid-way” · say yes and it joins the list · p2 S · ${idea}`));
  assert.doesNotMatch(out, /ON HOLD/, 'an idea is not something the human parked');
  const [data] = s.json('overview').projects;
  assert.deepEqual([data.ready.length, data.suggested.length, data.held.length], [1, 1, 0]);

  // Nobody asked for it, so it is never handed out: not to an agent, and not by an agent's own release.
  assert.ok(s.sp('next', '--claim').startsWith(asked));
  assert.match(s.sp('next'), /Nothing is ready\./);
  assert.match(s.fails('start', idea), /is on hold: AI suggested: waiting for your yes[\s\S]*Only the human releases it/);

  // The human says yes: it joins the list, still marked as the agent's idea.
  s.sp('release', idea);
  assert.match(s.sp('overview'), new RegExp(`🟢 READY {2}1\\n {2}1\\. 🧵 Remember the last level played {2}· ✨ AI suggested · p2 S · ${idea}`));
  assert.equal(s.json('show', idea).item.suggested, 'the game always opens on level one, and players come back mid-way');
  s.cleanup();
});

test('--table prints the loop’s list: every open thread numbered, in the order it will be taken', () => {
  const s = spool();
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's', '-p', '1');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  const typo = s.id('task', 'Fix the typo | on the title screen', '-s', 'xs', '-p', '3');
  const online = s.id('plan', 'Add online multiplayer');
  s.sp('task', 'A Grand Prix mode', '-s', 'm', '--hold', 'just an idea');
  s.sp('task', 'Remember the last level played', '-s', 's', '--suggested', 'the game always opens on level one');
  s.sp('ask', 'Outline the coins, or turn them teal?', '--option', 'Outline', '--option', 'Teal', '--recommend', '1', '--for', coins);
  s.sp('start', jump);

  const out = s.sp('overview', '--table').split('\n');
  assert.equal(out[0], '**🧶 demo** · 4 threads in build · 1 needs you · 1 AI suggested · 1 on hold · 0 done');
  assert.deepEqual(out.slice(2, 4), ['| # | 🧵 Thread | Difficulty | Priority | Note |', '| --- | --- | --- | --- | --- |']);
  assert.deepEqual(out.slice(4), [
    '| 1 | **Tighten the jump arc** | Small | High | 🔵 Being built now |',
    '| 2 | **Plan: Add online multiplayer** | — | Normal | I write the plan, not the build |',
    '| 3 | **Fix the typo \\| on the title screen** | Tiny | Someday |  |',
    "| 4 | **Make coins readable at sunset** | Tiny | Normal | 🔴 Needs you: Outline the coins, or turn them teal? **a** Outline · **b** Teal. I'd pick **a**. |",
    '| 5 | **Remember the last level played** | Small | Normal | ✨ AI suggested: the game always opens on level one. Say yes and it joins the order. |',
    '| 6 | **A Grand Prix mode** | Medium | Normal | ⚪ On hold: “just an idea” |',
  ]);

  // The same rows as data, and an idea the human took up keeps its mark in the order.
  assert.deepEqual(s.json('overview').projects[0].rows.map((r: { id: string }) => r.id).slice(0, 4), [jump, online, typo, coins]);
  s.sp('release', s.json('overview').projects[0].rows[4].id);
  assert.match(s.sp('overview', '--table'), /\| 3 \| \*\*Remember the last level played\*\* \| Small \| Normal \| ✨ AI suggested \|/);
  assert.equal(new Sandbox().sp('init', '--name', 'empty').length > 0 && s.sp('overview', '--table').includes('Nothing is open'), false);
  s.cleanup();
});

test('the overview takes a project by any reasonable name, or shows every project with something on', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  s.cd('games/sky_hop').sp('init');
  s.cd('apps/tidy_up').sp('init');
  s.cd('games/sky_hop').sp('task', 'Tighten the jump arc');

  const all = s.sp('overview');
  assert.match(all, /^🧶 games\/sky_hop {2}1 thread open · 0 done\n\n🟢 READY {2}1\n {2}1\. 🧵 Tighten the jump arc/);
  assert.match(all, /nothing open in: studio, apps\/tidy_up$/);

  const one = s.sp('overview', 'sky', 'hop');
  assert.match(one, /^🧶 games\/sky_hop {2}1 thread open/);
  assert.doesNotMatch(one, /nothing open in/);
  assert.match(s.sp('overview', '-P', 'tidy_up'), /^🧶 apps\/tidy_up {2}0 threads open · 0 done\n {2}no threads open$/);
  assert.match(s.fails('overview', 'nope'), /no project "nope"/);
  s.cleanup();
});
