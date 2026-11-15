---
name: spool-loop
description: Run the Spool loop, the main way a project gets worked - every few hours (three unless told otherwise) take stock of the spool, size and order its threads, show the user the whole spool and a proposal of what to ship before the next check-in, ask everything up front, then work unattended until then. Use for /spool-loop [hours], or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "keep going", "what's next - do it", or asks you to work unattended.
---

# Spool loop

The loop is how a project gets worked while the human lives their life. They
give you a few minutes; you give them hours of work; you meet again at the
next check-in. Every cycle has the same shape:

1. **Take stock** of the spool: file, size and order what is in it.
2. **Check in**: the whole spool, your proposal for this cycle, and every
   question you can see coming, in one message.
3. **Work**, heads down, until the cycle's time is up or nothing can move.
4. **Wrap up**, and come back when the next cycle is due.

**A spool 🧶 holds threads 🧵.** A project's queue of work is its spool, and
each piece of work in it is a thread. Say it that way to the human, with the
emojis. The commands call a thread a task (`spool task`, `<t-id>`), and that
is the only place the word belongs. To the human, a cycle is "this loop".

`spool` is your tool for the spool. The human never types it, and you never
edit `.spool/` by hand.

## How it was called

| Called as | Means |
| --- | --- |
| `/spool-loop` | Start the loop, a cycle every 3 hours. Already running in this chat? Keep its schedule and run a cycle now. |
| `/spool-loop <hours>` | The same, every `<hours>` hours. Already running? Change it to that. |
| `/spool-loop again` | The schedule firing: the next cycle is due. The human never types this. |
| `/spool-loop go` | The check-in window closing: start work. The human never types this. |
| `/spool-loop stop` | Cancel the schedule and any timer, say so, and end. |

## Start

1. `spool prime worker --context` prints this project's autonomy policy and
   what is ready. Read the policy: it decides what you may settle yourself.
   No `.spool/` here? Tell them in a line, set it up now by the `spool-init`
   skill, then carry on from here.
2. Called by the human, with a number or without: set the schedule. See "The schedule".
3. Run a cycle. Called with `go`, the check-in is already done: go straight to "Work".

## The schedule

The loop is a real recurring job in this chat, set with your harness's scheduler.

- **In Claude Code:** `CronList` shows whether a job for `/spool-loop again` is
  already set. None? `CronCreate` one, recurring, every `<hours>` hours, with
  the prompt `/spool-loop again`. One at a different interval? `CronDelete` it
  and create the new one. Never leave two.
- **The first return is a full interval away.** A cron's hours usually include
  the one you are in, so pick a minute this hour has already passed, and not
  :00 or :30: at 4:12, `7 1-23/3 * * *` first comes back after 7:07, where
  minute 13 would come back at once. Read the next run in the tool's result.
  Sooner than half an interval? Delete the job and set it again.
- The `loop` skill sets the same job: `/loop <hours>h /spool-loop again`.
  If it runs the first firing at once, that is this cycle; do not run two.
- Tell them once, in a line: when you will be back, by the time the scheduler
  gave and not the one you asked for; that the loop lives in this chat, so the
  chat stays open and the machine awake; and how long the schedule lasts
  (Claude Code ends one after 7 days). `/spool-loop` starts it again.
- Called with `again` and the job is gone? It ran out. Run this cycle, and say
  in the wrap-up that it was the last.
- No scheduler in your harness? Say so, run one cycle, and offer
  `spool loop --watch 300`, which works the spool from a terminal with no chat at all.

## Take stock

`spool overview` shows the whole spool 🧶, each thread 🧵 under its colour,
with what is ready in the order it will be picked. `spool review` shows what
is waiting on the human, with the options for each question. Then put the
spool in order, before any work:

- **Unfiled feedback** (`spool inbox`): file each note by what doing it would
  produce: `spool task`, `spool audit` or `spool plan`, each with
  `--from <note-id>`; `spool file <note-id> --into <id>` when it adds to
  a thread already there. Can't tell what they meant? Leave it, and ask at the check-in.
- **No size:** read the thread and size it: `spool edit <id> --size <size>`.
- **Too big to build in one sitting:** `spool edit <id> --type plan`. Planning
  it is then a thread like any other.
- **The order.** Priority is the human's urgency and it decides what is picked
  first: p0 it's broken · p1 it's bothering them · p2 default · p3 someday.
  Where their words, or something you can see (a bug that bites now, a thread
  others wait on), put a thread in the wrong place, move it:
  `spool edit <id> -p <0-3>`. Never move something against what they said.

Then write **the proposal**: the key things you intend to ship before the next
check-in, chosen from the open threads, in the order you will take them. Be
honest about what the hours hold: one large thread, or a few medium ones, or
a run of small ones. A proposal that promises everything tells them nothing.

Read each thread in the proposal (`spool show <id>`) far enough to see the
choices it does not settle, and deal with them now, by "Choices the thread
doesn't settle": ask today what is theirs to decide, so no question is
discovered two hours in with nobody there to answer it.

## Check in

One message, in three parts, always in this order. The emojis and the colours
are how a person takes it in at a glance, so keep them. No ids.

**1. 🧶 The spool.** Everything in it, the way `spool overview` printed it:
the same coloured groups in the same order, one line per thread, each starting
with 🧵, the title in plain words. Add a group at the top, **✅ Shipped since
last time**, with how they can see each thing, and name any call you made on
your own. Leave out empty groups; cut a long group to its first few and say
how many more.

| | Group | Means |
| --- | --- | --- |
| ✅ | Shipped | Finished since the last check-in. |
| 🔴 | Needs you | A question only they can answer, or a plan waiting for their go-ahead. |
| 🟣 | Break down | Too big to build in one go; it needs a plan first. |
| 🟡 | Blocked | Waiting on something else: say what. |
| 🔵 | In progress | An agent has it now. |
| 🟢 | Ready | Can start, in the order it will be taken. |
| ⚪ | On hold | They said not yet. |

**2. 🎯 The proposal.** Under its own heading, so it cannot be missed: "In the
next `<hours>` hours I propose to ship:", then a numbered list, each line a
thread 🧵 and what they will be able to see when it is done. Then one line on
what you are leaving for a later loop, and why. Then ask: take the proposal as
it is, or say which threads they want instead. One word from them must be
enough to accept it.

**3. ❓ Questions.** Numbered, each with its options lettered, your
recommendation and the reason in a line, so "1a, 2c" answers them all. Plans
waiting for a go-ahead go here too. Nothing to ask? Say so.

End with the time you start on the proposal unless they say otherwise.

Then give them the window: ten minutes, less if they are plainly here.

- **In Claude Code:** `CronCreate` a one-shot (`recurring: false`) ten minutes
  from now with the prompt `/spool-loop go`, and end your turn. A turn that is
  still running hears nothing, so do not wait inside it.
- No timer? If the human started this cycle, end your turn and wait for their
  reply. If the schedule did, go straight to work.

**They reply in the window.** Take every part of it:

| They say | Run |
| --- | --- |
| an answer: "the second one", "1a", "no, do X" | `spool answer <d-id> <n or their words>` |
| "go ahead with the plan" | `spool approve <t-id>`, always by id |
| "do X first", "that one can wait" | `spool edit <id> -p <0-3>` |
| "not now", "park that" | `spool hold <t-id> -m "<their words>"` |
| "start on X", about a thread on hold | `spool release <t-id>` |
| "undo that", "I don't like it" | `spool revert <t-id> -m "<their words>"` |
| anything new: an idea, a bug, a wish | `spool capture "<their exact words>"`, then file it |

Never guess an answer or an approval; if you can't tell which thread they
mean, ask. Then cancel the timer, say the proposal as it now stands, numbered,
and start work. `go` arriving after work has started means nothing: end the turn.

**Nobody replies.** `go` arrives: work the proposal as you made it. Questions
still open keep their threads waiting, and everything else moves.

## Work

Repeat until the cycle's time is up, or `spool next --claim` says nothing is ready:

1. Claim the next thread of the proposal: `spool start <t-id>` prints its
   brief. When the proposal is done, `spool next --claim` hands you the most
   important ready thread. Add `-P <project>` if they asked for one project only.
2. Do it, by the rules in "Working a thread".
3. Hand it in with `spool done`, or leave it waiting on a question with `spool ask`.

Then take the next one, straight away. Do not stop to summarise, to check in,
or to ask whether to continue: the check-in was the time for that. A question
about one thread is never a reason to stop: put it through `spool ask` and
take the next thread.

- Finished the proposal early? Keep going down the spool.
- Time is up when the next cycle is due. Finish the thread in hand, and do not
  take another: the next check-in should happen on time.
- The human writes while you work? Take it by the table above, and carry on.
  If they ask what you are working on, say the proposal again, numbered, with
  what is done ticked off.
- If your harness has subagents, give each thread to a fresh one with the brief
  and the "Working a thread" rules. A clean context for each keeps a long
  cycle sharp.

## Wrap up

A few plain lines, the first that applies first:

- what is waiting on them, as a count, and that `/spool-blockers` walks through it;
- the proposal, with what shipped ticked off and how they can see each thing;
- when you will be back.

No ids and no tables unless they ask. Then end the turn, and keep the schedule:
answers and new feedback arrive between cycles, and the next one picks them
up. A cycle that finds nothing it can move says what it is waiting on, and ends.

## Reaching them

The human is usually somewhere else, and a notification is how the loop gets
them back. Each one costs them their attention, so send only what they would
act on, at these three moments:

- **A check-in is posted** on a cycle the schedule started, or with questions
  in it: "Spool check-in: 2 questions. Starting on the jump at 7:47."
- **A question stops a thread mid-cycle:** once, when you ask it, in the words
  of the question: "Spool needs you: outline the coins, or teal?"
- **Nothing can move without them**, at the wrap-up: "Spool is waiting on you:
  3 questions. Nothing else can move."

Never for a finished thread, for progress, or for a wrap-up with nothing waiting.

- **In Claude Code:** the `PushNotification` tool: a desktop notification, and
  their phone when Remote Control is connected. One line, under 200
  characters, leading with what they would act on. "Not sent" means they are
  already here; carry on.
- No notification tool? `spool ask` already runs their notifier command, if
  they set one. Do nothing more.

## Working a thread

A thread 🧵 is one piece of work in a project's spool 🧶. The commands call it a
task. Its brief says what type of work it is, and finishing means something
different for each.

**A change.** Make it, in small commits. End every commit message with the trailer

    Spool: <task-id>

so the work can be found, and undone, by thread. Check the result the way a user
would meet it. Then:

    spool done <id> -m "<what changed, and how the human can see it>"

**An audit.** Look, think, report. Do not fix things here. File each finding:

    spool task "<the finding>" --from <id> --size <size> [-p 0-3]

then hand in the report:

    spool done <id> -m "<the headline>" --report - <<'EOF'
    <the report>
    EOF

**A plan.** Work out how. Do not build it here. Split it into parts, the
smallest pieces that can ship on their own, in the order they land:

    spool task "<the part>" --from <id> --size <size> [--needs <an earlier part>]

If the policy says the human should see the plan before work starts (big scope,
a new direction), add `--needs <id>`, the plan's own id, to every part: they
wait for the go-ahead. Then hand in the plan:

    spool done <id> -m "<the approach, in a sentence>" --report - <<'EOF'
    <the plan>
    EOF

### Size: how much would have to change

`xs` a line or a value · `s` one function or screen · `m` several files ·
`l` cuts across the project · `xl` a project in itself (always a plan)

The queue hands out the smallest work first within a priority, and gives one
pick in four to large work, so quick wins and big things both keep moving.

- Size wrong? `spool edit <id> --size <size>`
- Too big for one sitting? `spool edit <id> --type plan`, and split it. Never half-build.

### Choices the thread doesn't settle

Check it wasn't settled already: `spool list -k decision --search "<topic>"`

- **Easily undone, and the policy allows it.** Decide, keep moving, leave a receipt:

      spool assume "<the question>" --chose "<what you did>" --why "<reason>" --for <task-id>

- **Hard to undo, costly, a matter of taste, or the policy says ask.**

      spool ask "<the question>" --option "<A>" --option "<B>" --recommend 1 --why "<reason>" --for <task-id>

  That thread now waits and the human is told. Do not wait for them: take the next thread.

Every question stops work until a person turns up, so ask only what is truly
theirs to decide, and make it answerable in one word: real options, your
recommendation, the reason.

### Along the way

- `spool log <id> "<fact>"` records anything the next agent can't learn from the code.
- Found something out of scope? `spool task "<title>" --size <size>`. Queue it, don't wander.
- Cannot finish? Then you need something. Say what with `spool ask … --for <id>`,
  so the thread waits on the answer instead of on you.
- A thread on hold is the human saying not yet. It is never handed out; never release it yourself.
- The human says something about the project while you work? `spool capture "<their exact words>"`,
  file it with `spool task "<title>" --from <note-id>`, and carry on.

### Skills

A thread's brief lists the skills that may help; `spool skills` lists them all.
Used one? Add `--skill <name>` to `spool done`. Did something multi-step that
will come up again, with no skill for it? Write it down:

    spool skill add <name> -d "<what it does and when to use it>" --from <task-id> -b - <<'EOF'
    <the steps, the commands, the traps>
    EOF

It works immediately, and the human sees it in their review.

### The human's verbs

`spool answer`, `spool approve`, `spool revert` and `spool release` act for the
human. Run them only when they tell you to. Never answer your own question,
approve your own assumption, or approve your own plan.
