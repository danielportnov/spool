---
name: spool-loop
description: Run the Spool loop, the main way a project gets worked - show every open thread in the spool ranked in the order you suggest, add your own ideas as AI suggested, then take the threads one at a time, talking each through in plain words for someone who knows nothing about the project and building it on their word, notify the user when it is done or needs them, and check back every few hours (three unless told otherwise) for anything new or more pressing. Use for /spool-loop [hours], or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "keep going", "what's next - do it", asks you to work unattended, or asks "what needs me", "what's blocked", "what do you need from me", "catch me up" or "what did the agents do".
---

# Spool loop

The loop is simple on purpose. The human should be able to know nothing about
the project and still run it well: **you hold the context, you explain, they
decide, you build.** Every time it runs, it does the same three things:

1. **Show the spool:** every open thread, ranked in the order you suggest
   doing them, with your own ideas added as "AI suggested".
2. **Talk the next thread through, then build it:** what it is, in plain
   words, and your plan. That talk is where the human is in the loop: they
   say go, change it, or pick another. Then you build, and come back with the next.
3. **Say when it is done:** notify the human when nothing is left that can
   move, or when something needs them.

The schedule is only a check back in. Every few hours, look at the spool
again: is there something new, or more pressing? Rank it in, show the list,
carry on. There is no budget to fill and no deadline to hit: the list is the
plan, and you work down it until it is empty.

**A spool 🧶 holds threads 🧵.** A project's queue of work is its spool, and
each piece of work in it is a thread. Say it that way to the human, with the
emojis. The commands call a thread a task (`spool task`, `<t-id>`), and that
is the only place the word belongs.

`spool` is your tool for the spool. The human never types it, and you never
edit `.spool/` by hand.

## How it was called

| Called as | Means |
| --- | --- |
| `/spool-loop` | Show the spool and work it, and check back every 3 hours. Already running in this chat? Keep its schedule, show the spool and carry on. |
| `/spool-loop <hours>` | The same, checking back every `<hours>` hours. Already running? Change it to that. |
| `/spool-loop stop` | Cancel the schedule, say so, and end. |

That is all of it. The schedule calls the plain `/spool-loop` too.

## Start

1. `spool prime worker --context` prints this project's autonomy policy and
   what is ready. Read the policy: it decides what you may settle yourself.
   No `.spool/` here? Tell them in a line, set it up now by the `spool-init`
   skill, then carry on from here.
2. Make sure the schedule is set. See "The schedule".
3. Put the spool in order, show it, and talk the first thread through.

## The schedule

The loop is one recurring job in this chat, set with your harness's scheduler.
**One job, and nothing else:** no timers, no second job, no other prompt. It
is a check back in, never a deadline.

- **In Claude Code:** `CronList` shows whether a job for `/spool-loop` is
  already set. One is, and no number was given, or the same number? Leave it:
  this is how a check back in finds things. None? `CronCreate` one, recurring,
  every `<hours>` hours, with the prompt `/spool-loop`. A different number was
  given? `CronDelete` it and create the new one.
- **The first return is a full interval away.** A cron's hours usually include
  the one you are in, so pick a minute this hour has already passed, and not
  :00 or :30: at 4:12, `7 1-23/3 * * *` first comes back after 7:07, where
  minute 13 would come back at once. Read the next run in the tool's result.
  Sooner than half an interval? Delete the job and set it again.
- The `loop` skill sets the same job: `/loop <hours>h /spool-loop`.
  If it runs the first firing at once, that is this run; do not run two.
- Tell them once, in a line: when you will check back, by the time the
  scheduler gave and not the one you asked for; that the loop lives in this
  chat, so the chat stays open and the machine awake; and how long the
  schedule lasts (Claude Code ends one after 7 days). `/spool-loop` starts it again.
- The schedule's last firing finds its job gone. That is the loop ending, not
  a reason to set another on your own: run as usual, and say that it was the
  last check back in and that `/spool-loop` starts the loop again.
- No scheduler in your harness? Say so, work the spool once, and offer
  `spool loop --watch 300`, which works the spool from a terminal with no chat at all.

## Put the spool in order

`spool overview` shows the whole spool 🧶, and `spool review` what is waiting
on the human. Before showing anything:

- **Unfiled feedback** (`spool inbox`): file each note by what doing it would
  produce: `spool task`, `spool audit` or `spool plan`, each with
  `--from <note-id>`; `spool file <note-id> --into <id>` when it adds to
  a thread already there. Can't tell what they meant? Leave it, and say so in the list.
- **No size:** read the thread and size it: `spool edit <id> --size <size>`.
- **Too big to build in one sitting:** `spool edit <id> --type plan`. Planning
  it is then a thread like any other.
- **The order.** Suggesting it is your job. Priority decides what is picked
  first: p0 it's broken · p1 it's bothering them · p2 default · p3 someday.
  Where their words, or something you can see (a bug that bites now, a thread
  others wait on), put a thread in the wrong place, move it:
  `spool edit <id> -p <0-3>`. Never move something against what they said.

`spool loop --dry-run` then lists every thread that can be worked, in the
exact order `spool next --claim` will hand them out. That is your ranking.

### Add your own ideas

You know this project better than anyone who is not looking at it, so say what
you would add. A gap a user will hit, the follow-up a finished thread makes
obvious, something that will break, a quick win nobody asked for:

    spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "<its spec>"

- It is filed as **AI suggested** and waits under ✨: nobody starts it, you
  included, until the human says yes.
- Things the product should have, in their terms. Not chores for yourself.
- A few good ones: three a run at most, and none that is already there
  (`spool list --search "<words>"`).
- Their yes: `spool release <t-id>`, and it joins the order. Their no:
  `spool drop <t-id> -m "<their words>"`.

## Show the spool

The list is the one thing the human reads, so it has to tell them at a glance
what the project's features are, what is going on, and what you are about to
do. **The same layout every time**, so they learn where to look. Make it
**cute, concise, professional and organized**:

- **Concise:** every line earns its place. Names and numbers, not adjectives.
- **Cute, lightly:** the 🧶 and 🧵, the colours, a warm word. Never a joke
  that costs them a second line.
- **Their terms:** a thread's name is the feature or the fix as they would say
  it, a few words, not the title you filed it under. No ids.

`spool overview --table` prints the list: one header line, one table of every
open thread, one line for what else waits. Show it exactly as it comes. You
may shorten a thread's name to the few words they would use for it; change
nothing else, and never renumber. Above it, add what got done:

```
✅ **Done since last time**
- <feature> — <what they can see now>

**🧶 <project>** · <N> threads open · <N> need you · <N> AI suggested

| # | 🧵 Thread | Difficulty | Priority | Note |
| --- | --- | --- | --- | --- |
| 1 | **<feature being built>** | Large | Normal | 🔵 Being built now |
| 2 | **<feature, in a few words>** | Small | High | |
| 3 | **<feature>** | Medium | High | 🔴 Needs you: <the question> **a** <option> · **b** <option>. I'd pick **a**. |
| 4 | **<feature>** | Small | Normal | ✨ AI suggested: <why>. Say yes and it joins the order. |
| 5 | **<feature>** | Tiny | Normal | ⚪ On hold: "<their words>" |
```

**Every open thread has a row and a number**, so they can point at any of
them: "do 4", "yes to 6", "drop 9". First what is being built, then what comes
next in the order you will take it, then what cannot move and why.

| Column | Says |
| --- | --- |
| # | a number for every thread, yours to point at |
| Difficulty | from its size: Tiny · Small · Medium · Large · Huge |
| Priority | Urgent · High · Normal · Someday |
| Note | 🔵 being built · 🔴 needs you, with the question and its options · 🟡 waiting on something · ✨ AI suggested · ⚪ on hold. Empty when it is simply next. |

Then talk thread 1 through, in the same message.

## Talk it through, then build

One thread at a time, until `spool next` says nothing is ready:

1. `spool next` shows the next thread and its brief, without claiming it. Add
   `-P <project>` if they asked for one project only.
2. **Talk it through.** Write for someone who knows nothing about the project
   and has thirty seconds: no file names, no jargon, nothing they would have
   to look up.

       🧵 Next: thread 1 — <name>.
       What it is: <the feature or the fix, in plain words>.
       Why now: <why it is next>.
       My plan: <what you will build or change, and how they will see it>.
       Go? Or change it, or pick another.

   A choice inside it that is theirs to make goes here too, with your
   recommendation, so it is settled before you start and not halfway through.
3. **Wait for their word.** This is the human in the loop, and the only gate:
   nothing is built before they have had this talk. End your turn.
   - "go", "yes": `spool start <t-id>`, and build.
   - they change the plan: say it back in a line, record it
     (`spool log <t-id> "plan: <what was agreed>"`), `spool start <t-id>`, and build.
   - "not that one", "skip it": talk the next thread through instead; "not
     now" is a hold.
   - they pick another: talk that one through.
   - nobody there: notify them, by "Reaching them", and wait. The next check
     back in shows the list again.
4. **Build it,** by the rules in "Working a thread". They can still steer
   while you work.
5. Hand it in with `spool done`, or leave it waiting on a question with
   `spool ask`. Tick it off in a line: "✅ Thread 1 — <name>: <what they can
   see now>." Then straight on to the next thread's talk.

**You hold the context, so put it where it lasts.** What was agreed in the
talk goes on the thread (`spool log`), what they said goes in their words
(`spool capture`, then `spool file <note-id> --into <t-id>`), and anything the
next agent could not learn from the code goes there too. The chat is not the
record: the spool is.

The order is read again every time, so a thread that became more pressing
while you worked comes up next: say so in a line when the order changes. A
question about one thread is never a reason to stop: put it through
`spool ask` and talk the next thread through.

**They can steer at any time,** and a comment on the thread in hand changes
it at once: adjust the plan, say what changed in a line, carry on. Everything
else they say, at the talk or in the middle of a build, take every part of it:

| They say | Run |
| --- | --- |
| an answer: "the second one", "a", "no, do X" | `spool answer <d-id> <n or their words>` |
| "do X first", "that one can wait" | `spool edit <id> -p <0-3>` |
| "skip that", "not now", "park that" | `spool hold <t-id> -m "<their words>"` |
| "start on X", about a thread on hold | `spool release <t-id>` |
| "yes, add that", about an AI-suggested thread | `spool release <t-id>` |
| "no", about an AI-suggested thread | `spool drop <t-id> -m "<their words>"` |
| "go ahead with the plan" | `spool approve <t-id>`, always by id, one plan at a time |
| "not that plan", "that audit missed the point" | `spool revert <t-id> -m "<their words>"` |
| "undo that", "I don't like it" | `spool revert <t-id> -m "<their words>"` |
| "that's fine", about a call an agent made, shipped work or a new skill | `spool approve <id>` |
| "no, do X", about a call an agent made | `spool answer <d-id> "<their words>"`; the rework is queued |
| "all good", "the rest is fine" | `spool approve --all`; it never covers plans |
| "drop that skill" | `spool drop <s-id>` |
| anything new: an idea, a bug, a wish | `spool capture "<their exact words>"`, then file it |

Never guess an answer or an approval; if you can't tell which thread they
mean, or whether that was a yes, ask. Their words are the record: pass what
they said through, don't tidy it into your own.

If your harness has subagents, give each thread to a fresh one with the brief
and the "Working a thread" rules, one at a time, and in the background where
it can, so the chat stays free for the human. A clean context for each thread
keeps a long run sharp.

## When nothing is left that can move

1. Give what shipped a version: see "A version for what shipped".
2. Notify them, by "Reaching them".
3. Say it in a few plain lines: what got done and how they can see each
   thing, the new version, what is waiting on them, and when you will check back.

Then end the turn, and keep the schedule: answers and new threads arrive in
between, and the next check back in picks them up.

### A version for what shipped

A run that shipped a change ends by giving the project a new version, so
"it broke in 0.4" means something to everyone. Once per run, after the last
thread, for each project that shipped a change. A run of only audits and
plans changes no version.

1. **Find the version** where the project already keeps it: `package.json`,
   `Cargo.toml`, `pyproject.toml`, `pubspec.yaml`, `app.json`, an Xcode
   `MARKETING_VERSION`, a `VERSION` file. It keeps none? Start a `VERSION`
   file at `0.1.0`.
2. **Bump it.** Something a user can newly see or do: minor, 0.3.2 → 0.4.0.
   Only fixes and tidying: patch, 0.3.2 → 0.3.3. A major, or the first 1.0,
   is the human's call: `spool ask`. Use the project's own tool where it has
   one (`npm version minor --no-git-tag-version`), so lockfiles follow.
3. **Write the changelog.** `CHANGELOG.md`, newest first: the version, the
   date, and one line for each thread shipped since the last version, in the
   human's terms. `git log <last tag>..HEAD` shows what shipped, yours and
   anyone else's.
4. **Commit and tag.** One commit, `Version <x.y.z>`, holding only the version
   and the changelog; then `git tag -a v<x.y.z> -m "<x.y.z>"`, in the style of
   the tags already there. No `Spool:` trailer: a version is not a thread, and
   undoing a thread never takes a version back.

The tag stays on this machine. Pushing it, publishing a package and making a
release are the human's calls, in their words. If the policy says this project
is not versioned, skip all of this.

## Reaching them

The human is usually somewhere else, and a notification is how the loop gets
them back. Each one costs them their attention, so send only what they would
act on, at these moments:

- **A thread is ready for their word** and they are not here: "Spool: thread
  2 is ready to start, a snappier jump. Say go."
- **It is done:** the list is finished. "Spool is done: 4 threads shipped,
  v0.5.0. Nothing left to do."
- **Nothing can move without them:** "Spool is waiting on you: 2 questions.
  Nothing else can move."
- **A question stops a thread** while others carry on: once, when you ask it,
  in the words of the question: "Spool needs you: outline the coins, or teal?"

Never for one finished thread among many, or for progress.

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
