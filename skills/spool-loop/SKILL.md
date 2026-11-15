---
name: spool-loop
description: Work this project's Spool docket on your own - take the next task, do it, hand it in, take the next - until nothing can move without the human, and with a number come back every that many hours to do it again. Use for /spool-loop [hours], or when the user says "run the loop", "work the queue", "work through the docket", "keep going", "what's next - do it", or asks you to work unattended.
---

# Spool loop

You are a worker on this project's Spool docket. Your job is to keep work moving
without the human: take the next task, do it properly, hand it in, take the
next. You stop only when nothing is left that can move without them.

`spool` is your tool for the docket. The human never types it, and you never
edit `.spool/` by hand.

## Start

1. `spool prime worker --context` prints this project's autonomy policy and
   what is ready. Read the policy: it decides what you may settle yourself.
   If it says there is no `.spool/` here, tell them to run `/spool-init`, and stop.
2. Given a number (`/spool-loop 2`)? Set the schedule now. See "Coming back".
3. Run a pass.

## A pass

Repeat until `spool next --claim` says nothing is ready:

1. `spool next --claim` hands you the most important ready task and its brief.
   Add `-P <project>` if they asked for one project only.
2. Do it, by the rules in "Working a task".
3. Hand it in with `spool done`, or leave it waiting on a question with `spool ask`.

Then take the next one, straight away. Do not stop to summarise, to check in,
or to ask whether to continue. A question about one task is never a reason to
stop the pass: put it through `spool ask` and take the next task.

If your harness has subagents, give each task to a fresh one with the brief and
the "Working a task" rules. A clean context for each task keeps a long pass sharp.

## When the pass ends

Nothing is ready, so tell the human in a few plain lines, the first that applies first:

- what is waiting on them, as a count, and that `/spool-blockers` walks through it;
- what shipped, and how they can see each thing;
- when you will be back, if a schedule is set.

No ids and no tables unless they ask.

## Coming back

`/spool-loop <hours>` means: a pass now, and another every `<hours>` hours in
this chat, until the human says stop.

- Use your harness's scheduler for recurring prompts. In Claude Code that is
  the `loop` skill: `/loop <hours>h /spool-loop`. The scheduled prompt is the
  bare `/spool-loop`, so each firing is one pass and never schedules again. If
  the scheduler runs the first firing at once, that is this pass; do not run two.
- No scheduler? Say so, run one pass, and offer `spool loop --watch 300`, which
  works the docket from a terminal with no chat at all.
- A pass that finds nothing ready costs one command. Say in a line what it is
  waiting on and end the turn. Keep the schedule: answers and new feedback
  arrive between passes, and the next pass picks them up.

## Working a task

The brief says what type of work the task is. Finishing means something
different for each.

**A change.** Make it, in small commits. End every commit message with the trailer

    Spool: <task-id>

so the work can be found, and undone, by task. Check the result the way a user
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

### Choices the task doesn't settle

Check it wasn't settled already: `spool list -k decision --search "<topic>"`

- **Easily undone, and the policy allows it.** Decide, keep moving, leave a receipt:

      spool assume "<the question>" --chose "<what you did>" --why "<reason>" --for <task-id>

- **Hard to undo, costly, a matter of taste, or the policy says ask.**

      spool ask "<the question>" --option "<A>" --option "<B>" --recommend 1 --why "<reason>" --for <task-id>

  That task now waits and the human is told. Do not wait for them: take the next task.

Every question stops work until a person turns up, so ask only what is truly
theirs to decide, and make it answerable in one word: real options, your
recommendation, the reason.

### Along the way

- `spool log <id> "<fact>"` records anything the next agent can't learn from the code.
- Found something out of scope? `spool task "<title>" --size <size>`. Queue it, don't wander.
- Cannot finish? Then you need something. Say what with `spool ask … --for <id>`,
  so the task waits on the answer instead of on you.
- Work on hold is the human saying not yet. It is never handed out; never release it yourself.
- The human says something about the project while you work? `spool capture "<their exact words>"`,
  file it with `spool task "<title>" --from <note-id>`, and carry on.

### Skills

A task's brief lists the skills that may help; `spool skills` lists them all.
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
