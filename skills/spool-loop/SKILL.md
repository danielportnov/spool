---
name: spool-loop
description: Make this chat the builder of this project's Spool - it builds the threads the user has moved to build and nothing else, several at once with subagents in git worktrees where it can, says a line as each starts and lands, adds a few ideas of its own as AI suggested, notifies the user when build is empty or something needs them and asks an agent's question in the chat, then watches the spool and starts again the moment a thread is moved to build, with a timed check back (three hours unless told otherwise) only where the harness cannot watch. Use for /spool-loop [hours], /spool-loop stop, or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "build what is in build", "keep going", or asks you to work unattended. Not for questions about the spool or for steering it, which is /spool.
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

1. `spool builder chat`. Typing `/spool-loop` is their word for it. The board
   then starts no agents, so no two builders take one thread, and the reply
   says how many threads to build at once. Refused, because the gate is
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
thread to build yourself, whatever it is and whoever thought of it.

**Several at once, with subagents.** If your harness can start subagents and
the project is a git repository, build several threads side by side, each by
a fresh subagent in a git worktree of its own. How many: what `spool builder`
says, three unless they set it.

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
  tried again, never forced.
- Meanwhile you build nothing yourself. Say one line as each thread starts
  ("🧵 Starting the jump: more gravity, less hang time") and one as each
  lands ("✅ The jump: it lands in half the time"), take the next from build
  as a slot frees, and answer the human.

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
--five-hour <n>`. It says keep building, or stop: then claim nothing new, let
what is building land, and notify them once. No usage tool? Say so once, and
build as if no target were set.

## Watch the spool

`spool watch` stays up and prints a line the moment there is something to
do, and nothing otherwise:

| It prints | Do |
| --- | --- |
| `build: t-4kq7 Tighter jump` | They moved it to Build, or an answer freed it. Build it |
| `reply: t-4kq7 Tighter jump`, and their words | They wrote on a thread. Being built? It steers that work. Otherwise leave it for whoever builds it |
| `unfiled: n-9wxa "add a mute button"` | A note nobody has filed. File it, by the `spool-record` skill |
| `ask: d-3kq2 for t-4kq7 Tighter jump — "Outline, or teal?"`, and its options | An agent needs their call. Ask them in the chat, below |

- **In Claude Code:** start the `Monitor` tool with the command `spool watch`
  and the longest timeout it allows. Then end your turn: each line wakes you.
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
dev on? The `spool-lazy` skill says when.

1. **Notify them,** in one line: "Spool needs you: outline the coins, or
   teal?" In Claude Code it is the `PushNotification` tool.
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

**Nothing in build?** Do not build. Then, once:

1. **Version what shipped** in no sprint, by the worker's rules.
2. **Add your own ideas,** three at most: a gap a user will hit, the
   follow-up a finished thread makes obvious, something that will break.
   `spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "<its spec>"`
   files one as proposed and marked **AI suggested**: nobody starts it, you
   included, until the human moves it to build. None that is already there,
   and no chores for yourself. A step agents keep working out again is an
   idea too: `spool skills --suggest` lists them by the words they share, so
   read the threads first.
3. **Show `spool brief`,** as it comes, and the new version in a line.
4. **Notify them,** in one line, only when they would act on it. Then watch.

| When | Notify |
| --- | --- |
| Build is empty, and threads are proposed | "Spool: nothing in build. I'd build the jump next. Move it to build on the board." |
| Everything is done | "Spool is done: 4 threads shipped, v0.5.0. Nothing left to do." |
| Nothing can move without them | "Spool is waiting on you: 2 questions. Nothing else can move." |
| A question stops one thread: once, as you ask it | "Spool needs you: outline the coins, or teal?" |

Never for one finished thread, or for progress. In Claude Code it is the
`PushNotification` tool. No such tool? `spool ask` runs their notifier.
