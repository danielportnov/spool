# A tour of the code

Where things live in `src/`, and how one thread moves through them. To set up, run the tests and
send a change, read [CONTRIBUTING](../CONTRIBUTING.md). For what Spool does, read
[how it works](how-it-works.md).

Every file in `src/` opens with a comment that says what it is for and why. This page is the map;
those comments are the detail.

## The pieces

**The store and the model**

- `model.ts` is the schema. The kinds of item (note, task, decision, skill, sprint), their
  statuses, the `Item` type, and `serialize` and `deserialize`, which turn an item into a markdown
  file and back. Also the small helpers for a thread's body and log, such as `addLog`.
- `frontmatter.ts` reads the small part of YAML that Spool writes, and enough more to survive a
  person or an editor touching a file. Every value comes back as a string or a list of strings.
- `store.ts` is the `Workspace`: the spool you are standing in and every spool below it, read from
  `.spool/items/`. `Workspace.open` finds them and takes a lock file per spool when it is to write;
  `create` makes an item with a random id; `save` writes it to a temp file and renames it into
  place; `get` and `find` look one up.

**Scheduling**

- `schedule.ts` works out everything that is not stored. `taskState` says whether a task is
  proposed, ready, held, blocked, active, stale, done or dropped. `blockers` says what it waits
  on. `ready` gives the order work is built in: urgency first, then the smallest, with one pick in
  four kept for large work. `review` gathers what waits on the human.

**The commands**

- `cli.ts` only parses arguments and routes. `run(argv, ctx)` finds the command, opens the
  workspace, calls it and prints the `Result`. It is the one door: the tests, the page and the MCP
  server all go through it. With no command it is `status`, or, typed at a real terminal, the
  queue full-screen (`tui.ts`).
- `commands.ts` is the `COMMANDS` table: every verb, its options, its help line, and the rules
  about what may follow what. A command with `write` runs under the lock; one with `human` acts as
  the human unless told otherwise; `before` does slow work, such as running a check, before the
  lock is taken, and `after` lets go of whatever `before` took.
- `context.ts` is `Ctx`, the outside world passed in, and the user's own settings in
  `~/.config/spool/config.json`. It also runs the notifier.
- `git.ts` is the undo. It finds a thread's commits by their `Spool:` trailer, and
  `revertCommits` takes them back in one new commit, never touching `.spool/`, all or nothing.
- `journal.ts` is the undo for the queue itself, which git does not hold. With `SPOOL_RUN` set,
  `record` gives the workspace a recorder: `save` tells it of every item written, and it keeps
  the item's file as it was and a line in the run's journal under `.spool/runs/<id>/`. `undoRun`
  puts each item back, and leaves alone any that changed since.
- `manage.ts` is `spool manage`, the manager's worksheet. `gather` reads the spool, the git log,
  the changelog and the tests into the facts a pass over the backlog starts from, with no model
  and no judgment; `worksheetText` prints them. `changesOf` folds a run's journal into the report
  `--end` writes. A run's own thread is told by `isRun` in `model.ts`, and `ready` never hands
  it out.
- `leave.ts` is `spool leave`: how far agents may go while the human is away, and until when,
  kept in `.spool/leave.json`. `settle` gives the live leave and removes one that has run out.
  `buildUnderLeave` and `dropUnderLeave` are what `spool build --leave` and `spool drop --leave`
  ask before they act, and count each use.
- `worktree.ts` gives a thread a git worktree of its own, so several can be built at once.
  `openWorktree` makes it inside `.spool/worktrees/`, on the branch `spool/<id>`, and `workDir`
  says where a thread is worked. `land` rebases the branch onto the checkout, runs the check in
  the worktree and fast-forwards the checkout to it, one thread at a time under `landingLock`.
  `closeWorktree` removes it. `findHome` in `store.ts` sends a command run inside a worktree to
  the project's own queue, never to the copy the worktree carries.

**Rendering**

- `render.ts` is everything printed: `statusText`, `overviewTable`, `reviewText`, `showText`, and
  `brief`, which is all a worker needs to do one task. `itemJson` is the `--json` twin of an item.
  `paint` adds colour only where there is a terminal to see it.

**The loop, the watch and the page**

- `loop.ts` is `spool loop`: `runLoop` claims the next ready task, starts the agent command with
  `PREAMBLE`, the worker's rules and the brief on stdin, and looks again when it exits.
- `watch.ts` is `spool watch`. Once a second it reads the spool and prints a line for each change
  the loop should wake for (`changes`): work that can be built, a reply, an unfiled note. While it
  runs it leaves a file in the temp folder, which the page reads to say a chat is watching.
- `server.ts` is `spool page`: the command (`servePage`) and a server on `127.0.0.1`
  (`startPage`) that sends the page and the board, and takes each click as a POST. `moveThread`
  is a drag: a command, and a word to the runner the server holds.
- `board.ts` reads the spool for the page. `board` is every card in its column, each thread as a
  conversation, and what waits on the human; `diffOf` is what a finished thread changed.
- `act.ts` runs one command in-process as the human (`act`). `change` turns each click into one.
- `engine.ts` is the `Runner`: it builds what is in Build when agents are on, the same way
  `runLoop` does. It picks the next thread, gives it a worktree, and settles the thread when its
  agent has gone. There is no HTTP in it.
- `session.ts` is one agent on one thread, and the only file that knows how one is started and
  heard: `startSession` runs the command and reads what it prints, `askRouter` asks Fable first
  where it chooses the model, and `endAgent` ends an agent and everything it started.
- `upkeep.ts` is `Upkeep`: it restarts the page when the code on disk changes, and, where the
  page runs from a checkout of Spool that is also the project it shows, runs `npm run build` there
  once Build and Building are empty.
- `client/` is the page the browser gets, as three strings: `page.html.ts` (the markup, and the
  `PAGE` the three are joined into), `page.css.ts` and `page.js.ts`. One self-contained page,
  with no build step.
- `page.ts` is what is left of the one file these seven were: it passes their names on, for
  whatever still imports them from it.
- `detach.ts` is `spool page -d`, `--status` and `--stop`, and the record every page leaves under
  `~/.config/spool/pages/` saying which process holds it and at what address (`pageUp`), which is
  how a second start finds the first. `startDetached` starts a page in the background and says
  when it is listening.
- `tui.ts` is Spool in the terminal: what bare `spool` opens at a real terminal (`openQueue`). It
  is a client of the page's server, not a runner. Two pure functions do the work: `frame` draws a
  screen, as lines of text, from the board and the interface's own `State`, and `key` turns a key
  into a new state and maybe an `Action`, which is one of the page's POSTs. `watchQueue` is the
  loop around them: it asks for the board about once a second, draws, and posts. Its top line
  opens with the yarn mark's one-line form (`mark.ts`).
- `term.ts` is the terminal under it, written by hand: `width`, `cut`, `fit` and `wrap` measure
  text as a terminal shows it, `keys` reads raw input into key names, and `openTerm` takes the
  screen over and gives it back on every way out.
- `stream.ts` reads what a `claude -p` agent prints with `--output-format stream-json`
  (`streaming` adds the flags, `hearLine` reads a line) into the short lines a card shows, and
  says where each run's stream is kept (`transcriptFile`).
- `pictures.ts` keeps pictures with a thread, in `.spool/runs/<id>/files/` beside its transcripts:
  `attach` takes them in by their first bytes and within the limits, `picturesOf` lists them with
  who attached each and the caption from the thread's log, and `pictureFile` is the only way the
  server finds one to serve. `attach.ts` is the `spool attach` command over it; the page's paste
  and drop write the bytes to a file and run that command. On the page, `client/pictures.js.ts`
  and `pictures.css.ts` draw them.

**Agents and models**

- `agent.ts` decides which model works a thread and at what effort. `pickFor` takes the human's
  pick first, then Fable's answer where the agent is Claude (asked with `routerCommand`, read with
  `parseRoute`), then what the size suggests (`suggestion`). `commandFor` puts the pick into the
  agent command. Anything but a plain model name or a known effort is left out.

**Skills, and the rules agents are primed with**

- `skills/` (beside `src/`) holds the four skills, and `rules/worker.md` the rules for building a
  thread. Each rule is written in one of those files and nowhere else. The worker's rules are in
  no skill: everyone who builds reads them, and a chat that only steers never does.
- `builtin.ts` reads those files: `rules` pulls the recorder's rules out of its skill,
  `workerRules` and `section` read the worker's, and `installSkills` copies the skills to where
  an agent finds them, keeping a copy someone edited.
- `prime.ts` is `spool prime`: `prime` puts together a role's rules, read from those files, with
  the project's policy and what is waiting now. `DEFAULT_POLICY` is the `policy.md` that `init`
  writes.
- `skills.ts` keeps the ledger of skills agents write for a project, and `matchSkills` finds the
  ones that fit a task, for its brief.
- `suggest.ts` notices steps that keep recurring across finished tasks with no skill for them
  (`suggestSkills`). It matches words, not meaning.

**MCP**

- `mcp.ts` is `spool mcp`: a Model Context Protocol server over stdio. `toolFor` makes one tool
  from each command in `COMMANDS`, leaving out the set-up ones, and each call is run through the
  same `run` the shell uses.

## One thread, start to finish

1. **`spool capture "the jump feels floaty"`.** `run` in `cli.ts` finds `capture` in `COMMANDS`,
   parses its options and opens the workspace with `Workspace.open`, locked because the command
   writes. `capture` calls `ws.create` to make a note, `n-…`, and `save` writes it to
   `.spool/items/` through `serialize`. `related` points at threads that look like it. `run`
   closes the workspace, which lets go of the lock.
2. **`spool task "Tighter jump" --from n-…`.** `fileWork` makes the task and quotes the note's
   words into it (`quoteNote`). The note becomes `filed`. Where the gate is on, the task is
   `proposed`, and `claim` refuses it to any agent.
3. **`spool build t-…`.** The human moves it to Build. `byTheHuman` refuses an agent where the gate
   is locked. The task becomes `open`, with `moved to build` on its log. On the page, ▶ is the same
   command: `change` calls `act`, which calls `run` with `human: true`.
4. **It is picked up.** `ready` in `schedule.ts` puts it in line, and `spool watch` prints
   `build: t-…` for a chat's loop. An agent runs `spool start t-…` (or `spool next --claim`):
   `claim` marks it `active` and signs it, and `brief` prints what to do. With `--worktree`,
   `openWorktree` gives it a checkout of its own first, and the brief names that. With no chat, `runLoop`
   or the page's `Runner` claims it instead, picks the model through `agent.ts`, and starts the
   agent with `prime(ws, 'worker')` and the brief on stdin.
5. **The work.** The agent commits, and each commit message ends with `Spool: t-…`.
6. **`spool done t-… -m "what changed"`.** First, before the lock, `beforeDone` runs the project's
   check (`runCheck`) if the user named one; a failure stops the finish. A thread with a worktree
   is landed there as well: `land` rebases it onto the checkout, runs the check in the worktree,
   and fast-forwards the checkout to it. Then `done` collects the commits with
   `trailerCommits`, skipping any `isReverted`, marks the task `done` with its summary, ends its
   sprint if it was the last (`settleSprint`), and says what is now ready.
7. **`spool revert t-… -m "why"`.** `undoWork` gathers the task's commits and calls
   `revertCommits`, which applies the reverse of each, newest first, leaving `.spool/` out. If any
   will not come off cleanly, every file is put back and nothing is committed. Otherwise there is
   one new commit with a `Spool-Revert:` trailer. Calls an agent made for that task alone are
   dropped with it. The task is reopened, raised to High unless it was Urgent, with the human's
   reason in its body.
