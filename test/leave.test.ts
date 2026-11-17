import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from './helpers.ts';

/** A project whose gate is locked: starting work takes the user, at their own terminal or on the page. */
function locked(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--lock');
  return s;
}

/** A project with the gate on, unlocked, and a git history. */
function project(): Sandbox {
  const s = new Sandbox();
  s.sp('init', '--name', 'demo', '--gate');
  s.gitInit();
  s.write('README.md', 'a game\n');
  s.commitAll('Start');
  return s;
}

/** A command the user types at their own terminal. Everything else here is run as an agent runs it. */
function typed(s: Sandbox, ...args: string[]): string {
  const result = s.exec(args, { tty: true });
  if (result.code !== 0) throw new Error(`spool ${args.join(' ')} failed at the terminal: ${result.err || result.out}`);
  return result.out;
}

interface Kept {
  words: string;
  by: string;
  given: string;
  until: string;
  allows: Record<string, unknown>;
  used: { build: number; dropped: number };
  runs: string[];
}

function kept(s: Sandbox): Kept {
  return JSON.parse(s.read('.spool/leave.json')) as Kept;
}

/** A time as the clock shows it where the tests run, the way Spool prints it. */
function clock(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

const HOUR = 3_600_000;
const WORDS = 'work through whatever still seems relevant, I will check in the morning';

test('a build under a leave works up to its count, and is refused after', () => {
  const s = locked();
  const [a, b, c] = ['Tighten the jump arc', 'Make coins readable at sunset', 'Fade the music between levels'].map((title) => s.id('task', title, '-s', 's')) as [string, string, string];

  // With no leave, an agent moves nothing to build here, flag or no flag.
  assert.match(s.fails('build', a), /spool build is the user's alone in demo: its gate is locked/);
  assert.match(s.fails('build', a, '--leave'), /no leave is live\n {2}Without one, only the user moves work to build\. They give a leave with: spool leave "<their words>" --until <time> --build <n>/);

  const given = typed(s, 'leave', WORDS, '--until', '3h', '--build', '2');
  const leave = kept(s);
  assert.equal(given, `A leave is live: "${WORDS}", until ${clock(leave.until)} (3h more): build up to 2\n  It ends by itself then, and nothing renews it. Sooner: spool leave --end`);
  assert.deepEqual(leave, { words: WORDS, by: 'human', given: leave.given, until: new Date(Date.parse(leave.given) + 3 * HOUR).toISOString(), allows: { build: 2 }, used: { build: 0, dropped: 0 }, runs: [] });

  // Each move is counted, logged in the user's words, and signed by the agent that made it.
  assert.match(s.sp('build', a, '--leave', '--as', 'Claude'), new RegExp(`^In build:\\n {2}○ ${a} `));
  assert.match(s.item(a), new RegExp(`Claude: moved to build under the leave: ${WORDS}$`, 'm'));
  assert.equal(s.json('show', a).item.state, 'ready');
  assert.equal(kept(s).used.build, 1);
  assert.equal(s.sp('build', a, '--leave').split('\n').length, 2, 'what is in build already asks nothing of the leave');
  assert.equal(kept(s).used.build, 1);

  // Two more is one too many, and neither is moved.
  assert.match(s.fails('build', b, c, '--leave'), new RegExp(`the leave allows 1 more to be built, not 2: "${WORDS}"`));
  assert.deepEqual([b, c].map((id) => s.json('show', id).item.state), ['proposed', 'proposed']);
  s.sp('build', b, '--leave');
  assert.match(s.item(b), /agent: moved to build under the leave: /, 'unsigned, it is still the agent’s move and not the user’s');

  // Used up, it is refused in the leave's own words, and the lock is as it was.
  assert.match(s.fails('build', c, '--leave'), new RegExp(`the leave's 2 builds are used up: "${WORDS}"\\n {2}Leave the rest proposed and say so in your report\\. Nothing renews a leave: only the user gives another\\.`));
  assert.match(s.fails('build', c), /its gate is locked/);
  assert.equal(s.json('show', c).item.state, 'proposed');
  assert.match(s.sp('leave'), new RegExp(`^A leave is live: "${WORDS}", until ${clock(leave.until)} \\(\\dh more\\): build up to 2\\n {2}given by human at ${clock(leave.given)} · 2 of 2 builds used\\n`));
  s.cleanup();
});

test('a build after --until is refused with the leave’s words, and the leave is gone from then on', () => {
  const s = locked();
  const a = s.id('task', 'Tighten the jump arc', '-s', 's');
  typed(s, 'leave', 'manage this until midnight', '--until', '2h', '--build', '5');
  const until = kept(s).until;

  // A run started under it carries it: on the worksheet, on the run's thread, and in the leave itself.
  const sheet = s.sp('manage', '--start', '--as', 'Claude');
  const run = /^SPOOL_RUN=(t-\w+)$/m.exec(sheet)![1]!;
  assert.match(sheet, new RegExp(`\\n\\nUnder the leave "manage this until midnight", until ${clock(until)} \\(2h more\\): build up to 5\\n {2}to move a thread to build under it {3}spool build <t-id> --leave {6}0 of 5 used\\n\\nThe backlog of demo`));
  assert.match(s.item(run), new RegExp(`Claude: under the leave "manage this until midnight", until ${clock(until)} \\(2h more\\): build up to 5`));
  assert.deepEqual(kept(s).runs, [run]);
  assert.match(s.sp('manage'), new RegExp(`\\n {2}under the leave "manage this until midnight", until ${clock(until)} `));

  s.advance(2);
  assert.match(s.fails('build', a, '--leave'), new RegExp(`the leave ran out at ${clock(until)}: "manage this until midnight"\\n {2}Nothing renews a leave\\. Only the user gives another: spool leave "<their words>" --until <time> --build <n>`));
  assert.equal(s.json('show', a).item.state, 'proposed');
  assert.equal(s.exists('.spool/leave.json'), false, 'removed by the command that found it');
  assert.match(s.item(run), new RegExp(`spool: the leave ran out at ${clock(until)}: "manage this until midnight"`), 'and the open run’s thread says when');

  // Nothing is assumed from it afterwards.
  assert.match(s.fails('build', a, '--leave'), /no leave is live/);
  assert.match(s.sp('leave'), /^No leave is live: agents tidy only, and nothing is built unless you move it\.$/);
  s.sp('manage', '--end', '-m', 'Nothing built');
  assert.match(s.read(`.spool/reports/${run}.md`), /^Nothing built\nUnder the leave "manage this until midnight" \(build up to 5\)\.\nUndo all of it: /, 'the report still names the leave the run was under');
  s.cleanup();
});

test('where the gate is locked an agent cannot give a leave; unlocked, it gives one on the user’s word', () => {
  const s = locked();
  assert.match(s.fails('leave', 'go ahead tonight', '--build', '3'), /spool leave is the user's alone in demo: its gate is locked/);
  assert.equal(s.exists('.spool/leave.json'), false);
  // Asking what is live, and ending one, are never refused: neither opens anything.
  assert.match(s.sp('leave'), /^No leave is live/);
  typed(s, 'leave', 'go ahead tonight', '--build', '3');
  assert.match(s.sp('leave'), /^A leave is live: "go ahead tonight", until /);
  assert.equal(s.sp('leave', '--end'), 'The leave is ended: "go ahead tonight"\n  Agents tidy only again, and nothing is built unless you move it.');
  assert.equal(s.exists('.spool/leave.json'), false);
  s.cleanup();

  const open = project();
  const given = open.sp('leave', 'tidy it up while I am out', '--until', '1h');
  assert.match(given, /^A leave is live: "tidy it up while I am out", until \d\d:\d\d \(60m more\): tidy only\n {2}Nothing is built under it, and nothing you filed is dropped: say --build <n> or --drop-shipped for more\.\n {2}It ends by itself then/);
  assert.deepEqual(kept(open).allows, {});
  const a = open.id('task', 'Tighten the jump arc');
  assert.match(open.fails('build', a, '--leave'), /the leave does not allow building: "tidy it up while I am out"\n {2}It allows this much: tidy only\. Propose the build in your report instead\./);
  open.cleanup();
});

test('undoing a run ends the leave it ran under, and no other night’s', () => {
  const s = project();
  const a = s.id('task', 'Tighten the jump arc');
  const start = () => /^SPOOL_RUN=(t-\w+)$/m.exec(s.sp('manage', '--start'))![1]!;

  // Last night's run had no leave. Tonight's leave is given, and a run starts under it.
  const first = start();
  s.sp('manage', '--end', '-m', 'Nothing to tidy');
  s.sp('leave', 'manage this until midnight', '--until', '4h', '--build', '2');
  const second = start();
  assert.deepEqual(kept(s).runs, [second]);
  assert.doesNotMatch(s.sp('revert', first), /leave/);
  assert.ok(s.exists('.spool/leave.json'), 'undoing another night’s run leaves tonight’s leave alone');

  s.exec(['build', a, '--leave'], { env: { SPOOL_RUN: second } });
  const undone = s.json('revert', second, '-m', 'not what I meant');
  assert.equal(undone.leaveEnded, 'manage this until midnight');
  assert.deepEqual(undone.restored, [a]);
  assert.equal(s.exists('.spool/leave.json'), false);
  assert.equal(s.json('show', a).item.state, 'proposed');
  assert.match(s.fails('build', a, '--leave'), /no leave is live/);

  // A leave given while a run is open is that run's too.
  const third = start();
  s.sp('leave', 'fine, build two of them', '--until', '1h', '--build', '2');
  assert.deepEqual(kept(s).runs, [third]);
  assert.match(s.item(third), /human: under the leave "fine, build two of them", until /);
  assert.match(s.sp('revert', third), /\nThe leave it ran under is ended: "fine, build two of them"$/);
  assert.equal(s.exists('.spool/leave.json'), false);
  s.cleanup();
});

test('a leave ends at a time: 8 the next morning unless said, never more than a day away, and nothing stretches it', () => {
  const s = project();
  // No time said: 8 in the morning, wherever this clock is.
  assert.match(s.sp('leave', 'see you in the morning'), /^A leave is live: "see you in the morning", until 08:00 \(\d+[mh] more\): tidy only\n/);
  const first = kept(s);
  assert.deepEqual([new Date(first.until).getHours(), new Date(first.until).getMinutes()], [8, 0]);
  const span = Date.parse(first.until) - Date.parse(first.given);
  assert.ok(span > 0 && span <= 24 * HOUR, 'the next 8 o’clock, not one further off');

  // One at a time: a second is not a way to stretch the first.
  assert.match(s.fails('leave', 'and build nine', '--build', '9'), /a leave is live already, until 08:00: "see you in the morning"\n {2}Nothing renews a leave or stretches one\. End it first: spool leave --end/);
  assert.deepEqual(kept(s), first);
  s.sp('leave', '--end');
  assert.equal(s.sp('leave', '--end'), 'No leave is live.');

  // However the time is said.
  const until = (said: string): { given: number; until: Date } => {
    s.sp('leave', 'for a while', '--until', said);
    const leave = kept(s);
    s.sp('leave', '--end');
    return { given: Date.parse(leave.given), until: new Date(leave.until) };
  };
  const ninety = until('90m');
  assert.equal(ninety.until.getTime() - ninety.given, 1.5 * HOUR);
  const hands = (said: string) => [until(said).until.getHours(), until(said).until.getMinutes()];
  assert.deepEqual([hands('midnight'), hands('23:30'), hands('6pm'), hands('12am'), hands('noon'), hands('7')], [[0, 0], [23, 30], [18, 0], [0, 0], [12, 0], [7, 0]]);
  const at = until('3h').until.toISOString();
  assert.equal(until(at).until.toISOString(), at, 'a date and time is taken as it is');

  // And what is refused.
  assert.match(s.fails('leave', 'all week', '--until', '25h'), /a leave lasts 24 hours at most\n {2}A leave that outlives the night is a gate left open\. Give another tomorrow\./);
  assert.match(s.fails('leave', 'all week', '--until', '2030-01-01T00:00:00Z'), /a leave lasts 24 hours at most/);
  assert.match(s.fails('leave', 'earlier', '--until', '2020-01-01T00:00:00Z'), /2020-01-01T00:00:00Z has passed/);
  assert.match(s.fails('leave', 'whenever', '--until', 'whenever'), /"whenever" is not a time for a leave to end\n {2}Say when: --until midnight/);
  assert.match(s.fails('leave', 'at 25', '--until', '25:00'), /is not a time for a leave to end/);
  assert.match(s.fails('leave', 'none', '--build', '0'), /--build must be a whole number above zero/);
  assert.match(s.fails('leave', '--build', '2'), /what the user said is missing\n {2}A leave is kept in their words/);
  assert.match(s.fails('leave', 'stop', '--end'), /--end ends a leave; it gives none/);
  assert.equal(s.exists('.spool/leave.json'), false);

  // A file nobody's command wrote, with an end a year away, is no leave.
  s.write('.spool/leave.json', JSON.stringify({ words: 'forever', by: 'human', given: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', allows: { build: 99 } }));
  assert.match(s.sp('leave'), /^No leave is live/);
  s.cleanup();
});

test('under a leave that says so, what has shipped is dropped with its commit as the reason', () => {
  const s = project();
  const shipped = s.id('task', 'Retry a failed check once', '-s', 's');
  const other = s.id('task', 'Fade the music between levels', '-s', 's');
  const note = s.id('capture', 'the music cuts off');
  s.write('retry.txt', 'once\n');
  const sha = s.commitAll('Retry a failed check once').slice(0, 7);
  const why = `Shipped in ${sha}: a failed check is run once more`;

  // No leave, or one that does not say so: refused, and told where the drop goes instead.
  assert.match(s.fails('drop', shipped, '--leave', '-m', why), /no leave is live\n {2}Without one, propose the drop in your report\. They give a leave with: spool leave "<their words>" --until <time> --drop-shipped/);
  s.sp('leave', 'build one tonight', '--until', '2h', '--build', '1');
  assert.match(s.fails('drop', shipped, '--leave', '-m', why), /the leave does not allow dropping: "build one tonight"\n {2}It allows this much: build up to 1\. Propose the drop in your report instead\./);
  s.sp('leave', '--end');

  s.sp('leave', 'drop what has shipped, I trust the log', '--until', '2h', '--drop-shipped');
  // The reason has to name a commit, and the commit has to be there.
  assert.match(s.fails('drop', shipped, '--leave'), /the reason must name the commit that shipped it\n {2}spool drop t-\w+ --leave -m "Shipped in <sha>: /);
  assert.match(s.fails('drop', shipped, '--leave', '-m', 'Shipped a while ago'), /the reason must name the commit that shipped it/);
  assert.match(s.fails('drop', shipped, '--leave', '-m', 'Shipped in deadbee: I am sure of it'), /no commit "deadbee" in /);
  assert.match(s.fails('drop', note, '--leave', '-m', why), /is a note: a leave drops threads that have shipped, and nothing else/);
  assert.equal(s.json('show', shipped).item.state, 'proposed');

  assert.match(s.sp('drop', shipped, '--leave', '-m', why, '--as', 'Claude'), new RegExp(`^Dropped:\\n {2}✗ ${shipped} `));
  assert.match(s.item(shipped), new RegExp(`Claude: dropped: Shipped in ${sha}: a failed check is run once more \\(under the leave: drop what has shipped, I trust the log\\)$`, 'm'));
  assert.equal(kept(s).used.dropped, 1);
  assert.match(s.sp('leave'), /· 1 dropped as shipped\n/);
  assert.match(s.fails('drop', shipped, '--leave', '-m', why), /is already dropped/);

  // The leave allows that and no more; and a drop with no --leave is the drop it always was.
  assert.match(s.fails('build', other, '--leave'), /the leave does not allow building: "drop what has shipped, I trust the log"/);
  s.sp('drop', other, '-m', 'no longer wanted');
  assert.match(s.item(other), /agent: dropped: no longer wanted$/m);
  assert.equal(kept(s).used.dropped, 1);
  s.cleanup();
});

test('a run’s worksheet and report say what the leave allows; a hold is not lifted by one', () => {
  const s = project();
  const a = s.id('task', 'Tighten the jump arc', '-s', 's');
  const parked = s.id('task', 'A Grand Prix mode', '-s', 'm', '--hold', 'after the launch');
  for (let i = 1; i <= 10; i++) s.id('task', `Idea number ${i} about something of its own`, '--suggested', `reason ${i}`, '-s', 's');

  // With no leave the run tidies only, and with ten ideas waiting it files none.
  const plain = s.sp('manage', '--start');
  assert.match(plain, /\n\nNo leave is live: this run tidies only\. What you would build or drop goes in the report, for the user to answer\.\n\nThe backlog of demo/);
  assert.match(plain, /\nNew ideas: none this run\./);
  s.sp('manage', '--end', '-m', 'Nothing to tidy');

  // "Go crazy" is a leave too: the user's own number for tonight stands.
  s.sp('leave', 'go crazy tonight', '--until', '6h', '--build', '3', '--drop-shipped', '--proposals', '50');
  const sheet = s.json('manage', '--start');
  const run = sheet.run as string;
  assert.deepEqual([sheet.leave.words, sheet.leave.allows, sheet.proposals], ['go crazy tonight', { build: 3, dropShipped: true, proposals: 50 }, { cap: 50, unanswered: 10 }]);
  const again = s.sp('manage');
  assert.match(again, /\n {2}under the leave "go crazy tonight", until \d\d:\d\d \(6h more\): build up to 3, drop what has shipped, file up to 50 new ideas\n/);

  // A leave starts what waits for a yes. What the user parked stays parked, and a leave stops nothing.
  assert.match(s.fails('build', parked, '--leave'), /is on hold: after the launch\n {2}A leave does not lift a hold\. Only the user releases it: spool release /);
  assert.match(s.fails('build', a, '--abort', '--leave'), /--leave moves work to build; it stops nothing/);
  assert.equal(kept(s).used.build, 0);

  const built = s.exec(['build', a, '--leave', '--as', 'Claude'], { env: { SPOOL_RUN: run } });
  assert.equal(built.code, 0, built.err);
  s.exec(['manage', '--end', '-m', 'One moved to build'], { env: { SPOOL_RUN: run } });
  const report = s.read(`.spool/reports/${run}.md`);
  assert.match(report, /^One moved to build\nUnder the leave "go crazy tonight" \(build up to 3, drop what has shipped, file up to 50 new ideas\)\.\nUndo all of it: /);
  assert.match(report, new RegExp(`\\nMoved to build {2}1\\n {2}${a} {2}Tighten the jump arc\\n`));
  s.cleanup();
});
