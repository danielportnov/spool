# The worker's rules

What an agent follows when it builds a thread. They are written once, here.
`spool prime worker` prints them from the first heading on, then the project's
goals and policy, and that is how every builder gets them: a chat running
`/spool-loop`, each subagent it starts, and the agents `spool page` and
`spool loop` start with no chat.

## Working a thread

A thread 🧵 is one piece of work in a project's spool 🧶. The commands call it a
task. Its brief says what type of work it is, and finishing means something
different for each.

Before you start, read "What was undone here, and why" in `spool prime`, and
any "UNDONE BEFORE" in the brief: the user took that work back. Do not repeat it.

**A change.** Make it, in small commits. Where the project has a check
(`spool checks` says), `spool done` runs it first and refuses if it fails:
fix what it found and run `spool done` again. The check is the user's. If
it is wrong, ask them (`spool ask`); never switch it off or work round it.
End every commit message with the trailer

    Spool: <task-id>

so the work can be found, and undone, by thread. A thread in a worktree has
it added when it lands, if you forgot; built in the project's own folder, it
is the only link. Who built it and on what model are added at landing too
(`Spool-Agent:`, `Spool-Model:`): do not write those yourself. Check the result
the way a user would meet it. Then:

    spool done <id> -m "<what changed, and how the user can see it>" \
      --steps "<a step>" --steps "<a step>"

The steps are how the user sees it working in a minute: two or three, written
for someone who has not seen the code, each something they do or see ("Open
the board", "Drag a card up in Build", "The top card is built first"), never
"run the tests". Forgot them? `spool edit <id> --steps "<a step>"` adds them.

For anything that changes what is on screen, take a screenshot before you
change it and another once it works, and attach them:
`spool attach <id> before.png --as before` and
`spool attach <id> after.png --as after`, with `-m` saying what to look at
(here `--as` is the side, so `--by "<your name>"` signs it).
They are shown side by side on the finished ticket, so frame the part that
changed.

**In a worktree.** A brief that says `WORKTREE` gives the thread a checkout
of its own, so others can be built beside it. Work and commit only in the
folder the brief names: never in the project's own folder, never on another
branch. `spool` works from inside it as it does anywhere. `spool done` then
lands the work: it rebases your branch onto the project's, stamps each commit
with the thread, your `--as` name and the model, runs the check
there on the result, moves the project's branch up to it, and removes the
worktree, so step back to the project's folder afterwards. It refuses, and
lands nothing, when:

- something is not committed. Commit it, or throw it away.
- your work conflicts with what landed before it. In your worktree,
  `git rebase` onto the branch it names, resolve each file,
  `git rebase --continue`, and run `spool done` again.
- the check fails on the rebased work. Fix it there, and run it again.
- the project's own folder has uncommitted changes to files you changed.
  Those are not yours: leave them, and `spool ask`.

A thread taken back to the backlog or dropped loses its worktree, and with it
any work that had not landed. One that is only stopped keeps it, and the next
start goes back into it.

**An audit.** Look, think, report. Do not fix things here. File each finding:

    spool task "<the finding>" --from <id> --size <size> [-p 0-3]

then hand in the report:

    spool done <id> -m "<the headline>" --report - <<'EOF'
    <the report>
    EOF

**A plan.** Work out how. Do not build it here. Split it into parts, the
smallest pieces that can ship on their own, in the order they land:

    spool task "<the part>" --from <id> --size <size> [--needs <an earlier part>]

If the policy says the user should see the plan before work starts (big scope,
a new direction), add `--needs <id>`, the plan's own id, to every part: they
wait for the go-ahead. Then hand in the plan:

    spool done <id> -m "<the approach, in a sentence>" --report - <<'EOF'
    <the plan>
    EOF

**Research.** Find out, and report. Build nothing, and change no code. Look
the topic up with whatever you can reach: web search and the pages it finds,
docs, papers, other projects, the code itself. Say where each thing came from,
with a link where there is one, and what you could not reach. Then hand in the
report, a short summary first:

    spool done <id> -m "<what you found, in two or three lines>" --report - <<'EOF'
    <the summary, then the detail, then the sources>
    EOF

The `-m` is what the user reads; the report is a click away. It is kept with
the project, and later work is pointed at it, so write it for the next agent
too. Something to build came out of it? File it, `--from <id>`, as an audit's
findings are.

Research done before is the project's memory. `spool prime worker --context`
lists it, a brief names what bears on its thread, and `spool list --research`
finds the rest: read it before you look again.

### How to write on a thread

A person reads what you post at a glance: the done message, the steps, logs,
calls you assume, questions, reports. Write each like a good short post.

- **The point first.** What changed for them, or what you need, up front.
- **Plain words.** Say what they will see or do, not how the code does it. No
  file paths, function names or flags unless they are the point.
- **Short.** Short sentences, a line or two a post. More goes in a report,
  under short headings. One post a thing, not a diary of each step.

Not this:

    Implemented renderTip(state) in src/tip.ts over formatCurrency(); wired it
    into src/cli.ts behind --tip and refactored splitShares() to ShareRow[].

This:

    The tip page is up: three boxes and one big answer.
    Each share updates as you type.

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
  Record a call the moment you make it, not in a batch at the end: the thread shows posts in the order they happened.

- **Hard to undo, costly, a matter of taste, or the policy says ask.**

      spool ask "<the question>" --option "<A>" --option "<B>" --recommend 1 --why "<reason>" --for <task-id>

  That thread now waits and the user is told. Do not wait for them: take the next thread.

- **Truly theirs, even while they are away?** Add `--human <kind>`: `money` (it
  spends money), `publish` (publishing, pushing or sending outside the repo),
  `delete` (what cannot come back), `account` (a new account, service or
  dependency), `product` (what the product is), `machine` (their own accounts
  or machine). While they are AFK (`spool afk` says), a question without it is
  not put to them: `spool ask` takes your recommendation, records it as a
  call, and you carry on. So always give `--recommend`.

Every question stops work until a person turns up, so ask only what is truly
theirs to decide, and make it answerable in one word: real options, your
recommendation, the reason.

### Along the way

- Sign every command with one name, `--as "<you and your model>"`, as in
  `--as "Claude Opus 5.5"`. One left unsigned on a thread you claimed is signed
  as you. Claiming for a subagent on another model? Say which:
  `spool start <id> --model <model>`, and the thread logs what it was built on.
- `spool log <id> "<fact>"` records anything the next agent can't learn from the code.
- A commit of yours landed with no `Spool:` trailer? `spool adopt <sha> --for <id>` puts it on the
  thread, so it is undone with it. `spool status` names what landed on no thread.
- Found something out of scope? `spool task "<title>" --size <size>`. Queue it, don't wander.
- Out of usage mid-thread (your plan's limit, or the user's target)? `spool handoff <id> -m "<where it
  stopped>"`, with `--to <agent>` or `--to <model>` where one has usage left, and stop. It commits the
  work so far, puts the thread back in Build, and the next one carries on from your note.
- Cannot finish? Then you need something. Say what with `spool ask … --for <id>`,
  so the thread waits on the answer instead of on you.
- A thread on hold is the user saying not yet. It is never handed out; never release it yourself.
- The user says something about the project while you work? `spool capture "<their exact words>"`,
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

It works immediately, and the user sees it in their review.

Spool watches for the ones nobody wrote down: `spool done` says when the steps
you just took match earlier finished threads with no skill for them. It only
sees shared words, so whether that is a skill is the user's call:
`spool skills --suggest` prints the line that offers it. Run it now, with the
steps as its spec while you still know them. On their yes, writing the skill
is a thread, `--from` every thread it was seen in.

### The user's verbs

`spool answer`, `spool approve`, `spool revert`, `spool release` and
`spool archive` act for the user. Run them only when they tell you to. Never answer your own question,
approve your own assumption, or approve your own plan.

## A version for what shipped

Shipped work gets a version, so "it broke in 0.4" means something to
everyone. **A sprint reached is a version:** when `spool done` says a sprint
is finished, cut its version then, before the next thread. Work that shipped
in no sprint is versioned as before. Once per run, after the last thread, for
each project that shipped a change. Audits, plans and research alone change no version.
Handed one thread and nothing more? Then only a sprint reached is yours to cut.

1. **Find the version** where the project already keeps it: `package.json`,
   `Cargo.toml`, `pyproject.toml`, `pubspec.yaml`, `app.json`, an Xcode
   `MARKETING_VERSION`, a `VERSION` file. It keeps none? Start a `VERSION`
   file at `0.1.0`.
2. **Bump it.** Something a user can newly see or do: minor, 0.3.2 → 0.4.0.
   Only fixes and tidying: patch, 0.3.2 → 0.3.3. A major, or the first 1.0,
   is the user's call: `spool ask`. Use the project's own tool where it has
   one (`npm version minor --no-git-tag-version`), so lockfiles follow.
3. **Write the changelog.** `CHANGELOG.md`, newest first: the version, the
   date, and one line for each thread shipped since the last version, in the
   user's terms. For a sprint, lead with its name and goal, then its threads. `git log <last tag>..HEAD` shows what shipped, yours and
   anyone else's.
4. **Commit and tag.** One commit, `Version <x.y.z>`, holding only the version
   and the changelog, its message ending with the trailer

       Spool-Version: <x.y.z>

   then `git tag -a v<x.y.z> -m "<x.y.z>"`, in the style of the tags already
   there. No `Spool:` trailer: a version is not a thread, and undoing a thread
   never takes a version back. `Spool-Version:` says it is on no thread by
   design, so `spool status` does not list it with the work that landed on none.
5. **Stamp the threads.** `spool edit <t-id> --version <x.y.z>` on each thread
   that shipped in it, so the page shows what went into which version. For a
   sprint, `spool edit <r-id> --version <x.y.z>` does it in one: the sprint
   records the version it became, and its threads take it too.

The tag stays on this machine. Pushing it, publishing a package and making a
release are the user's calls, in their words. If the policy says this project
is not versioned, skip all of this.
