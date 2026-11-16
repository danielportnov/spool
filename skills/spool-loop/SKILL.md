---
name: spool-loop
description: Run the Spool loop, the main way a project gets worked - show every open thread in the spool, add your own ideas as AI suggested, build the threads the user has moved to build (on the Spool page, or by saying so) one by one and nothing else, notify the user when build is empty or something needs them, then watch the spool and start again the moment a thread is moved to build, with a timed check back (three hours unless told otherwise) only where the harness cannot watch. Use for /spool-loop [hours], or when the user says "run the loop", "start the loop", "work the spool", "work the queue", "work through the threads", "keep going", "what's next - do it", asks you to work unattended, or asks "where do things stand", "what's in the spool", "what needs me", "what's blocked", "catch me up" or "what did the agents do".
---

# Spool loop

The loop is simple on purpose. The human should be able to know nothing about
the project and still run it well: **you hold the context, you propose, they
decide what is built, you build it.** Every time it runs, it does the same
three things:

1. **Show the spool:** every open thread, what is in build and what is only
   proposed, with your own ideas added as "AI suggested".
2. **Build what is in build:** the threads the human has moved there, one by
   one, in order. Nothing else. They move threads on the Spool page
   (`spool page`) or by telling you.
3. **Say when it is done:** notify the human when build is empty, or when
   something needs them.

Be brief in the chat. The page holds the detail.

The loop does not run on a clock. It watches the spool, and wakes the moment
the human moves a thread to build or writes on one. There is no budget to
fill and no deadline to hit: build is the plan, and you work it until it is
empty, then listen for more. The schedule is only a check back in.

**A spool 🧶 holds threads 🧵.** A project's queue of work is its spool, and
each piece of work in it is a thread. Say it that way to the human, with the
emojis. The commands call a thread a task (`spool task`, `<t-id>`), and that
is the only place the word belongs.

`spool` is your tool for the spool. The human never types it, and you never
edit `.spool/` by hand.

## How it was called

| Called as | Means |
| --- | --- |
| `/spool-loop` | Show the spool, build what is in build, then watch the spool for more. Where the harness cannot watch, check back every 3 hours. Already running in this chat? Show the spool and carry on. |
| `/spool-loop <hours>` | The same, with a timed check back every `<hours>` hours: for a harness that cannot watch, or as a second line of defence. Already scheduled? Change it to that. |
| `/spool-loop stop` | Stop the watch, cancel any schedule, say so, and end. |

That is all of it. A schedule calls the plain `/spool-loop` too.

## Start

1. `spool prime worker --context` prints this project's autonomy policy and
   what is ready. Read the policy: it decides what you may settle yourself.
   No `.spool/` here? Tell them in a line, set it up now by the `spool-init`
   skill, then carry on from here.
2. Put the spool in order, show it, and build what is in build.
3. When build is empty, watch the spool. See "Watch the spool". Only where
   you cannot, or a number of hours was given, set the schedule: "The schedule".

## Watch the spool

`spool watch` stays up and prints a line the moment the human gives you
something to do, and nothing otherwise:

    build: t-4kq7 Tighter jump                          it can be built now
    reply: t-4kq7 Tighter jump — "snappy, not heavy"    they wrote on a thread
    unfiled: n-9wxa "add a mute button to settings"     a note nobody has filed

- **In Claude Code:** when build is empty, start the `Monitor` tool with the
  command `spool watch`, the longest timeout it allows, and a description
  like "Spool: work for the loop". Then end your turn. Each line wakes you.
- **`build:`** They moved it to build, on the page or by an answer that freed
  it. Build it, by "Build what is in build".
- **`reply:`** Their words are on the thread. Building it? It steers you:
  adjust, and say what changed. Otherwise leave it for whoever builds it.
- **`unfiled:`** File it, by the `spool-record` skill's rules.
- **The watch runs out** after a while, and the harness tells you. That is
  the check back in: look once (`spool next`), then start it again. Keep
  doing so until they say stop.
- **One watch, and only while build is empty.** While you are building you
  need none: `spool next --claim` reads the order fresh after every thread.
- They said stop? End the watch (`TaskStop` in Claude Code), and say so.
- No way to listen to a command in your harness? Use the schedule.

## The schedule

The fallback, for a harness that cannot watch, and the second line of defence
where a number of hours was given. The loop is then one recurring job in this
chat, set with your harness's scheduler.
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
  A place they gave a thread in Build (dragged on the page, or `spool order`)
  comes before any priority; it is theirs, so leave it.

`spool loop --dry-run` then lists every thread that can be worked, in the
exact order `spool next --claim` will hand them out. That is your ranking.

### Add your own ideas

You know this project better than anyone who is not looking at it, so say what
you would add. A gap a user will hit, the follow-up a finished thread makes
obvious, something that will break, a quick win nobody asked for:

    spool task "<the idea>" --suggested "<why, in a line they would agree with>" --size <size> -b "<its spec>"

- It is filed as proposed and marked **AI suggested**: nobody starts it, you
  included, until the human moves it to build.
- Things the product should have, in their terms. Not chores for yourself.
- A few good ones: three a run at most, and none that is already there
  (`spool list --search "<words>"`).
- Their yes: `spool build <t-id>`. Their no:
  `spool drop <t-id> -m "<their words>"`.

**A procedure agents keep working out again is an idea too.**
`spool skills --suggest` lists steps that recur across finished threads with
no skill for them: the threads each was seen in, the words they share, and
the line that offers it, a thread named "Write down how we <the procedure> as
a skill".

- It matches words, not meaning, so read the threads first. One procedure,
  done over and over? Offer it, named as they would say it, with the steps as
  its spec. It counts as one of your three.
- Only the same subject, or `spool skills` already has it? Offer it and
  `spool drop <t-id> -m "<why>"` it yourself, so it is not raised again.
- Their yes makes writing it down a thread like any other. Their no is
  remembered: that procedure is never offered again.

## Show the spool

**Be brief. The page holds the detail; the chat holds what they need to know
now.** They are usually reading on a phone, between other things.

- **Lead with what you need from them**, or with the result. Never make them
  read down to find the question.
- **A few lines, not a document.** No tables, no plans, no lists of reasons in
  the chat. Anything long is on the page: point at it.
- **Their terms.** A thread's name is the feature or the fix as they would say
  it. No ids.
- **Cute, lightly:** the 🧶 and 🧵, a warm word. Never a joke that costs them a
  second line.

`spool overview --brief` prints the spool in a few lines. Show that, in this
shape, leaving out a line that is empty:

```
<what you need from them, or what just happened: one line>

**🧶 <project>** · <N> in build · <N> proposed · <N> need you
Building: <thread> (<why it exists>)
Next in build: <thread> (<why>) · <thread> (<why>)
❓ <a question> **a** <option> · **b** <option>. I'd pick **a**.

The board: <the page's address>
```

- **The page is where the rest is.** If it is not up, start it with
  `spool page -d`, which runs it in the background and opens no browser, and
  give its address. One up already? The same command gives you its address.
  A thread has its own place there: the address, then `#<t-id>`.
- **They ask for the whole list** ("show me everything", "what's in the
  spool")? Then, and only then, `spool overview --table`, exactly as it
  comes: every open thread, numbered, so they can say "build 4" or "drop 9".
  It is grouped by sprint: the one being played first, under its goal and how
  far along it is, then planned sprints, then loose threads. A number is a
  thread's place in line, so numbers in a group can skip; use them as printed.
- **Every thread says why it exists**, beside its name: the `Why:` line of its
  spec. That is what they agree to, so a thread with none is worth fixing:
  `spool check` names them.
- **A plan, an audit, a long answer?** It is the thread's report, read on its
  ticket. In the chat: its headline in a line, and the link.

## Build what is in build

**Nothing is built unless the human has moved it to build.** They do that on
the Spool page, or by telling you: "build 3", "go on the jump", "do the first
two". Their word in chat is `spool build <t-id>`; "not yet" is
`spool propose <t-id>`. You never move a thread to build yourself, whatever
it is and whoever thought of it.

**Where the gate is locked,** `spool build`, `spool play` and `spool release`
refuse you outright: only a person can run them, on the page or at their own
terminal. Told "build that" in the chat? Say you cannot, give them the
thread's place on the page (the page's address, then `#<t-id>`), and they
press ▶. Do not look for a way round it: that refusal is the point.

Repeat until `spool next --claim` says nothing is ready:

1. `spool next --claim` hands you the next thread in build, and its brief. It
   never hands out a proposed one. Add `-P <project>` if they asked for one
   project only.

   **Sign your work.** Add `--as "<your model's name>"`, as in
   `--as "Claude Fable 5.2"`, to every command you run on a thread: `next
   --claim`, `start`, `log`, `ask`, `assume`, `done`. The page shows the
   human who built each thread, and "an agent" tells them nothing.
2. Say what you are starting, in one line: "🧵 Starting thread 2 — <name>:
   <your plan, in a line>."
3. Build it, by the rules in "Working a thread". They can steer while you work.
4. Hand it in with `spool done`, or leave it waiting on a question with
   `spool ask`. Tick it off in a line: "✅ Thread 2 — <name>: <what they can
   see now>."

**Sprints.** They may group threads into a sprint on the page and press play
on it: every thread in it lands in build at once, and you build them like any
others. `spool next` hands them out ahead of other work of the same urgency. A sprint has no dates; it is over when its last thread is done, and
`spool done` says so. Say it too, in a line, and give it its version then.
You may draft one from the backlog: say what it is for
(`spool sprint "<name>" --goal "<what it is for>" --why "<why now>"
--done-when "<what will be true>"`), then fill it
(`spool edit <t-id> --sprint <name>`). Only they play it (`spool play`).
Agreeing to a sprint with a goal is agreeing to a plan: that is what lets
you build the whole of it without stopping.

Then take the next one. The order is read again every time, so a thread they
moved to build while you worked comes up in its turn. A question about one
thread is never a reason to stop: put it through `spool ask` and take the next.

**Nothing in build?** Do not build. Say which one or two proposed threads you
would build first, a line each, for someone who knows nothing about the
project; give the page's address; notify them, by "Reaching them"; and end
the turn.

**You hold the context, so put it where it lasts.** What they tell you about
a thread goes on it in their words (`spool capture`, then
`spool file <note-id> --into <t-id>`), and anything the next agent could not
learn from the code goes there too (`spool log`). The chat is not the
record: the spool is.

**They can steer at any time,** and a comment on the thread in hand changes
it at once: adjust the plan, say what changed in a line, carry on. Everything
else they say, take every part of it:

| They say | Run |
| --- | --- |
| "build 3", "go on that one", "yes, do it" | `spool build <t-id>` |
| "play the sprint", "start sprint 2" | `spool play <sprint>` |
| "put that in the sprint", "take it out" | `spool edit <t-id> --sprint <sprint or none>` |
| "not yet", "take that out of build" | `spool propose <t-id>` |
| an answer: "the second one", "a", "no, do X" | `spool answer <d-id> <n or their words>` |
| "do X first", "X before Y", about threads in build | `spool order <t-id> --first`, or `--before <t-id>` |
| "that one can wait", "X is urgent" | `spool edit <id> -p <0-3>` |
| "park that until the launch" | `spool hold <t-id> -m "<their words>"` |
| "tidy the backlog", "what is duplicated" | `spool list --alike`, then propose merges, archives and drops in a few lines; act only on their yes |
| "archive that", "get it out of the way" | `spool archive <t-id>`; it is kept, and `spool archive --undo <t-id>` brings it back |
| "drop that", "no", about any thread | `spool drop <t-id> -m "<their words>"` |
| "go ahead with the plan" | `spool approve <t-id>`, always by id, one plan at a time |
| "not that plan", "that audit missed the point" | `spool revert <t-id> -m "<their words>"` |
| "undo that", "I don't like it" | `spool revert <t-id> -m "<their words>"` |
| "that's fine", about a call an agent made, shipped work or a new skill | `spool approve <id>` |
| "no, do X", about a call an agent made | `spool answer <d-id> "<their words>"`; the rework is queued |
| "all good", "the rest is fine" | `spool approve --all`; it never covers plans |
| "drop that skill" | `spool drop <s-id>` |
| anything new: an idea, a bug, a wish | `spool capture "<their exact words>"`, then file it |
| how to work: "work the backlog", "stop at midnight", "use subagents" | nothing to record: do it |

Not everything they say is a note. An instruction to you about the work is
done, not recorded, and a go, a no or a choice is the verb above, which
carries their words where they matter. A long message is taken apart: each
idea in it is captured and filed in their words, the rest is done and left in
the chat. Not sure whether it is an idea or an instruction? Record
nothing and act; an idea that matters will come back.

Never guess a go, an answer or an approval. If their reply does not plainly
say it, ask in one line. Their words are the record: pass what they said
through, don't tidy it into your own.

If your harness has subagents, give each thread to a fresh one with the brief
and the "Working a thread" rules, one at a time, and in the background where
it can, so the chat stays free for the human. A clean context for each thread
keeps a long run sharp.

## When nothing is left that can move

1. Give what shipped a version: see "A version for what shipped".
2. Notify them, by "Reaching them".
3. `spool brief` prints the morning brief: a headline, what needs them, the
   few finished threads worth a look and why, the rest a line each, and the
   calls agents made. Show it as it comes, then the new version in a line. It
   is short on purpose; the page has the rest.

They come back and ask "catch me up", "what did the agents do", "what
happened overnight"? That is `spool brief` too; `--since 8h` or
`--since yesterday` when they name a time.

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
5. **Stamp the threads.** `spool edit <t-id> --version <x.y.z>` on each thread
   that shipped in it, so the page shows what went into which version.

The tag stays on this machine. Pushing it, publishing a package and making a
release are the human's calls, in their words. If the policy says this project
is not versioned, skip all of this.

## Reaching them

The human is usually somewhere else, and a notification is how the loop gets
them back. Each one costs them their attention, so send only what they would
act on, at these moments:

- **Build is empty** and threads are proposed: "Spool: nothing in build.
  I'd build the jump next. Move it to build on the page."
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

**A change.** Make it, in small commits. Where the project has a check
(`spool checks` says), `spool done` runs it first and refuses if it fails:
fix what it found and run `spool done` again. The check is the human's. If
it is wrong, ask them (`spool ask`); never switch it off or work round it.
End every commit message with the trailer

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

  With `--for`, the call is a post in that thread, where they accept or overrule it.

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
  file it with `spool task "<title>" --from <note-id>`, and carry on. That is for an idea, a wish,
  feedback or a bug. An instruction to you about the work ("work the backlog until midnight",
  "use subagents") is done, not recorded; a go, a no or a choice is a verb (`spool build`,
  `spool propose`, `spool answer`). In a long message, capture each idea on its own and act on the
  rest. Not sure whether it is an idea or an instruction? Record nothing and act.

### Skills

A thread's brief lists the skills that may help; `spool skills` lists them all.
Used one? Add `--skill <name>` to `spool done`. Did something multi-step that
will come up again, with no skill for it? Write it down:

    spool skill add <name> -d "<what it does and when to use it>" --from <task-id> -b - <<'EOF'
    <the steps, the commands, the traps>
    EOF

It works immediately, and the human sees it in their review.

Spool watches for the ones nobody wrote down: `spool done` says when the steps
you just took match earlier finished threads with no skill for them. It only
sees shared words, so whether that is a skill is the human's call:
`spool skills --suggest` prints the line that offers it. Run it now, with the
steps as its spec while you still know them. On their yes, writing the skill
is a thread, `--from` every thread it was seen in.

### The human's verbs

`spool answer`, `spool approve`, `spool revert`, `spool release` and
`spool archive` act for the human. Run them only when they tell you to. Never answer your own question,
approve your own assumption, or approve your own plan.
