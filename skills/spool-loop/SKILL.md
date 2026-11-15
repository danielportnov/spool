---
name: spool-loop
description: Run the Spool loop, the main way a project gets worked - every few hours (three unless told otherwise) take stock of the spool, show the user one clean table of its threads with difficulty, priority and what needs talking through, recommend what to work on this session, walk them through everything waiting on them, and once they approve, work unattended until the next check-in. Use for /spool-loop [hours], or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "keep going", "what's next - do it", asks you to work unattended, or asks "what needs me", "what's blocked", "what do you need from me", "catch me up" or "what did the agents do".
---

# Spool loop

The loop is how a project gets worked while the human lives their life. They
give you a few minutes; you give them hours of work; you meet again at the
next check-in. Every session has the same shape:

1. **Take stock** of the spool: file, size and order what is in it.
2. **Check in**: one clean table of the spool, what you recommend working on
   this session, and what needs talking through.
3. **Get their go-ahead.** Nothing starts until they approve.
4. **Work**, heads down, until the session's time is up or nothing can move.
5. **Wrap up**, and come back when the next session is due.

**A spool 🧶 holds threads 🧵.** A project's queue of work is its spool, and
each piece of work in it is a thread. Say it that way to the human, with the
emojis. The commands call a thread a task (`spool task`, `<t-id>`), and that
is the only place the word belongs.

`spool` is your tool for the spool. The human never types it, and you never
edit `.spool/` by hand.

## How it was called

| Called as | Means |
| --- | --- |
| `/spool-loop` | Start the loop, a session every 3 hours. Already running in this chat? Keep its schedule and run a session now: this is also how the human gets a check-in whenever they want one. |
| `/spool-loop <hours>` | The same, every `<hours>` hours. Already running? Change it to that. |
| `/spool-loop stop` | Cancel the schedule, say so, and end. |

That is all of it. The schedule calls the plain `/spool-loop` too.

## Start

1. `spool prime worker --context` prints this project's autonomy policy and
   what is ready. Read the policy: it decides what you may settle yourself.
   No `.spool/` here? Tell them in a line, set it up now by the `spool-init`
   skill, then carry on from here.
2. Make sure the schedule is set. See "The schedule".
3. Run a session.

## The schedule

The loop is one recurring job in this chat, set with your harness's scheduler.
**One job, and nothing else:** no timers, no second job, no other prompt.

- **In Claude Code:** `CronList` shows whether a job for `/spool-loop` is
  already set. One is, and no number was given, or the same number? Leave it:
  this is how a session the schedule started finds things. None? `CronCreate`
  one, recurring, every `<hours>` hours, with the prompt `/spool-loop`. A
  different number was given? `CronDelete` it and create the new one.
- **The first return is a full interval away.** A cron's hours usually include
  the one you are in, so pick a minute this hour has already passed, and not
  :00 or :30: at 4:12, `7 1-23/3 * * *` first comes back after 7:07, where
  minute 13 would come back at once. Read the next run in the tool's result.
  Sooner than half an interval? Delete the job and set it again.
- The `loop` skill sets the same job: `/loop <hours>h /spool-loop`.
  If it runs the first firing at once, that is this session; do not run two.
- Tell them once, in a line: when you will be back, by the time the scheduler
  gave and not the one you asked for; that the loop lives in this chat, so the
  chat stays open and the machine awake; and how long the schedule lasts
  (Claude Code ends one after 7 days). `/spool-loop` starts it again.
- The schedule's last firing finds its job gone. That is the loop ending, not
  a reason to set another on your own: run the session, and say that it was
  the last and that `/spool-loop` starts the loop again.
- No scheduler in your harness? Say so, run one session, and offer
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

Then choose **your recommendation**: the threads you would work on this
session, in the order you would take them. Recommending is your job: they
should be able to say "go" and get a good session. Be honest about what the
hours hold: one large thread, or a few medium ones, or a run of small ones.
A recommendation that promises everything tells them nothing.

Read each thread you recommend (`spool show <id>`) far enough to see the
choices it does not settle, and deal with them now, by "Choices the thread
doesn't settle": ask today what is theirs to decide, so no question is
discovered two hours in with nobody there to answer it.

## Check in

The check-in is the one thing the human reads, so it has to tell them at a
glance what the project's features are, what is going on, and what you are
about to do. Make it **cute, concise, professional and organized**:

- **The same layout every time**, so they learn where to look.
- **Concise:** every line earns its place. Names and numbers, not adjectives.
- **Cute, lightly:** the 🧶 and 🧵, the colours, a warm word. Never a joke
  that costs them a second line.
- **Their terms:** a thread's name is the feature or the fix as they would say
  it, a few words, not the title you filed it under. No ids.

Use exactly this layout, leaving out a part that is empty:

```
**🧶 <project>** · <where it stands, in one line>

✅ **Shipped since last time**
- <feature> — <what they can see now>

| 🧵 Thread | Status | Difficulty | Priority | To talk through |
| --- | --- | --- | --- | --- |
| **<feature, in a few words>** | 🟢 Ready | Small | High | — |
| **<feature>** | 🔴 Needs you | Medium | High | <the question, in a few words> |

🎯 **This session I recommend**
1. <thread> — <what they will see when it is done>
2. <thread> — …

<one line: what you are leaving for later, and why>

💬 **To talk through**
1. <question> **a** <option> · **b** <option>. I'd pick **a**: <reason>.

Say **go** and I start. Or tell me what to change.
```

**The table is the whole spool**, one row a thread, what you recommend first
and in order, then the rest by status. More than a dozen rows? Keep the top
ones and end with "+ N more for someday".

| Column | Say |
| --- | --- |
| Status | 🔴 Needs you · 🟣 Needs a plan · 🟡 Blocked · 🔵 In progress · 🟢 Ready · ⚪ On hold |
| Difficulty | from its size: xs Tiny · s Small · m Medium · l Large · xl Huge |
| Priority | p0 Urgent · p1 High · p2 Normal · p3 Someday |
| To talk through | what the two of you need to settle before it can move: an open question, a plan wanting a go-ahead, something too big to start without a word from them. Otherwise — |

**💬 To talk through** is everything waiting on the human, most blocking
first, each ready to answer in a word, numbered straight through so
"1a, 2 go ahead, the rest is fine" settles the lot:

- **Questions.** Work is stopped on these. Options lettered, your
  recommendation and the reason in a line.
- **Plans waiting for a go-ahead.** The approach in a sentence, and its parts.
- **Calls agents made on their own.** Together, briefly: what was decided and
  why. Would they change any?
- **New skills** agents wrote down: the name, and what it is for.

This is the only place the human is asked for anything, so nothing waiting on
them is left out of it. What they have already seen and let stand, say as a
count, not again in full.

## Get their go-ahead

Post the check-in, end your turn, and wait. **Nothing starts until they
approve**: no timer, no starting on silence. Nobody there? Notify them, by
"Reaching them", and the session waits; the next one checks in again.

"Go", "yes", "approved" is enough: start on your recommendation. Anything
else they say, take every part of it:

| They say | Run |
| --- | --- |
| an answer: "the second one", "1a", "no, do X" | `spool answer <d-id> <n or their words>` |
| "go ahead with the plan" | `spool approve <t-id>`, always by id, one plan at a time |
| "not that plan", "that audit missed the point" | `spool revert <t-id> -m "<their words>"` |
| "that's fine", about a call an agent made, shipped work or a new skill | `spool approve <id>` |
| "no, do X", about a call an agent made | `spool answer <d-id> "<their words>"`; the rework is queued |
| "all good", "the rest is fine" | `spool approve --all`; it never covers plans |
| "drop that skill" | `spool drop <s-id>` |
| "do X first", "that one can wait" | `spool edit <id> -p <0-3>` |
| "not now", "park that" | `spool hold <t-id> -m "<their words>"` |
| "start on X", about a thread on hold | `spool release <t-id>` |
| "undo that", "I don't like it" | `spool revert <t-id> -m "<their words>"` |
| anything new: an idea, a bug, a wish | `spool capture "<their exact words>"`, then file it |

Never guess an answer or an approval; if you can't tell which thread they
mean, or whether that was a yes, ask. Their words are the record: pass what
they said through, don't tidy it into your own. An answer to a question is
not a go-ahead for the session: if they changed things without saying go,
show the recommendation as it now stands, numbered, and ask.

Once they approve, say what you are starting on in a line, and go.

## Work

Repeat until the session's time is up, or `spool next --claim` says nothing is ready:

1. Claim the next thread they approved: `spool start <t-id>` prints its
   brief. When those are done, `spool next --claim` hands you the most
   important ready thread. Add `-P <project>` if they asked for one project only.
2. Do it, by the rules in "Working a thread".
3. Hand it in with `spool done`, or leave it waiting on a question with `spool ask`.

Then take the next one, straight away. Do not stop to summarise, to check in,
or to ask whether to continue: the check-in was the time for that. A question
about one thread is never a reason to stop: put it through `spool ask` and
take the next thread.

- Finished what they approved early? Keep going down the spool.
- Time is up when the next session is due. Finish the thread in hand, and do
  not take another: the next check-in should happen on time.
- The human writes while you work? Take it by the table above, and carry on.
  If they ask what you are working on, say the recommendation again,
  numbered, with what is done ticked off.
- If your harness has subagents, give each thread to a fresh one with the brief
  and the "Working a thread" rules. A clean context for each keeps a long
  session sharp.

## Wrap up

First give what shipped a version: see "A version for what shipped". Then a
few plain lines, the first that applies first:

- what is waiting on them, as a count: the next check-in walks through it, and
  `/spool-loop` brings one now;
- what they approved, with what shipped ticked off and how they can see each thing;
- the new version, if there is one;
- when you will be back.

No ids. Then end the turn, and keep the schedule: answers and new feedback
arrive between sessions, and the next one picks them up. A session that finds
nothing it can move says what it is waiting on, and ends.

### A version for what shipped

A session that shipped a change ends by giving the project a new version, so
"it broke in 0.4" means something to everyone. Once per session, after the last
thread, for each project that shipped a change. A session of only audits and
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
act on, at these three moments:

- **A check-in is waiting for their go-ahead** and they are not here: "Spool
  check-in: 3 threads recommended, 2 to talk through. Say go to start."
- **A question stops a thread mid-session:** once, when you ask it, in the
  words of the question: "Spool needs you: outline the coins, or teal?"
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
