import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shipped } from '../src/builtin.ts';
import { EVENTS } from '../src/notices.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { Sandbox } from './helpers.ts';

// Every command it names is pinned by "every command a skill tells an agent to run exists", in test/init.test.ts.
// Building several at once is in test/loop-several.test.ts.

test('the loop skill has one job: make this chat the builder', () => {
  const loop = shipped('spool-loop');
  const flat = loop.replace(/\s+/g, ' ');
  assert.deepEqual([...loop.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Start', 'Build what is in Build', 'Watch the spool', 'Ask them in the chat', 'When Build is empty', 'Notify them']);
  assert.match(flat, /`\/spool-loop` makes this chat the one that builds\. \*\*They decide what is built, and you build it:\*\* what is in Build, top first, and nothing else\./);

  // It starts by telling the board a chat builds here, which is theirs to say: typing /spool-loop says it.
  assert.match(flat, /1\. `spool builder chat`\. Typing `\/spool-loop` is their word for it\. The board then starts no agents, so no two builders take one thread, and the reply says how many threads to build at once\./);
  assert.match(flat, /Refused, because the gate is locked\? Ask them to pick \*\*Chat\*\* on the board, and wait\./);
  assert.match(flat, /2\. `spool prime worker --context`: the goals, the policy, what was undone and why, what is ready\. No `\.spool\/` here\? Use the `spool-init` skill\./);

  // The gate: only the human moves a thread to build, and nothing else is ever built.
  assert.match(flat, /\*\*Nothing is built unless the human has moved it to build\.\*\* You never move a thread to build yourself, whatever it is and whoever thought of it, unless they switched \*\*taking over\*\* on: then "When Build is empty" says how\./);
  // Taking over: the CLI picks the thread and checks the target; the chat signs the move and builds it.
  assert.match(flat, /\*\*Taking over the backlog\?\*\* Where they switched it on \(`spool takeover` says\), read the usage and report it, as above, then `spool build --takeover --as "<your model>"`\. It moves the top thread they filed to Build, signed by you, and says so on the thread/);
  assert.match(loop, /^\| `takeover: skyhop`, and how \| They switched taking over on\. Build empty\? Take the next, below \|$/m);
  assert.match(flat, /\*\*Nothing in build\?\*\* Do not build\./);
  // Agents sign their work, the lead and each subagent.
  assert.match(flat, /`--as` signs the work, as in `--as "Claude Fable 5\.2"`: the board shows who built each thread\./);
  assert.match(flat, /sign every `spool` command the same way/);
  // Each subagent runs on the model its claim names: the smallest that can build the thread, so building several spends less.
  assert.match(flat, /Start it on the model and effort the brief's `MODEL` line names \(`model` and `effort` on Claude Code's Agent tool\): the smallest that can build it\./);
  // They can steer while it builds; everything else they say is /spool's.
  assert.match(flat, /\*\*They can steer at any time\.\*\* Their words on a thread being built change it at once: pass them on, and say what changed in a line\. Everything else they say is for the `spool` skill, which has the one table\./);

  // What it no longer holds: the table of what they say, the reply's shape, the worker's rules.
  assert.doesNotMatch(loop, /\| They say \| Run \||## Show the spool|## Put the spool in order|spool overview/);
  assert.match(flat, /\*\*The worker's rules are not in this skill\.\*\* `spool prime worker` prints them, and whoever builds a thread reads them first: you, or each subagent\./);
  // Up to their usage target: read before each thread, reported, and a stop is a stop.
  assert.match(flat, /\*\*Up to their usage target,\*\* where they set one on the board \(`spool target` says\)\. Before you claim each thread, read the plan's usage with your harness's tool \(`get_usage` in the Claude app\) and report it: `spool usage --weekly <n> --five-hour <n>`\. It says keep building, or stop: then claim nothing new, let what is building land, and notify them once \(`budget`\)\. No usage tool\? Say so once, and build as if no target were set\./);
  // Short enough to be read every time: it was 553 lines, and grew six for the usage target, 29 for questions asked in the chat, two for the model,
  // nine for taking over and ten for the notifications the human picks.
  assert.ok(loop.trimEnd().split('\n').length <= 183, `${loop.trimEnd().split('\n').length} lines`);
});

test('the loop watches the spool, and falls back to one scheduled job', () => {
  const loop = shipped('spool-loop');
  const flat = loop.replace(/\s+/g, ' ');
  // It reacts, it does not run on a clock: no budget, no deadline, no timers.
  assert.match(flat, /The loop does not run on a clock\. It watches the spool, and wakes the moment they move a thread to Build\. There is no budget to fill and no deadline to hit\./);

  // Each line of the watch is something to do.
  assert.match(loop, /^\| `build: t-4kq7 Tighter jump` \| They moved it to Build, or an answer freed it\. Build it \|$/m);
  assert.match(loop, /^\| `reply: t-4kq7 Tighter jump`, and their words, or the path of a picture or a file they added \| They wrote on a thread\. Being built\? It steers that work: open what they added\. Otherwise leave it for whoever builds it \|$/m);
  assert.match(loop, /^\| `unfiled: n-9wxa "add a mute button"` \| A note nobody has filed\. File it, by the `spool-record` skill \|$/m);
  assert.match(loop, /^\| `ask: d-3kq2 for t-4kq7 Tighter jump — "Outline, or teal\?"`, and its options \| An agent needs their call\. Ask them in the chat, below \|$/m);
  assert.match(flat, /start the `Monitor` tool with the command `spool watch` and the longest timeout it allows\. Then end your turn: each line wakes you\./);
  assert.match(flat, /\*\*The watch runs out\*\* after a while, and the harness tells you\. Look once \(`spool next`\), then start it again, until they say stop\./);
  // One watch. It stays up while subagents build, since the chat itself is then free to hear a thread moved to Build.
  assert.match(flat, /\*\*One watch, never two\.\*\* Keep it up while Build is empty and while subagents build\. Building a thread yourself, you need none: `spool next --claim` reads the order fresh after every thread\./);

  // The schedule is one job that checks back in.
  assert.match(flat, /\*\*The schedule\*\* is the fallback: for a harness that cannot watch, every 3 hours, or every `<hours>` they gave\. It is one recurring job in this chat with the prompt `\/spool-loop`/);
  assert.match(flat, /\*\*One job, and nothing else:\*\* no timers, no second job, no other prompt\. It is a check back in, never a deadline\./);
  assert.match(flat, /A job is already set\? Leave it, unless they gave another number\./);
  assert.match(flat, /\*\*The first return is a full interval away\.\*\* Pick a minute this hour has already passed, and not :00 or :30[^?]*Sooner than half an interval, by the scheduler's own answer\? Delete the job and set it again\./);
  assert.match(flat, /The last firing finds its job gone\. That is the loop ending, not a reason to set another on your own: say that `\/spool-loop` starts it again\./);
  assert.doesNotMatch(loop, /spool-loop again|spool-loop go|one-shot|session|go-ahead for/);
  // Stop ends both.
  assert.match(flat, /`\/spool-loop stop` ends the watch and any schedule: say that nothing builds here until they start it again\./);
});

test("in a chat that builds, an agent's question comes to the human as a Claude notification and a question in the chat, and their pick is the answer", () => {
  const loop = shipped('spool-loop');
  const flat = loop.replace(/\s+/g, ' ');
  // It hears of a question from the watch or the subagent's report, and asks it once.
  assert.match(flat, /A subagent that needs a call runs `spool ask … --for <t-id>` and stops\. The watch prints `ask:`, and its report says so too: ask each question once, whichever tells you first\./);
  // Building alone, its own questions go the same way; lazy dev decides for itself when to bring one up.
  assert.match(flat, /Building alone\? Ask your own the same way\. Lazy dev on\? The `spool-lazy` skill says when\./);
  // A notification first, then the question itself, very directly, with Claude's own tools.
  assert.match(flat, /1\. \*\*Notify them,\*\* in one line, where they picked `question`: "Spool needs you: outline the coins, or teal\?" In Claude Code it is the `PushNotification` tool\./);
  assert.match(flat, /2\. \*\*Ask it in the chat, very directly,\*\* with the `AskUserQuestion` tool: the question as asked, its options as the choices, the recommended one first, marked so and with the why\./);
  // Mockups to compare when it is about how something looks: the subagent draws them, the chat shows them side by side.
  assert.match(flat, /About how something looks\? Put a small mockup of each option, or its code, in its `preview`, so they compare them side by side\./);
  assert.match(flat, /A question about how something looks gives each option in its report as a small mockup or its code\./);
  // Asking holds the chat, so the free slots are filled before it.
  assert.match(flat, /Fill the free slots first: the chat waits on their answer, and the subagents build on\./);
  // Their pick is their word: answered as them, which frees the thread to be built again.
  assert.match(flat, /3\. \*\*Their pick is their word:\*\* `spool answer <d-id> <n>`, the number it had in `spool ask`, or their own words when they wrote some\. Run it as them, with no `--as`\. It frees the thread, the watch prints `build:`, and you build it again: its brief carries the answer\./);
  // Never answered twice, and with no such tools the board and the notifier are as they were.
  assert.match(flat, /Before you answer, `spool show <d-id>`: answered on the board meanwhile\? Then leave it\. They wave it off\? It waits on the board\./);
  assert.match(flat, /No such tools\? Nothing changes: it waits on the board, and `spool ask` ran their notifier\./);
});

test('when build is empty the loop versions what shipped, adds a few ideas of its own, shows the brief and notifies', () => {
  const loop = shipped('spool-loop');
  const flat = loop.replace(/\s+/g, ' ');
  assert.match(flat, /1\. \*\*Version what shipped\*\* in no sprint, by the worker's rules\./);
  // Its own ideas go in the spool as AI suggested, capped, and wait like everything else.
  assert.match(flat, /2\. \*\*Add your own ideas,\*\* three at most: a gap a user will hit/);
  assert.match(flat, /`spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "<its spec>"` files one as proposed and marked \*\*AI suggested\*\*: nobody starts it, you included, until the human moves it to build\./);
  assert.match(flat, /None that is already there, and no chores for yourself\./);
  assert.match(flat, /`spool ideate` prints the facts to find them in; it says none\? File none\./);
  // A procedure that keeps recurring is one of those ideas, offered and never written unasked.
  assert.match(flat, /A step agents keep working out again is an idea too: `spool skills --suggest` lists them by the words they share, so read the threads first\./);
  assert.match(flat, /3\. \*\*Show `spool brief`,\*\* as it comes, and the new version in a line\./);

  // It reaches the human through the harness's own notifications, where they picked it.
  assert.match(flat, /4\. \*\*Notify them\*\* of `empty`, in one line, where they picked it\. Then watch\./);
});

test('the loop notifies of what the human picked, one line each, and nothing else', () => {
  const loop = shipped('spool-loop');
  const flat = loop.replace(/\s+/g, ' ');
  assert.match(flat, /\*\*What they picked, and nothing else\.\*\* They choose on the board, or say it here \(`spool notify on started`, `off done`, `only …`\)\. Before each one, `spool notify check <event>`: send it, or quiet\. Each is one short line, by the `PushNotification` tool in Claude Code\./);
  // One row for each event spool notify knows, in its order, and each line short.
  const rows = loop.split('\n').filter((l) => /^\| `[a-z]+` \|/.test(l)).map((l) => l.slice(2).split(' | '));
  assert.deepEqual(rows.map((r) => r[0]!.replace(/`/g, '')), [...EVENTS]);
  for (const r of rows) assert.ok(r[2]!.length <= 60, r[2]);
  // A thread starting and landing is said in the chat, and notified only where they picked it.
  assert.match(flat, /notify them of each where they picked it \(below\)/);
});

test("the loop's description says it builds, and leaves questions and steering to /spool", () => {
  const description = String(parseFrontmatter(shipped('spool-loop')).data.get('description'));
  assert.match(
    description,
    /^Make this chat the builder[\s\S]*moved to build and nothing else[\s\S]*several at once with subagents[\s\S]*AI suggested[\s\S]*watches the spool[\s\S]*three hours unless told otherwise[\s\S]*\/spool-loop \[hours\], \/spool-loop stop[\s\S]*which is \/spool\.$/,
  );
});

test('spool builder chat tells the loop how many to build at once, and is not refused where a chat already builds', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop', '--lock');
    // Not a git repository: one thread at a time, and it says why.
    assert.match(s.exec(['builder', 'chat'], { tty: true }).out, /^A chat builds skyhop: say \/spool-loop in a Claude Code chat there\. The page starts no agents\. The chat builds 1 thread at once: it is not a git repository, so its threads cannot have a worktree each\.$/);
    s.gitInit();
    s.write('.gitignore', '.home/\n');
    s.commitAll('start');
    // The human picked Chat. An agent starting the loop says the same again: nothing changes, so the lock has nothing to refuse.
    assert.match(s.sp('builder', 'chat'), /The page starts no agents\. The chat builds 3 threads at once, each in a worktree of its own\.$/);
    assert.match(s.sp('builder', '--at-once', '3'), /The chat builds 3 threads at once/);
    // A change is still theirs alone.
    assert.match(s.fails('builder', 'headless'), /human's alone.*locked/s);
    assert.match(s.fails('builder', 'chat', '--at-once', '2'), /human's alone/);
    assert.equal(s.json('builder').builder, 'chat');
    assert.match(s.exec(['builder', '--at-once', '1'], { tty: true }).out, /The chat builds 1 thread at once\.$/);
  } finally {
    s.cleanup();
  }
});

test('caveman mode is a setting every skill reads: spool caveman says and switches it, and the skills say how to answer in it', () => {
  const s = new Sandbox();
  try {
    s.sp('init', '--name', 'skyhop');
    assert.match(s.sp('caveman'), /Caveman mode is off/);
    assert.match(s.sp('caveman', 'on'), /Caveman mode is on/);
    assert.match(s.sp('caveman'), /is on/);
    assert.match(s.sp('caveman', 'off'), /is off/);
    s.fails('caveman', 'loud');
    for (const name of ['spool', 'spool-loop', 'spool-record'] as const) assert.match(shipped(name), /caveman mode/i, name);
  } finally {
    s.cleanup();
  }
});
