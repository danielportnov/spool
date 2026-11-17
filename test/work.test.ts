import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';
import { type Sandbox, spool } from './helpers.ts';

/** Claim tasks one after another, the way a loop would, and return the order they came out in. */
function picks(s: Sandbox, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(s.json('next', '--claim').task.id);
  return out;
}

test('the smallest work goes first, and one pick in four goes to large work', () => {
  const s = spool();
  const large1 = s.id('task', 'Rework the save system', '--size', 'l');
  const medium = s.id('task', 'Medium thing', '-s', 'm');
  const tiny = s.id('task', 'Fix a typo', '-s', 'xs');
  const small1 = s.id('task', 'Small one', '-s', 'small');
  const unsized = s.id('task', 'Nobody sized this');
  const small2 = s.id('task', 'Another small one', '-s', 'S');
  const large2 = s.id('task', 'Rework the audio engine', '-s', 'large');

  // Quick wins first; the fourth pick is the large task that has waited longest; unsized counts as medium.
  assert.deepEqual(picks(s, 7), [tiny, small1, small2, large1, medium, unsized, large2]);
  assert.match(s.item(tiny), /^started: 2026-/m);
  s.cleanup();
});

test('priority outranks size, and the share for large work is configurable', () => {
  const s = spool();
  const tiny = s.id('task', 'Tiny and ordinary', '-s', 'xs');
  const urgent = s.id('task', 'Large and urgent', '-s', 'l', '-p', '1');
  assert.equal(s.json('next').task.id, urgent, 'a p1 large task is not kept waiting behind p2 quick wins');
  s.sp('drop', urgent, tiny);

  s.write('.spool/config.json', JSON.stringify({ version: 1, name: 'demo', largeEvery: 2 }));
  const l1 = s.id('task', 'Large 1', '-s', 'l');
  const l2 = s.id('task', 'Large 2', '-s', 'l');
  const s1 = s.id('task', 'Small 1', '-s', 's');
  const s2 = s.id('task', 'Small 2', '-s', 's');
  assert.deepEqual(picks(s, 4), [s1, l1, s2, l2], 'every other pick');
  s.cleanup();
});

test('sizes are checked, shown and searchable; extra-large work becomes a plan', () => {
  const s = spool();
  assert.match(s.fails('task', 'Vague', '--size', 'enormous'), /size "enormous" must be one of xs, s, m, l, xl[\s\S]*xs a line or a value/);
  assert.match(s.fails('task', 'Vague', '--type', 'epic'), /type "epic" must be one of change, audit, plan/);

  const small = s.id('task', 'Nudge the button', '-s', 's');
  const big = s.json('task', 'Add online multiplayer', '--size', 'xl');
  assert.equal(big.task.type, 'plan', 'nothing extra-large is built in one go');
  assert.match(s.sp('task', 'Rewrite the renderer', '-s', 'extra-large'), /Extra-large work starts as a plan/);
  assert.match(s.item(small), /^size: s$/m);
  assert.doesNotMatch(s.item(small), /^type:/m, 'a plain change stores no type');
  assert.match(s.sp('list'), new RegExp(`${small}  p2 S  Nudge the button`));
  assert.match(s.sp('list'), new RegExp(`${big.task.id}  p2 XL  plan: Add online multiplayer`));

  const ids = (data: { items: { id: string }[] }) => data.items.map((i) => i.id);
  assert.deepEqual(ids(s.json('list', '--size', 'xs,s')), [small]);
  assert.equal(ids(s.json('list', '-t', 'plan')).length, 2);
  assert.deepEqual(ids(s.json('list', '-t', 'change')), [small]);

  // A worker who finds a change is bigger than it looked resizes it, or turns it into a plan.
  s.sp('edit', small, '--size', 'l');
  assert.match(s.sp('next', '-P', '.'), /THIS IS A PLAN|THIS IS LARGE/);
  assert.match(s.sp('show', small), /p2 L/);
  s.sp('edit', small, '--type', 'plan');
  assert.match(s.item(small), /^type: plan$/m);
  assert.match(s.fails('edit', s.id('capture', 'words'), '--size', 's'), /only tasks have a size and a type/);
  s.cleanup();
});

test('an audit is finished by its report, and its findings are ordinary tasks', () => {
  const s = spool();
  const said = 'go through the whole game as a new player and tell me what would make them stop playing';
  const note = s.id('capture', said);
  const audit = s.id('audit', 'Play the whole game as a new player: what makes them quit?', '--from', note, '-s', 'm');
  assert.match(s.item(audit), /^type: audit$/m);
  assert.ok(s.item(audit).includes(`> ${said}`));

  const brief = s.sp('next', '--claim');
  assert.match(brief, new RegExp(`^${audit}  p2 M  audit: Play the whole game`));
  assert.match(brief, new RegExp(`THIS IS AN AUDIT[\\s\\S]*spool task "<the finding>" --from ${audit}[\\s\\S]*--report -`));
  assert.doesNotMatch(brief, /commit trailer/, 'an audit makes no commits');

  const wall = s.id('task', 'The first boss is a difficulty wall', '--from', audit, '-s', 'm', '-p', '1');
  const hint = s.id('task', 'The tutorial never explains the double jump', '--from', audit, '-s', 's');
  assert.match(s.fails('done', audit, '-m', 'Players quit at the first boss'), /an audit is finished by its report[\s\S]*--report -/);
  assert.match(s.exec(['done', audit, '-m', 'x', '--report', '-'], { stdin: '  \n' }).err, /the report is empty/);
  assert.match(s.fails('done', audit, '-m', 'x', '--report', 'missing.md'), /cannot read the report at missing\.md/);

  const report = '# First-hour audit\n\nMost players who quit do so at the first boss.\n';
  const done = s.exec(['done', audit, '-m', 'Players quit at the first boss', '--report', '-'], { stdin: report });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, new RegExp(`report  \\.spool/reports/${audit}\\.md\\n\\s+2 finding\\(s\\) filed from it`));
  assert.doesNotMatch(done.out, /No commits found/);
  assert.equal(s.read(`.spool/reports/${audit}.md`), report);

  // Findings are ready at once, carry their source, and are sized and prioritised like anything else.
  assert.equal(s.json('next').task.id, wall);
  assert.match(s.sp('next'), new RegExp(`CAME FROM\\n  ${audit}  Play the whole game[^\\n]*— Players quit at the first boss\\n\\s+0/2 findings done\\n\\s+read \\.spool/reports/${audit}\\.md`));
  const shown = s.json('show', audit).item;
  assert.deepEqual(shown.progress, { done: 0, total: 2 });
  assert.equal(shown.report, `.spool/reports/${audit}.md`);
  assert.match(s.sp('review'), new RegExp(`SHIPPED[\\s\\S]*${audit}  audit: Play the whole game[\\s\\S]*read \\.spool/reports/${audit}\\.md  · 2 findings filed`));

  s.sp('done', hint, '-m', 'Added a prompt');
  assert.match(s.sp('show', audit), /1\/2 findings done[\s\S]*CAME OUT OF IT/);
  s.cleanup();
});

test('a report can be handed in as a file', () => {
  const s = spool();
  const audit = s.id('audit', 'Review the onboarding copy');
  s.write('notes/onboarding.md', '# Onboarding\n\nToo many words.');
  assert.match(s.sp('done', audit, '-m', 'Too wordy', '--report', 'notes/onboarding.md'), /0 finding\(s\) filed/);
  assert.equal(s.read(`.spool/reports/${audit}.md`), '# Onboarding\n\nToo many words.\n');
  s.cleanup();
});

test('a plan holds its parts until the human gives the go-ahead', () => {
  const s = spool();
  const plan = s.id('plan', 'Add online multiplayer', '-s', 'xl', '-p', '1');
  const brief = s.sp('next', '--claim');
  assert.match(brief, new RegExp(`THIS IS A PLAN[\\s\\S]*add --needs ${plan} to every part`));

  const lobby = s.id('task', 'Lobby screen', '--from', plan, '--needs', plan, '-s', 's');
  const matchmaking = s.id('task', 'Matchmaking service', '--from', plan, '--needs', `${plan},${lobby}`, '-s', 'l');
  const spike = s.id('task', 'Measure latency on a real phone', '--from', plan, '-s', 'xs');

  // Nothing that came out of a plan starts while the plan is still being written.
  assert.deepEqual(s.json('show', spike).item.blockedBy, [plan]);
  assert.equal(s.json('next').task, null);

  const marker = path.join(s.root, 'notified.txt');
  const done = s.exec(['done', plan, '-m', 'Relay server first, then matchmaking', '--report', '-'], {
    stdin: '# Multiplayer\n\n1. Lobby\n2. Matchmaking\n',
    env: { SPOOL_NOTIFY: `echo "$SPOOL_EVENT $SPOOL_ID" > "${marker}"` },
  });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /3 part\(s\) filed from it\n\s+2 of them wait for the human's go-ahead, and the human was notified: spool approve/);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), `plan ${plan}`);

  // The ungated part is free; the gated ones wait, and say on whom.
  assert.equal(s.json('next').task.id, spike);
  assert.deepEqual(s.json('show', lobby).item.blockedBy, [plan]);
  const status = s.sp('status');
  assert.match(status, /for you: 1 plan awaiting your go-ahead/);
  assert.match(status, new RegExp(`◧ ${plan}  XL  Add online multiplayer  · 3 parts awaiting your go-ahead`));
  s.sp('done', spike, '-m', '80ms on wifi');
  assert.match(s.sp('next'), /Nothing is ready\.\n {2}2 tasks waiting on the human — spool review/);

  const review = s.sp('review');
  assert.match(review, new RegExp(`PLANS  the parts wait for your go-ahead\\n  ${plan}  Add online multiplayer  · 3 parts`));
  assert.match(review, /Relay server first, then matchmaking\n\s+S {3}Lobby screen\n\s+L {3}Matchmaking service\n\s+XS {2}Measure latency/);
  assert.match(review, new RegExp(`read \\.spool/reports/${plan}\\.md\\n\\s+spool approve ${plan}   ·   spool revert ${plan} -m`));

  // A go-ahead is deliberate: approving "everything" never includes a plan.
  s.sp('approve', '--all');
  assert.equal(s.json('show', lobby).item.state, 'blocked');
  const approved = s.json('approve', plan);
  assert.deepEqual(approved.unblocked, [lobby], 'matchmaking still waits for the lobby');
  assert.match(s.sp('next'), new RegExp(`PART OF\\n  ${plan}  Add online multiplayer — Relay server first, then matchmaking\\n\\s+1/3 parts done\\n\\s+read \\.spool/reports/${plan}\\.md`));
  assert.match(s.sp('status'), new RegExp(`◧ ${plan}  XL  Add online multiplayer  · 1/3 parts done`));
  s.cleanup();
});

test('the parts of a plan are large work, so they keep moving beside the quick wins', () => {
  const s = spool();
  const plan = s.id('plan', 'Rebuild the level editor');
  s.sp('start', plan);
  const part1 = s.id('task', 'Part one', '--from', plan, '-s', 'xs');
  const part2 = s.id('task', 'Part two', '--from', plan, '-s', 'xs');
  s.exec(['done', plan, '-m', 'Two parts', '--report', '-'], { stdin: 'the plan' });
  const quick = [1, 2, 3, 4].map((n) => s.id('task', `Quick win ${n}`, '-s', 's'));

  // The parts are the smallest things in the queue, but they take the large-work turns, not the quick ones.
  assert.deepEqual(picks(s, 6), [quick[0], quick[1], part1, quick[2], quick[3], part2]);
  s.cleanup();
});

test('sending a plan or an audit back takes its unstarted work with it', () => {
  const s = spool();
  const plan = s.id('plan', 'Add a level editor');
  s.sp('start', plan);
  const started = s.id('task', 'Editor shell', '--from', plan, '-s', 's');
  const waiting = s.id('task', 'Tile palette', '--from', plan, '-s', 'm');
  s.exec(['done', plan, '-m', 'Shell, then palette', '--report', '-'], { stdin: 'the plan' });
  s.sp('start', started);

  const back = s.json('revert', plan, '-m', 'too much at once; start with sharing levels');
  assert.deepEqual(back.orphans, [waiting]);
  assert.equal(s.json('show', waiting).item.status, 'dropped');
  assert.equal(s.json('show', started).item.status, 'active', 'work already under way is not thrown out');
  const again = s.json('show', plan).item;
  assert.equal(again.status, 'proposed');
  assert.equal(again.priority, 1);
  assert.ok(again.body.includes('> too much at once; start with sharing levels'));

  const audit = s.id('audit', 'Review the store page');
  const finding = s.id('task', 'Screenshots are out of date', '--from', audit);
  s.exec(['done', audit, '-m', 'Stale', '--report', '-'], { stdin: 'the report' });
  assert.match(s.sp('revert', audit, '-m', 'look at it as a first-time buyer'), /dropped 1 unstarted finding\(s\) that came from it/);
  assert.equal(s.json('show', finding).item.status, 'dropped');
  s.cleanup();
});

test('the protocols teach sizing, audits and plans to both roles', () => {
  const s = spool();
  const worker = s.sp('prime');
  assert.match(worker, /\*\*An audit\.\*\* Look, think, report\. Do not fix things here/);
  assert.match(worker, /\*\*A plan\.\*\* Work out how\. Do not build it here/);
  assert.match(worker, /### Size: how much would have to change\n\n`xs` a line or a value/);
  assert.match(worker, /one\npick in four to large work/);
  assert.match(worker, /`spool done` says when the steps\nyou just took match earlier finished threads[\s\S]*`spool skills --suggest` prints the line that offers it/);
  const recorder = s.sp('prime', 'recorder');
  assert.match(recorder, /\| a look and a report[^|]*\| `spool audit "<what to examine, and through whose eyes>"/);
  assert.match(recorder, /\| something big or open[^|]*\| `spool plan "<the objective>"/);
  // A plan's go-ahead is an answer, not something to record: that row is in /spool's table.
  assert.doesNotMatch(recorder, /spool approve/);
  assert.match(shipped('spool'), /\| "go ahead with the plan" \| `spool approve <t-id>`/);

  // With --context a worker gets the policy and the state of the queue, and none of the rules.
  const context = s.sp('prime', 'worker', '--context');
  assert.match(context, /^POLICY \(\.spool\/policy\.md\)[\s\S]*## Ask first[\s\S]*NOW {2}\d+ ready/);
  assert.doesNotMatch(context, /Working a thread/);
  s.cleanup();
});

test('work on hold is never handed out, and only the human releases it', () => {
  const s = spool();
  const idea = s.id('plan', 'A Grand Prix mode', '-s', 'l', '--hold', 'just an idea; try it on its own branch when I say');
  const parked = s.id('task', 'Rivals lean in', '-s', 'm');
  const normal = s.id('task', 'Fix the typo', '-s', 'xs');
  s.sp('start', parked);
  assert.match(s.fails('hold', parked), /the reason is missing/);
  s.sp('hold', parked, '-m', 'the launch comes first');

  // Parking releases the claim; the task keeps its place but cannot be picked or started.
  const held = s.json('show', parked).item;
  assert.equal(held.state, 'held');
  assert.equal(held.status, 'open');
  assert.equal(held.by, undefined);
  assert.match(s.item(idea), /^hold: just an idea; try it on its own branch when I say$/m);
  assert.deepEqual(picks(s, 1), [normal]);
  assert.equal(s.json('next').task, null);
  assert.match(s.sp('next'), /2 tasks on hold — spool list -s held/);
  assert.match(s.fails('start', idea), /is on hold: just an idea[\s\S]*Only the human releases it: spool release/);
  assert.match(s.sp('status'), /2 on hold/);
  assert.match(s.sp('list', '-s', 'held'), /⏸ .*Rivals lean in  · on hold: the launch comes first/);
  assert.equal(s.sp('review'), 'Nothing is waiting on you.', 'parked work asks nothing of the human');

  // A dependant of parked work waits for it like any other.
  const after = s.id('task', 'Tune the leaning', '--needs', parked);
  assert.deepEqual(s.json('show', after).item.blockedBy, [parked]);

  assert.match(s.fails('release', normal), /is not on hold/);
  const released = s.exec(['release', parked, idea]);
  assert.equal(released.code, 0, released.err);
  assert.equal(s.json('show', parked).item.state, 'ready');
  assert.match(s.item(parked), /human: released from hold \(was: the launch comes first\)/);
  assert.doesNotMatch(s.item(parked), /^hold:/m);
  assert.match(s.sp('prime', 'recorder'), /--hold "<their words>"/);
  s.cleanup();
});
