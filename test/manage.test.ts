import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/** A project with the gate on and a git history, so there is a backlog and something to hold it against. */
function project(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  return s;
}

/** Run commands the way an agent in a run does: with SPOOL_RUN set on each. */
function under(s: Sandbox, run: string): (...args: string[]) => string {
  return (...args) => {
    const result = s.exec(args, { env: { SPOOL_RUN: run } });
    if (result.code !== 0) throw new Error(`spool ${args.join(' ')} failed under ${run}: ${result.err || result.out}`);
    return result.out;
  };
}

/** Open a run and give back its id and its worksheet. */
function start(s: Sandbox, ...more: string[]): { run: string; sheet: string } {
  const sheet = s.sp('manage', '--start', '--as', 'Claude', ...more);
  return { run: /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!, sheet };
}

/** One numbered step of the worksheet: from its heading to the next. */
function step(sheet: string, n: number): string {
  const from = sheet.indexOf(`\n${n}  `);
  assert.ok(from >= 0, `the worksheet has a step ${n}`);
  const rest = sheet.slice(from + 1);
  const next = rest.search(/\n\n(\d  |HANDS OFF)/);
  return next < 0 ? rest : rest.slice(0, next);
}

test('the worksheet names what may have shipped, what looks alike, what has no size and what was dropped, each under its own step', () => {
  const s = project();
  const stop = s.id('task', 'Stop one agent from its card', '-s', 's', '-b', 'What: a stop on the card.\nWhy: one runaway agent should not cost the rest.\nDone when: Stop ends that thread only.');
  const unsized = s.id('task', 'Remember the last level played', '-b', 'Why: nobody wants level one again.');
  const noteA = s.id('capture', 'the jump is floaty over long gaps');
  const a = s.id('task', 'The jump feels floaty over long gaps', '--from', noteA, '-s', 's');
  const noteB = s.id('capture', 'jump still floaty on long gaps');
  const b = s.id('task', 'Jump feels floaty on long gaps', '--from', noteB, '-s', 's');
  const big = s.id('task', 'Rebuild the level editor', '-s', 'l', '-b', 'Why: the old one loses work.');
  const csv = s.id('task', 'Export the board as CSV', '-s', 's');
  s.sp('drop', csv, '-m', 'not now, nobody asked');
  const parked = s.id('task', 'A Grand Prix mode', '-s', 'm', '--hold', 'after the launch');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  s.sp('edit', coins, '-p', '1', '--as', 'human');
  const music = s.id('task', 'Fade the music between levels', '-s', 's');
  s.sp('build', music);
  const idea = s.id('task', 'Shake the screen on landing', '-s', 'xs', '--suggested', 'landing has no weight');

  // After the thread was filed, a commit says what its title says, and so do the changelog and a test.
  s.write('CHANGELOG.md', '# Changelog\n\n## 0.2.0\n\n- Stop one agent from its card: a Stop on a card being built ends\n  that thread and leaves the others running.\n- Coins glow at sunset.\n');
  s.write('test/stop.test.js', "test('stop one agent from its card, and the others carry on', () => {});\n");
  const sha = s.commitAll('Stop one agent from its card, and carry on when you are ready\n\nSpool: t-zzzz\n\nCo-Authored-By: Someone <s@example.com>');
  s.write('notes.txt', 'unrelated\n');
  s.commitAll('Write down the release steps');

  const { run, sheet } = start(s);
  assert.ok(sheet.startsWith(`SPOOL_RUN=${run}\nSet it on every command of this run, so one undo takes back all of it:  export SPOOL_RUN=${run}\n`));
  assert.match(sheet, /\nThe backlog of demo {2}9 open threads\n/);
  assert.match(sheet, /\nNew ideas: 5 at most this run\. 1 earlier one still waits for an answer\.\n/);

  // The run's own thread: an audit that is being worked from the start, signed by whoever runs it, and no part of the backlog it reads.
  const thread = s.json('show', run).item;
  assert.deepEqual([thread.title, thread.type, thread.tags, thread.state, thread.by], ['Tidy the backlog, 2026-01-01', 'audit', ['manage'], 'active', 'Claude']);
  assert.match(s.item(run), /Claude: started/);
  assert.equal(sheet.split(run).length, 4, 'named where the run is set and undone, and in no step');
  assert.doesNotMatch(s.sp('check'), new RegExp(run), 'it says why it exists');

  // 0. What was said no to, with the reason.
  assert.match(step(sheet, 0), new RegExp(`^0 {2}SAID NO TO BEFORE.*\\n {2}Dropped, 1:\\n {4}✗ ${csv} {2}p2 S {2}Export the board as CSV {2}· dropped · \\d+m ago by agent: not now, nobody asked$`));

  // 1. Evidence that a thread may have shipped: the commit, the changelog and the test, and nothing for the rest.
  const shipped = step(sheet, 1);
  assert.match(shipped, /^1 {2}MAY HAVE SHIPPED ALREADY {2}evidence for 1 of 9\. It is evidence, never a verdict/);
  assert.match(shipped, new RegExp(`\\n {2}◇ ${stop} {2}p2 S {2}Stop one agent from its card {2}· proposed\\n`));
  assert.match(shipped, new RegExp(`\\n {6}commit ${sha.slice(0, 7)} {2}\\d{4}-\\d\\d-\\d\\d {2}Stop one agent from its card, and carry on when you are ready {2}· for t-zzzz {2}\\(stop, one, agent, card\\)\\n`));
  assert.match(shipped, /\n {6}changelog 0\.2\.0 {2}Stop one agent from its card: a Stop on a card being built ends that thread and leaves.* {2}\(stop, one, agent, card\)\n/);
  assert.match(shipped, /\n {6}test test\/stop\.test\.js {2}stop one agent from its card, and the others carry on {2}\(stop, one, agent, card\)$/);
  assert.doesNotMatch(shipped, /release steps|Coins glow/);

  // 2. The two near-duplicates, as one pair, with how to merge them.
  const alike = step(sheet, 2);
  assert.match(alike, /^2 {2}LOOK ALIKE {2}1 pair: one wish, or two on one subject\?\n/);
  assert.match(alike, new RegExp(`${a} .*\\n {2}◇ ${b} .*\\n {6}both say: jump, floaty, long, gap\\. To merge: spool file ${noteB} --into ${a}, then spool drop ${b}$`));

  // 3 to 5. Nothing is cold yet; one thread has no size; one is too big to build as it is.
  assert.match(step(sheet, 3), /^3 {2}GONE COLD {2}proposed, and untouched for 30 days\n {2}Nothing\.$/);
  const bare = step(sheet, 4);
  assert.match(bare, new RegExp(`\\n {2}No size, 1:\\n {4}◇ ${unsized} {2}p2 {2}Remember the last level played {2}· proposed\\n {2}No Why: line, `));
  assert.doesNotMatch(bare.split('No Why: line')[1]!, new RegExp(`${unsized}|${stop}|${big}|${idea}`), 'a thread with a Why, or an idea with its reason, is not named');
  assert.match(bare.split('No Why: line')[1]!, new RegExp(`◇ ${parked} {2}p2 M {2}A Grand Prix mode {2}· proposed · hands off: on hold\\n`));
  assert.match(step(sheet, 5), new RegExp(`^5 {2}TOO BIG {2}large or huge, and not a plan\\n {2}◇ ${big} {2}p2 L {2}Rebuild the level editor {2}· proposed$`));

  // 6. The order as it stands, the priority the human set, and Build, which is not the manager's.
  const order = step(sheet, 6);
  assert.match(order, new RegExp(`\\n {2}The backlog as it ranks now, 8:\\n {4}1\\. ◇ ${coins} {2}p1 XS {2}Make coins readable at sunset {2}· proposed · the human set p1 \\d+m ago · hands off: the human changed it \\d+m ago\\n {4}2\\. ◇ ${idea} `));
  assert.match(order, new RegExp(`\\n {4}7\\. ◇ ${parked} .* · hands off: on hold\\n {4}8\\. ◇ ${big} `), 'most urgent first, then the smallest, then the oldest');
  assert.match(order, new RegExp(`\\n {2}Priorities the human set, each to be left as it is, 1:\\n {4}${coins} {2}p1 {2}Make coins readable at sunset`));
  assert.match(order, new RegExp(`\\n {2}In Build, in the order it will be built, 1: ${music}\\. Never yours to reorder\\.$`));
  assert.doesNotMatch(order.split('In Build')[0]!, new RegExp(music), 'what is in Build is not in the backlog’s ranking');
  assert.match(sheet, /\nHANDS OFF\n {2}1 in Build · 1 on hold · 3 the human had a hand on in the last 7 days\n/);
  assert.match(sheet, new RegExp(`\\nWhen the pass is done: {2}spool manage --end -m "<the headline>" --report - <<'EOF' … EOF\\nTo take the whole run back: {2}spool revert ${run}$`));

  // The pass, with ordinary commands, each under the run.
  const as = under(s, run);
  as('edit', unsized, '--size', 's', '--as', 'Claude');
  as('log', stop, 'Looks shipped in ' + sha.slice(0, 7) + ': the Done-when holds', '--as', 'Claude');
  as('edit', idea, '-p', '1', '--as', 'Claude');
  as('log', idea, 'landing is the first thing a new player feels', '--as', 'Claude');
  as('edit', big, '--type', 'plan', '--as', 'Claude');
  as('sprint', 'Feel', '--goal', 'the game feels tight', '--as', 'Claude');
  as('edit', a, '--sprint', 'Feel', '--as', 'Claude');
  const fresh = JSON.parse(as('task', 'Say on the card which sprint a thread is in', '--suggested', 'you look for it every morning', '-s', 's', '--as', 'Claude', '--json')).task.id as string;
  const twice = JSON.parse(as('task', 'Show the sprint on a card', '--suggested', 'the same idea again', '--as', 'Claude', '--json')).task.id as string;
  as('drop', twice, '-m', 'the same as the one above', '--as', 'Claude');
  as('edit', b, '--title', 'Jump still feels floaty on long gaps', '--as', 'Claude');
  assert.match(s.sp('manage'), new RegExp(`^A run is open in demo:\\n {2}▶ ${run} .*\\n {2}9 items changed so far, in \\d+ writes\\n {2}carry on under it {5}export SPOOL_RUN=${run}\\n`));

  // The end: the report is the headline, what the agent has to say, then what the journal shows.
  const mine = 'Needs you (answer by number)\n  1. Drop "Stop one agent from its card": looks shipped, its Done-when holds.   yes / no';
  const ended = s.exec(['manage', '--end', '-m', 'Tidied the backlog: 1 sized, 1 new idea, a sprint drafted', '--report', '-', '--as', 'Claude'], { env: { SPOOL_RUN: run }, stdin: mine });
  assert.equal(ended.code, 0, ended.err);
  assert.match(ended.out, new RegExp(`^${run} done: Tidied the backlog: 1 sized, 1 new idea, a sprint drafted\\n {2}8 items changed: 1 sized · 1 re-ordered · 1 marked as a plan · 1 sprint drafted · 1 new idea · 1 note left · 1 changed otherwise\\n {2}report {2}\\.spool/reports/${run}\\.md`));
  assert.match(ended.out, new RegExp(`One undo takes all of it back: spool revert ${run}\\nThe run is over: unset SPOOL_RUN\\.$`));
  const sprint = s.json('list', '-k', 'sprint').items[0].id as string;
  assert.equal(
    s.read(`.spool/reports/${run}.md`),
    [
      'Tidied the backlog: 1 sized, 1 new idea, a sprint drafted',
      `Undo all of it: spool revert ${run} -m "<why>", or Undo this thread on its ticket.`,
      '',
      mine,
      '',
      'WHAT THIS RUN CHANGED  8 items, from its journal',
      '',
      'Sized  1',
      `  ${unsized}  Remember the last level played · s`,
      'Re-ordered  1',
      `  ${idea}  Shake the screen on landing · p2 → p1`,
      '          landing is the first thing a new player feels',
      'Marked as plans  1',
      `  ${big}  Rebuild the level editor`,
      'Sprints drafted  1',
      `  ${sprint}  Feel · 1 thread: ${a}`,
      'New ideas  1',
      `  ${fresh}  Say on the card which sprint a thread is in · s`,
      '          Why: you look for it every morning',
      'Notes left  1',
      `  ${stop}  Stop one agent from its card`,
      `          Looks shipped in ${sha.slice(0, 7)}: the Done-when holds`,
      'Also changed  1',
      `  ${b}  Jump still feels floaty on long gaps · title`,
      '',
      'Left alone  1 in Build · 1 on hold · 3 the human had a hand on in the last 7 days',
      '',
    ].join('\n'),
  );

  // It is finished like any audit: on its ticket, in the brief, and in the human's review.
  const done = s.json('show', run).item;
  assert.deepEqual([done.state, done.summary, done.report], ['done', 'Tidied the backlog: 1 sized, 1 new idea, a sprint drafted', `.spool/reports/${run}.md`]);
  assert.ok(s.sp('show', run, '--report').startsWith('Tidied the backlog: 1 sized'));
  assert.match(s.sp('brief'), new RegExp(`1\\. Tidy the backlog, 2026-01-01 {2}· ${run}\\n {5}Tidied the backlog: 1 sized, 1 new idea, a sprint drafted\\n {5}why: an audit: read its report`));
  assert.match(s.sp('manage'), new RegExp(`^No run is open in demo\\.\\n {2}The last one: ✓ ${run} .* · done · #manage\\n {2}start one {3}spool manage --start$`));
  const late = s.exec(['edit', unsized, '--size', 'm'], { env: { SPOOL_RUN: run } });
  assert.match(late.err, new RegExp(`the run ${run} is done, so nothing more is done under it\\n {2}Unset SPOOL_RUN\\. For another run: spool manage --start`));

  // And one undo takes all of it back.
  assert.match(s.sp('revert', run, '-m', 'I did not ask for a sprint'), /undone: 6 items put back as they were, 3 items it had made removed\. No code was touched\./);
  assert.equal(s.json('show', unsized).item.size, undefined);
  assert.equal(s.exists(`.spool/items/${fresh}.md`), false);
  s.cleanup();
});

test('--json gives the worksheet as data, with every kind of evidence', () => {
  const s = project();
  // A thread that was worked on and never finished: a commit carries its own id.
  const jump = s.id('task', 'Tighten the jump arc', '-s', 's');
  s.sp('build', jump);
  s.sp('start', jump);
  s.write('physics.txt', 'gravity = 12\n');
  const own = s.commitAll(`Raise gravity\n\nSpool: ${jump}`);
  s.sp('build', '--abort', jump);
  // A finished thread that says what an open one says.
  const glow = s.id('task', 'Coins glow at sunset so they are readable', '-s', 'xs');
  s.sp('build', glow);
  s.sp('start', glow);
  s.write('coins.txt', 'glow\n');
  const built = s.commitAll(`Coins glow at sunset\n\nSpool: ${glow}`);
  s.sp('done', glow, '-m', 'Coins glow at sunset');
  const coins = s.id('task', 'Make coins readable at sunset', '-s', 'xs');
  // A commit taken back is no evidence of anything.
  const music = s.id('task', 'Fade the music between levels', '-s', 's');
  s.write('music.txt', 'fade\n');
  const faded = s.commitAll('Fade the music between levels');
  s.git('revert', '--no-edit', faded);
  const archived = s.id('task', 'A level editor for players', '-s', 'xl');
  s.sp('archive', archived);

  const sheet = s.json('manage', '--start');
  assert.deepEqual(sheet.env, { SPOOL_RUN: sheet.run });
  assert.deepEqual([sheet.project, sheet.open, sheet.proposals], ['demo', 3, { cap: 5, unanswered: 0 }]);
  assert.deepEqual(sheet.saidNo.archived.map((t: { id: string }) => t.id), [archived]);
  assert.deepEqual([sheet.saidNo.dropped, sheet.saidNo.lessons, sheet.saidNo.runs], [[], [], []]);

  const evidence = Object.fromEntries(sheet.shipped.map((t: { id: string; evidence: unknown }) => [t.id, t.evidence]));
  assert.deepEqual(Object.keys(evidence).sort(), [jump, coins].sort(), 'the thread whose commit was reverted has none');
  assert.deepEqual(evidence[jump].own, [{ sha: own.slice(0, 7), date: evidence[jump].own[0].date, subject: 'Raise gravity' }]);
  assert.deepEqual(evidence[coins].finished, [{ id: glow, title: 'Coins glow at sunset so they are readable', summary: 'Coins glow at sunset', commits: [built.slice(0, 7)], words: ['coin', 'readable', 'sunset'] }]);
  assert.equal(sheet.shipped.find((t: { id: string }) => t.id === jump).handsOff, 'in Build');
  assert.deepEqual(sheet.order.build.map((t: { id: string }) => t.id), [jump]);
  assert.deepEqual(sheet.order.backlog.map((t: { id: string }) => t.id), [coins, music]);
  assert.deepEqual(sheet.noWhy.map((t: { id: string }) => t.id), [jump, coins, music]);
  assert.deepEqual([sheet.alike, sheet.cold, sheet.noSize, sheet.tooBig, sheet.order.humanSet], [[], [], [], [], []]);
  assert.deepEqual(sheet.handsOff, [{ id: jump, title: 'Tighten the jump arc', why: 'in Build' }]);
  s.cleanup();
});

test('words usual across a project’s titles are no evidence, so half the backlog does not look shipped', () => {
  // One thread, and a commit that shares three of its four words: that is evidence.
  const lone = project();
  const only = lone.id('task', 'Show each thread on the page', '-s', 's');
  lone.write('page.txt', 'faster\n');
  lone.commitAll('Speed up the page for each thread');
  assert.deepEqual(lone.json('manage', '--start').shipped.map((t: { id: string }) => t.id), [only]);
  lone.cleanup();

  // Five threads that all say "each thread on the page": those words are how this project talks, and say nothing.
  const s = project();
  for (const verb of ['Sort', 'Fold', 'Pin', 'Tag', 'Show']) s.id('task', `${verb} each thread on the page`, '-s', 's');
  s.write('page.txt', 'faster\n');
  s.commitAll('Speed up the page for each thread');
  const sheet = s.json('manage', '--start');
  assert.deepEqual([sheet.open, sheet.shipped], [5, []]);
  s.cleanup();
});

test('a run is the manager’s own: one at a time, never handed to a worker, and kept alive while it writes', () => {
  const s = project();
  const jump = s.id('task', 'Tighten the jump arc');
  assert.match(s.fails('manage', '--end', '-m', 'Nothing'), /no run is open\n {2}Start one: spool manage --start/);
  assert.match(s.sp('manage'), /^No run is open in demo\.\n {2}start one {3}spool manage --start$/);
  assert.match(s.fails('manage', '--start', '--end'), /--start and --end are two ends of a run/);

  const { run } = start(s);
  assert.match(s.fails('manage', '--start'), new RegExp(`a run is open already: ${run}, started just now by Claude\\n {2}Carry on under it \\(SPOOL_RUN=${run}\\), end it`));
  assert.match(s.fails('manage', '--end'), /the headline is missing/);
  const wrong = s.exec(['manage', '--end', '-m', 'Done'], { env: { SPOOL_RUN: jump } });
  assert.match(wrong.err, new RegExp(`SPOOL_RUN names "${jump}", which is not an open run\\n {2}The run that is open is ${run}`));

  // No worker is handed it: not while it is fresh, and not once it has gone quiet.
  assert.match(s.sp('next', '--claim'), /Nothing is ready/);
  const as = under(s, run);
  s.advance(3);
  as('edit', jump, '--size', 's');
  s.advance(3);
  assert.equal(s.json('show', run).item.state, 'active', 'a write three hours in kept its claim fresh');
  s.advance(6);
  assert.equal(s.json('show', run).item.state, 'stale');
  assert.match(s.sp('next', '--claim'), /Nothing is ready/);
  assert.equal(s.json('loop', '--dry-run').queue.length, 0);
  assert.ok(s.json('brief').needsYou.stopped.some((t: { id: string; why: string }) => t.id === run && t.why === 'Claude went quiet on it'));

  // Gone quiet, it is still the open run: carried on, ended, or taken back.
  assert.match(s.sp('manage'), new RegExp(`^A run is open in demo:\\n {2}▷ ${run} `));
  const ended = s.sp('manage', '--end', '-m', 'Sized one thread');
  assert.match(ended, /1 item changed: 1 sized/);
  assert.equal(s.read(`.spool/reports/${run}.md`).split('\n')[3], 'WHAT THIS RUN CHANGED  1 item, from its journal', 'with nothing of the agent’s own, the journal follows the headline');

  // A run that changed nothing still ends, and is still undone as a run.
  const empty = start(s).run;
  assert.match(s.sp('manage', '--end', '-m', 'Nothing to tidy'), /It changed nothing\./);
  assert.match(s.sp('revert', empty), new RegExp(`^${empty} undone: it had changed nothing\\. No code was touched\\.$`));
  assert.equal(s.json('show', empty).item.state, 'dropped');
  s.cleanup();
});

test('a thread is cold by when someone other than a run last touched it, and a new run reads what became of the last one’s ideas', () => {
  const s = project();
  const old = s.id('task', 'Export the board as CSV');
  const warm = s.id('task', 'Fade the music between levels', '-s', 's');
  s.advance(24 * 31);
  s.sp('edit', warm, '-p', '3', '--as', 'human');

  // The first run sizes the old thread and files two ideas. Its own hand on the thread does not warm it.
  const first = start(s);
  assert.match(step(first.sheet, 3), new RegExp(`◇ ${old} {2}p2 {2}Export the board as CSV {2}· proposed · 31 days$`));
  assert.doesNotMatch(step(first.sheet, 3), new RegExp(warm));
  const as = under(s, first.run);
  as('edit', old, '--size', 's');
  const kept = JSON.parse(as('task', 'Show the sprint on the card', '--suggested', 'you look for it', '--json')).task.id as string;
  const refused = JSON.parse(as('task', 'Sort Done by when it shipped', '--suggested', 'the newest first', '--json')).task.id as string;
  s.sp('manage', '--end', '-m', 'Sized one, two ideas');
  s.advance(24 * 2);
  s.sp('drop', refused, '-m', 'I like it as it is', '--as', 'human');

  const second = start(s);
  assert.match(step(second.sheet, 3), new RegExp(`◇ ${old} {2}p2 S {2}Export the board as CSV {2}· proposed · 33 days$`), 'sized two days ago by a run, and cold all the same');
  const no = step(second.sheet, 0);
  assert.match(no, new RegExp(`\\n {2}Dropped, 1:\\n {4}✗ ${refused} {2}p2 {2}Sort Done by when it shipped {2}· dropped · just now by human: I like it as it is\\n`));
  assert.match(no, new RegExp(`\\n {2}Earlier runs, and what became of the ideas each filed, 1:\\n {4}${first.run} {2}2026-02-01 {2}Sized one, two ideas {2}· spool show ${first.run} --report\\n {6}${kept} {2}Show the sprint on the card {2}· not answered yet\\n {6}${refused} {2}Sort Done by when it shipped {2}· dropped: I like it as it is$`));
  assert.match(second.sheet, /\nNew ideas: 5 at most this run\. 1 earlier one still waits for an answer\.\n/);

  // The human writes on the old thread: it is theirs again, and warm.
  s.sp('manage', '--end', '-m', 'Nothing new');
  const note = s.id('capture', 'yes, CSV, for the accountant');
  s.sp('file', note, '--into', old);
  s.sp('revert', second.run, '-m', 'stop filing ideas about Done');
  const third = start(s);
  assert.match(step(third.sheet, 3), /Nothing\./);
  assert.match(step(third.sheet, 4), new RegExp(`${old} .* · hands off: the human wrote on it \\d+m ago`));
  const again = step(third.sheet, 0);
  assert.match(again, new RegExp(`\\n {2}Undone, and why, 1:\\n {4}"stop filing ideas about Done" {2}\\(${second.run}, 2026-02-03\\)\\n`));
  assert.match(again, new RegExp(`\\n {4}${second.run} {2}2026-02-03 {2}undone: stop filing ideas about Done\\n {4}${first.run} `));
  s.cleanup();
});

test('with ten ideas still unanswered a run files none, and says so', () => {
  const s = project();
  for (let i = 1; i <= 10; i++) s.id('task', `Idea number ${i} about something of its own`, '--suggested', `reason ${i}`, '-s', 's');
  const sheet = s.sp('manage', '--start');
  assert.match(sheet, /\nNew ideas: none this run\. 10 earlier ones still wait for an answer, and at 10 the human has enough to read\.\n/);
  assert.deepEqual(s.json('manage').open.tags, ['manage']);
  s.cleanup();
});

test('a run is kept to one project of a folder of them', () => {
  const s = new Sandbox();
  s.sp('init', '--name', 'studio');
  const game = s.cd('games/sky_hop');
  game.sp('init', '--gate');
  const here = s.id('task', 'Tidy the studio readme');
  const there = s.id('task', 'Tighten the jump arc', '-P', 'sky_hop');
  const sheet = s.sp('manage', '--start', '-P', 'sky_hop');
  const run = /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!;
  assert.ok(game.exists(`.spool/items/${run}.md`), 'the run’s thread is the project’s');
  assert.match(sheet, /The backlog of games\/sky_hop {2}1 open thread\n/);
  assert.match(sheet, new RegExp(there));
  assert.doesNotMatch(sheet, new RegExp(here));
  assert.match(s.sp('manage'), /No run is open in studio/);
  assert.match(s.sp('manage', '-P', 'sky_hop'), /A run is open in games\/sky_hop/);
  s.cleanup();
});
