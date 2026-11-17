---
name: spool-loop
description: Make this chat the builder of this project's Spool - it builds the threads the user has moved to build and nothing else, several at once with subagents in git worktrees where it can, says a line as each starts and lands, adds a few ideas of its own as AI suggested, notifies the user in a line of the events they picked, such as build empty or a question, and asks an agent's question in the chat, then watches the spool and starts again the moment a thread is moved to build, with a timed check back (three hours unless told otherwise) only where the harness cannot watch. Use for /spool-loop [hours], /spool-loop stop, or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "build what is in build", "keep going", or asks you to work unattended. Not for questions about the spool or for steering it, which is /spool.
---

# Spool loop

`/spool-loop` makes this chat the one that builds. **They decide what is
built, and you build it:** what is in Build, top first, and nothing else.
The loop does not run on a clock. It watches the spool, and wakes the moment
they move a thread to Build. There is no budget to fill and no deadline to
hit. Already running in this chat? Carry on. `/spool-loop <hours>` adds a
timed check back. `/spool-loop stop` ends the watch and any schedule: say
that nothing builds here until they start it again.

## Start

1. `spool builder chat --as "<your model>"`. Typing `/spool-loop` is their
   word for it. The board then starts no agents, and the reply says how many
   threads you build at once: your own count. Refused, because the gate is
   locked? Ask them to pick **Chat** on the board, and wait.
2. `spool prime worker --context`: the goals, the policy, what was undone
   and why, what is ready. No `.spool/` here? Use the `spool-init` skill.
   Notes unfiled (`spool inbox`)? File them, by the `spool-record` skill.
3. Say in one line what you are starting, and where the board is
   (`spool page -d` starts it, or finds the one that is up). Then build.

**The worker's rules are not in this skill.** `spool prime worker` prints
them, and whoever builds a thread reads them first: you, or each subagent.

## Build what is in Build

**Nothing is built unless the human has moved it to build.** You never move a
thread to build yourself, whatever it is and whoever thought of it, unless
they switched **taking over** on: then "When Build is empty" says how.

**Several at once, with subagents.** If your harness can start subagents and
the project is a git repository, build several threads side by side, each by
a fresh subagent in a git worktree of its own. How many: what `spool builder`
says is yours; a claim past it is refused.

- Claim each with `spool next --claim --worktree --as "<your model>"`, or
  `spool start <t-id> --worktree --as "<your model>"`. It prints the brief,
  and the brief names the folder to work in. `--as` signs the work, as in
  `--as "Claude Fable 5.2"`: the board shows who built each thread.
- Give each to a fresh subagent, in the background, with: the brief as
  printed, that folder, the worker's rules (`spool prime worker`), and this:
  work only in that folder; commit there, every commit ending with the
  `Spool: <t-id>` trailer; sign every `spool` command the same way; finish
  with `spool done`, which lands it, or `spool ask` if it needs a decision.
  A question about how something looks gives each option in its report as
  a small mockup or its code. A landing that is refused is fixed there and
  tried again, never forced. Start it on the model and effort the brief's
  `MODEL` line names (`model` and `effort` on Claude Code's Agent tool), the
  smallest that can build it; another? Claim it with `--model <that model>`.
- Meanwhile you build nothing yourself. Say one line as each thread starts
  ("🧵 Starting the jump: more gravity, less hang time") and one as each
  lands ("✅ The jump: it lands in half the time"), notify them of each
  where they picked it (below), take the next from build as a slot frees,
  and answer the human. In caveman mode (`spool caveman`)
  those lines, your notifications and every reply are fragments:
  "Start: the jump." "Landed: the jump. Build empty. http://127.0.0.1:4747/"

One folder and no git? One thread at a time, still by a fresh subagent where
you can: two agents in one folder edit each other's files. No subagents?
Build each yourself: `spool next --claim --as "<your model>"`, then by the
worker's rules.

**They can steer at any time.** Their words on a thread being built change
it at once: pass them on, and say what changed in a line. Everything else
they say is for the `spool` skill, which has the one table.

**Up to their usage target,** where they set one on the board (`spool target`
says). Before you claim each thread, read the plan's usage with your harness's
tool (`get_usage` in the Claude app) and report it: `spool usage --weekly <n>
--five-hour <n> --fable <n>` (Fable's own weekly figure, where your tool shows one). It says keep building, or stop: then claim nothing new, let
what is building land, and notify them once (`budget`). Near the end it says so: say a line on any thread passed by, and tell
building subagents to finish and land, or hand off. No usage tool? Say so once, and build as if no target were set. A subagent out of usage mid-thread runs `spool handoff <id> -m "<where it stopped>"` (`--to Codex` or `--to sonnet`); take a handed-off thread like any in Build. A time to work (`spool until` says) is a budget too: past it, claim nothing new and land what is building.

## Watch the spool

`spool watch` stays up and prints a line the moment there is something to
do, and nothing otherwise:

| It prints | Do |
| --- | --- |
| `build: t-4kq7 Tighter jump` | They moved it to Build, or an answer freed it. Build it |
| `reply: t-4kq7 Tighter jump`, and their words, or the path of a picture or a file they added | They wrote on a thread. Being built? It steers that work: open what they added. Otherwise leave it for whoever builds it |
| `unfiled: n-9wxa "add a mute button"` | A note nobody has filed. File it, by the `spool-record` skill |
| `ask: d-3kq2 for t-4kq7 Tighter jump — "Outline, or teal?"`, and its options | An agent needs their call. Ask them in the chat, below |
| `takeover: skyhop`, and how | They switched taking over on. Build empty? Take the next, below |
| `cleanup: skyhop`, and their words | They pressed Clean Up. Run the pass by `spool prime manager`, every drop and archive a proposal, and reply with the run's link |

- **In Claude Code:** start the `Monitor` tool with the command `spool watch
  --as "<your model>"` (the board shows who watches) and the longest timeout it allows. Then end your turn: each line wakes you.
- **The watch runs out** after a while, and the harness tells you. Look once
  (`spool next`), then start it again, until they say stop.
- **One watch, never two.** Keep it up while Build is empty and while
  subagents build. Building a thread yourself, you need none: `spool next
  --claim` reads the order fresh after every thread.

**The schedule** is the fallback: for a harness that cannot watch, every 3
hours, or every `<hours>` they gave. It is one recurring job in this chat
with the prompt `/spool-loop`, set by your harness's scheduler (`CronCreate`
in Claude Code). **One job, and nothing else:** no timers, no second job, no
other prompt. It is a check back in, never a deadline.

- A job is already set? Leave it, unless they gave another number. Tell them
  once when you will check back, and that this chat must stay open.
- **The first return is a full interval away.** Pick a minute this hour has
  already passed, and not :00 or :30: at 4:12, `7 1-23/3 * * *` comes back
  after 7:07. Sooner than half an interval, by the scheduler's own answer?
  Delete the job and set it again.
- The last firing finds its job gone. That is the loop ending, not a reason
  to set another on your own: say that `/spool-loop` starts it again.

## Ask them in the chat

A subagent that needs a call runs `spool ask … --for <t-id>` and stops. The
watch prints `ask:`, and its report says so too: ask each question once,
whichever tells you first. Building alone? Ask your own the same way. Lazy
dev on? The `spool-lazy` skill says when. AFK on (`spool afk`)? Only a
question marked `--human` comes here; tell each subagent to `--recommend`.

1. **Notify them,** in one line, where they picked `question`: "Spool needs
   you: outline the coins, or teal?" In Claude Code it is the
   `PushNotification` tool.
2. **Ask it in the chat, very directly,** with the `AskUserQuestion` tool:
   the question as asked, its options as the choices, the recommended one
   first, marked so and with the why. About how something looks? Put a
   small mockup of each option, or its code, in its `preview`, so they
   compare them side by side. Several waiting? Ask them together, four at
   most. Fewer than two options, or more than four? Ask it in a line.
   Fill the free slots first: the chat waits on their answer, and the
   subagents build on.
3. **Their pick is their word:** `spool answer <d-id> <n>`, the number it
   had in `spool ask`, or their own words when they wrote some. Run it as
   them, with no `--as`. It frees the thread, the watch prints `build:`, and
   you build it again: its brief carries the answer.

Before you answer, `spool show <d-id>`: answered on the board meanwhile? Then
leave it. They wave it off? It waits on the board. No such tools? Nothing
changes: it waits on the board, and `spool ask` ran their notifier.

## When Build is empty

**Taking over the backlog?** Where they switched it on (`spool takeover`
says), read the usage and report it, as above, then `spool build --takeover
--as "<your model>"`. It moves the top thread they filed to Build, signed by
you, and says so on the thread: build it, with a line ("🧵 Taking over: the
jump"). One at a time, as slots free. Refused? It says why: the target is
reached, or nothing may be taken. Then carry on below.

**Nothing in build?** Do not build. Then, once:

1. **Version what shipped** in no sprint, by the worker's rules.
2. **Add your own ideas,** three at most: a gap a user will hit, the
   follow-up a finished thread makes obvious, something that will break.
   `spool ideate` prints the facts to find them in; it says none? File none.
   `spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "<its spec>"`
   files one as proposed and marked **AI suggested**: nobody starts it, you
   included, until the human moves it to build. None that is already there,
   and no chores for yourself. A step agents keep working out again is an
   idea too: `spool skills --suggest` lists them by the words they share, so
   read the threads first.
3. **Show `spool brief`,** as it comes, and the new version in a line.
4. **Notify them** of `empty`, in one line, where they picked it. Then watch.

## Notify them

**What they picked, and nothing else.** They choose on the board, or say it
here (`spool notify on started`, `off done`, `only …`). Before each one,
`spool notify check <event>`: send it, or quiet. Each is one short line, by
the `PushNotification` tool in Claude Code. No such tool? `spool ask` runs
their notifier.

| Event | When | The line |
| --- | --- | --- |
| `started` | A thread starts | "🧵 Started: the jump" |
| `done` | A thread lands | "✅ Done: the jump, half the hang time" |
| `question` | A question stops a thread: once, as you ask it | "Spool needs you: outline the coins, or teal?" |
| `sprint` | A sprint is finished | "🏁 Feel is done: v0.5.0" |
| `empty` | Build is empty, or everything is done | "Spool: nothing in build. I'd build the jump next." |
| `stuck` | An agent is stuck or refused, or nothing can move without them | "Spool is stuck on the jump: the check fails." |
| `budget` | The usage target stops the run | "Spool stopped: weekly usage at 80%." |
