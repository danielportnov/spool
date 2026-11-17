# Changelog

What shipped in each version of Spool, newest first.

## 0.24.0 · 2026-11-17

**Spool in the terminal (sprint finished):** type `spool` and see the queue and every running agent, steer
any of them, and open any in Claude Code.
- `spool open <thread>` opens the thread's own Claude Code session; when you quit, hand it back or leave it stopped.
- In `spool`, `r` replies to an agent, Esc interrupts, `y` `a` `n` answer it, `o` opens it in Claude Code.
- `spool loop` builds on the board's own engine: several threads at once, each with a transcript.
- A finished sprint notifies you once, and the brief says what it took: runs, minutes, turns, cost.

**Many agents, your limits**
- A roster: Claude and Codex each with their own thread count, sizes and usage target, and who is watching.
- A Usage-to-Development slider per brand moves each size's model down to save usage or up for power.
- Fable's own weekly usage is counted; near its limit, a thread goes to Opus instead.
- Near the usage limit or the end of a time budget (`spool for 2h`, `spool until 1:00`), agents take only
  what fits and wrap up; `spool handoff` passes a thread to an agent with usage left.
- AFK mode: agents take their own recommendation and leave a call, asking only what truly needs you.

**The board**
- Settings: one panel for every setting, each row with its command.
- A 🧹 Clean Up button: an agent proposes what to archive, delete and re-prioritize, and you say yes or no;
  under take-over the chat tidies the backlog itself once a day.
- Dictate a thread or a reply with 🎙.
- Research mode: a thread whose agent researches and brings back a report, kept for later work.
- Posts on a thread read in the order they happened, and Spool's own lines read in plain words.
- Headless is greyed out; `/spool-steer` steers without recording.

**Lineage and safety**
- Every landed commit gets a git note with its thread, calls and builder (kept on this machine).
- A thread's worktree refuses `git push`.
- The board remembers threads an agent walked away from across restarts.
- A drag on the board no longer gets lost when a slow refresh lands mid-drag.
- `.spool/` is never committed: the queue is private, and it has been removed from the whole history.

## 0.23.0 · 2026-11-17

**Lineage: who did what, and how to take it back**
- Every commit that lands names its thread, its agent and its model in git itself (`Spool:`,
  `Spool-Agent:`, `Spool-Model:`), stamped by `spool done` as it lands.
- Every line on a thread names who wrote it and on what model; a claim takes `--model` so the log
  says what actually ran.
- `spool why <commit | file:line | thread>` shows the whole chain, from your words to the commits,
  and a thread's ticket shows it as Lineage.
- Work that landed on no thread is listed in the status, the brief and doctor; `spool adopt` puts
  a commit on its thread.
- A journal of every edit to the spool, with the copy before it: `spool history` and `spool undo`.
- Undo an undo: reverting a thread again puts its work back. A revert that collides with later
  work names those threads, and `--with-later` takes them back with it.
- Undoing a thread puts it in the backlog with your reason, not straight back into Build;
  "Undo, to be done again now" is its own choice.

**The board**
- The box at the top is gone: Done cards worth a look carry a small ★ that says why.
- A card shows how many posts are new on its thread since you last opened it.
- Reply on a thread nobody is building and "Typing…" shows at once, then a small model answers.
- Add pictures, PDFs and text files to a thread: paste, drop or the paperclip.
- Codex's posts carry the ChatGPT mark and its full model name.
- Headless is greyed out for now; `spool builder headless` still switches to it.
- In Chat mode the board rebuilds Spool and reloads a few seconds after each thread lands.
- A command inside a project finds the board started in a folder above it.

**Agents at work**
- A check that fails under the board's agents goes back to the same session once, with its output.
- A board agent quiet for ten minutes is marked on its card and tells you.
- Agents write on a thread like a short post: the point first, in plain words.
- The manager's rules print with `spool prime manager`, its proposals have a yes and a no each on
  the run's thread, and "tidy the backlog" runs the pass from the chat.
- Codex built a Spool thread end to end.

**CI and packaging**
- The tests pass on Linux: a path shown by its name however short, a phone layout that gives way
  for wider fonts, and test runs kept off the runner's own config.
- Ready to publish to npm as `spool-ai` (`npm install -g spool-ai`); publishing builds and checks first.

## 0.22.0 · 2026-11-16

- The chat takes over the backlog: in Chat mode a **Take over** switch in the board's header (or
  `spool takeover on`) lets the chat that builds move threads you filed to Build itself, top first,
  one at a time, while the usage is under your target. Never an AI-suggested one, one on hold or
  one waiting on a question. Each says so on its thread and in the brief, and `spool revert` takes
  it back. The switch opens a menu of its settings.
- Caveman mode: `spool caveman on` and Spool answers in the fewest words, in every project, until
  `spool caveman off`. Saying "caveman" in a message does it for that reply alone.
- Ideation: say "come up with ideas" and `spool ideate` hands the agent a worksheet of the goals,
  what shipped, the open threads and your notes; it files up to five new ideas as AI suggested, none
  repeating a thread already there. The loop's own ideas come from the same worksheet.
- Notification settings: pick what tells you from the bell on the board, or `spool notify`: a thread
  started, a thread done, a question, a sprint finished, Build empty, an agent stuck, the budget
  reached. In Chat mode each is one line in the Claude app; Headless runs your notifier for the
  same picks. By default, questions, Build empty, stuck and the budget.

## 0.21.0 · 2026-11-16

- Questions are asked on their thread alone: the board's brief, the Waiting on you strip and the
  cards no longer list them apart. A card says **Needs a call from you**, and you answer on its thread.
- In Chat mode, an agent's question comes to you through the chat: `spool watch` prints an `ask:`
  line the moment one is asked, and the chat that builds sends a Claude notification, asks it there
  with its options as buttons (mockups side by side when it is about looks), and records your pick
  on the thread, which is then built again.
- Each thread is built by the smallest model its size can do, with no Fable step first: xs Haiku,
  s Sonnet, m Opus, l Opus at high effort, xl Opus at xhigh. A thread whose last run did not work
  (undone, or left unfinished) is built one model up. In Chat mode the claim names the model, and
  the loop starts its subagent on it. A thread's own Model and Effort still win.

## 0.20.0 · 2026-11-16

- A usage target for Chat mode: in the board's header a meter beside Agents shows your plan's
  weekly or 5-hour usage against a target you set with a slider or a number (or
  `spool target --weekly 80`). The chat that builds reads its usage before each thread and keeps
  working until it reaches the target, then takes no new thread.

## 0.19.0 · 2026-11-16

- Spool can be off: `spool disable` switches it off in a project, so it is one tool you reach for
  and not the way every chat has to work. The Spool block comes out of `AGENTS.md` and
  `CLAUDE.md`, so no agent is sent to the queue, and every command there refuses, saying so. The
  queue is kept as it was, a page already up starts no new work, and the folder above leaves the
  project out. `spool enable` puts the block back where it was. `--all` does every spool in a
  folder and below it.

## 0.18.0 · 2026-11-16

- `/spool-lazy`, lazy dev mode for a chat: it builds what is in Build and decides how without asking
  (it takes the recommended option and leaves a receipt), comes to you with a screenshot and a line
  or two when there is something to see, then waits. Your reaction is filed as threads, in your
  words. `/spool-lazy off` ends it.

## 0.17.0 · 2026-11-16

- Several threads at once, each in a git worktree of its own: `spool start <id> --worktree` (or
  `spool next --claim --worktree`) gives a thread its own checkout on a branch `spool/<id>`, inside
  `.spool/worktrees/`. `spool done` lands it: rebased onto your checkout, checked there,
  fast-forwarded, one thread at a time, so three built at once arrive as three clean sets of
  commits. A conflict, a failing check or your own uncommitted changes in the way refuse the
  finish and land nothing.
- The page builds three threads at once, each in a git worktree of its own that lands on your
  branch when its agent finishes; `spool builder --at-once` sets how many, and a project with no
  git is still built one at a time. In a chat, the loop does the same with a subagent for each.
- The page builds several threads at once, and takes each the moment it lands in Build. Each card
  in Building shows its own agent, and the Agents switch says how many (**● Agents: building 3**).
  How many is `"parallel"` in your config, or `spool builder --at-once <n>`.
- Spool in your terminal: type `spool` with nothing after it and the queue opens full-screen, with
  what needs you, what is being built and each agent's last line, Build in order, what is done to
  check, and the backlog. `b` builds, `p` plays a sprint, `s` stops an agent, `a` approves, `1` to
  `9` answer, `/` adds a thread, `?` lists every key. Beside a thread being built is its agent's
  session, live. `q` leaves your agents running. Piped, or with `--plain`, `spool` prints the
  status as before.
- Reply to an agent while it works: a `claude -p` agent keeps its input open, and what you write
  on a thread being built reaches it within a second and is read at its next step. Stop asks it
  to stop before ending it, so its session knows.
- Carry on is the same session: a thread you stopped, or one its agent walked away from, is
  picked up in its own Claude session with `--resume`, told only how it stopped and what you
  wrote since. A run that was cut off (the page killed, the machine lost) carries on the same way.
- An agent asks before a tool it may not use: the question shows on its card and ticket with
  Allow once, Allow for this run and No. It waits ten minutes while a page is open; with nobody
  there it is refused at once, as before.
- One skill for the chat: `/spool`. Say "open the board", "build that one", "catch me up" or "why
  is nothing building" and it runs the command, answers in a few lines and leaves the detail on
  the board. `/spool-page` is retired into it; `spool install` takes the old copy away.
- `/spool-loop` makes that chat the builder: it tells the board a chat builds here, builds what
  is in Build several threads at once, then watches. It is a quarter of the length. `/spool-record`
  is half as long and files ideas only. Set-up asks who builds and ends with `spool doctor`.
- The rules for building a thread are written once, in `rules/worker.md`. `spool prime worker`
  prints them, so a chat's loop, its subagents and the page's agents all work by the same words.
- `spool manage` hands a backlog-tidying agent its facts, the same way every time: what was said
  no to, what may already have shipped and the evidence, what looks alike, what has gone cold,
  what has no size or no Why, what is too big, and the order. `--end` writes the report of what
  the run changed, on one thread.
- A night of changes to the queue is one undo. With `SPOOL_RUN` set, every item an agent writes
  is kept as it was, and `spool revert <run>` puts each back and removes what the run made.
  Anything changed since is named and left alone, and no code is touched.
- `spool leave "<your words>" --until 8am --build 5` says how far agents may go while you are
  away: tidy only, or also build a counted few and drop what has shipped. It is kept in your
  words, counted as it is used, gone when its time is up, and nothing renews it.
- The page shows every project in a folder of them: it opens on **All projects** (what each is
  building, what needs you, its sprint, and the brief across all of them), and the project's name
  in the bar switches between their boards in place. What you do on one board changes only that
  project.
- A page over a folder of projects builds three threads at once across them; a project with no
  git still builds one at a time, and each board says how many its project gets.
- The page has a Roadmap view: your goals on top, then every sprint in a row (reached, being
  played with each thread's state, and to come with ▶ Play), where a thread's line opens its
  ticket and drags to another sprint.
- A sprint has a review page, opened from the Roadmap: what it was for, each thread with what it
  did, its steps to tick off and the calls made on it, and one button that approves the sprint.
- `spool brief` is the morning brief: one screen with what shipped while you were away, the few
  threads worth checking and why, and what needs you. `--since 8h` or `--since yesterday` narrows it.
- The board opens with the morning brief above its columns: what needs you, what is worth a look
  and why, the rest by sprint, each a click from its thread, and one button to approve it all.
- Threads are the main thing: the **Needs you** tab is gone. Questions, the calls agents made (a
  **Decided** post with Fine and Overrule), a plan's go-ahead and new skills are settled on their
  own thread, and notes nobody filed sit at the top of the Backlog.
- A thread reads like a thread: the agent at work is its newest post, with what it is doing now, a
  ticking clock and its log; times read "4m" or "Nov 16"; code reads as code; long runs of
  bookkeeping fold away. The live log holds still while you read it, and Enter sends a reply.
- A thread that is waiting says so, on its card and at the top of its ticket: your answer, another
  thread, a hold, or an agent that stopped without finishing, with what it last said.
- Each thread says why it exists: one quiet line on its card, beside its name in the loop's list,
  and `spool check` names any open thread with no `Why:` line.
- Archive a thread you do not want to see: one click on its card or backlog row puts it out of
  sight, not dropped, under a folded **Archived** section at the foot of the Backlog, where one
  click brings it back (`spool archive`, `spool archive --undo`, `spool list --archived`).
- Say what is built first by dragging: drag a card up or down in **Build** and a line shows where
  it lands. The top of Build is built next, by the page's agents, `spool next` and the loop. From
  the chat: `spool order <t-id> --first | --last | --before <t-id> | --after <t-id>`.
- `spool page -d` runs the page in the background: it gives you the address and opens no browser,
  and stays up after the terminal or chat that started it has gone. `spool page --status` says
  whether one is up, and `spool page --stop` ends it. A second start gives the address of the first.
- `spool demo` makes a throwaway project, a small bill splitter with a test, with ten threads in
  its spool, a sprint to play and a question to answer. `--open` opens its board.
- `spool doctor` checks the setup (git, the build gate, a check, the agent command, who builds, a
  notifier, the skills, Node) and prints what is missing with the line that fixes it.
- Filing a thread says when it looks like one already there, open, finished lately or dropped
  before, and how to add the words to that one instead.
- Agents record only what belongs in the spool: an idea, a wish, feedback or a bug. An instruction
  about the work ("keep going until midnight") is done, a go or a no is its verb, and a long
  message has only its ideas filed.
- `spool show <id> --report` prints a plan's or audit's report, and `spool_show` with
  `report: true` returns it over MCP, for an agent with no shell.
- `spool watch` waits a few seconds before reporting an unfiled note, so one the page files
  straight away no longer wakes the loop.
- `spool page --port` on a port that is taken stops with the error instead of staying up with no page.
- A way in for contributors: `CONTRIBUTING.md` says how to run Spool from a clone, run the tests
  and send a change, and `docs/architecture.md` is a short tour of the code.
- `spool builder chat` and `spool builder headless` pick who builds from the chat, and
  `--at-once <n>` how many threads at the same time; the page's selector follows within a second.
- `spool list --alike` lists open threads that look like each other, closest first, with the
  commands to merge or archive them, so "tidy the backlog" has somewhere to start.
- A finished ticket's changes read like a pull request: a row for each file with its counts and a
  bar, folding open to numbered lines on faint green and red.
- The loop's list shows the plan: the sprint being played comes first, under its goal and how far
  along it is, then planned sprints, then loose threads. `spool next` hands out a playing sprint's
  threads ahead of other work of the same urgency.
- Undo a thread and say why, and the reason is kept as a lesson every agent reads before it
  works; `spool lessons` lists them and `spool lessons --drop <n>` forgets one.
- **■ Stop** on a card being built ends that thread's agent at once, and no other; one that does
  not listen is killed two seconds later. The thread waits in Build marked **Stopped**, and nothing
  builds it until you press **▶ Carry on** or drag it into Building.
- Undoing a thread's uncommitted edits no longer misses the first changed file.
- `spool status` says where the board is and who builds, and when Build has work but nothing is
  being built, the one reason why.
- `spool agents on` / `off` presses the page's Agents switch from a terminal or a chat, and
  `spool agents` says where it stands.
- `spool install --for codex` and `--for cursor` put the four skills where those agents load them.
  `--for all` does every agent found here, and `spool doctor` says which have Spool. Gemini CLI
  gets the rules from AGENTS.md and `spool prime`.
- A finished change can say how to see it working: `spool done --steps "<step>"`, shown in
  `spool show`, `spool review` and the morning brief, and added later with `spool edit --steps`.
- Say what you want a stretch of work to achieve and the agent makes it a sprint: your words kept
  on it, a goal, and the threads that get there, in one go (`spool sprint <name> --add <t-id…>`).
- Goals: a few lines on what the project is for and where it is heading, agreed when it is set
  up. Every agent reads them first, the list leads with them, and each sprint says which it serves.
- What you record goes straight into the sprint it serves, and the reply says where each went.
- A sprint reached is a version: its changelog entry leads with the sprint's name and goal, and
  the sprint keeps the version it became.
- The page works on a phone: the bar in two rows, one column at a time to swipe through, and
  tickets that fill the screen.
- The tab says what is going on: a count of what waits on you, a dot while agents build, on the
  title and the yarn icon. A page that loses its server says so and picks up again by itself.
- Pick light or dark with the button at the right of the bar; it follows the system until you do.
- Move around the page from the keyboard: j and k, h and l, Enter to open, b to build, x to
  archive, and ? lists every key. Press c anywhere to add a thread; a #word is a tag and !0 to !3
  its priority. Cmd+K finds any thread by name, id or tag and runs any action by name.
- A click on a thread's id copies it, and the link beside a ticket's id copies its address.
- A ticket's Model and Effort are two labelled boxes. A Building card says which model and
  effort its agent runs with, and its ticket copies `claude --resume <session>` in one click.
- Every time on the page reads the way people say it, 4m ago or Nov 16, with the exact time on
  hover. Code, lists, bold and links in a thread show as what they are.
- A move between Backlog and Build, or an archive, has Undo on its toast for a few seconds.
- Cards slide to their new place when a thread changes column, and new ones fade in.
- Tests start the page on a port the system says is free and wait for what they need, so several
  suites can run on one machine at once.
- A reply too long for the page is refused in words, not dropped. A failed write while starting
  an agent no longer takes the page down: the thread goes back in Build with the reason on its log.
- A yarn mark for the terminal. Type `spool` at a terminal and the status opens under a small ball
  of yarn in the page's orange, its loose thread running off to write `spool`, with the version
  and the project beside it. It is for people only: piped, under `--json`, or run by an agent,
  every command prints exactly what it did.
- `spool doctor` says what an upgrade leaves behind: a retired skill still installed, and a Spool
  block in AGENTS.md that is not the one this version writes, each with the line that fixes it.
- Paste or drop a picture into a reply, + Add or quick add: it shows under your words on the
  ticket, opens full size, and the agent that builds the thread finds it in its brief.
  `spool attach <t-id> <file>` does the same from the command line.
- Agents attach a before and an after of anything you can see change; a finished ticket shows
  them side by side under the result, and the brief marks threads that have pictures.
- Text that starts with a dash is taken as given: `spool goals --edit "- first goal"`,
  `-m "- a list"`, and a title like `"--steps takes several"`. `--steps` takes every step after
  it. A done message keeps its line breaks, and `spool --version` always prints the number.
- Pick who builds, on the page: **Headless | Chat**, left of the Agents switch. Headless is the
  page starting `claude -p` itself, as before. Chat hands building to a Claude Code chat running
  `/spool-loop`: the page starts no agent, and the Agents button says whether a chat is building,
  watching the spool, or not there at all. The pick is kept for the project and outlives the page.
- The page keeps itself current. When it finds new code of Spool's on disk (an upgrade, a rebuild)
  and no agent of its own is running, it restarts onto it, at the same address and with agents as
  they were, and the page you have open reloads itself. Nothing is restarted under an agent, and a
  build that does not start is left alone.
- Spool building Spool: a page that builds Spool's own checkout runs `npm run build` there once
  Build and Building are both empty, never while a thread is being built, so what is marked done is
  what the page shows. If the rebuild fails, the page stays as it was and says why.
- Fable picks who builds each thread: before a `claude` agent starts one, Fable reads it and
  chooses the model and the effort, leaning bigger and heavier, and says why on the thread. Your
  pick on the ticket's **Model** field, or `spool edit <id> --model <m> --effort <e>`, always wins.
  If Fable cannot answer, the size decides, from Sonnet for a tiny fix up to Fable at xhigh for a
  huge one. `"router": false` in your config skips Fable; your own table goes under `models`.
- See what a page-built agent is doing: `claude -p` is run with `--output-format stream-json
  --verbose`, the card's live lines show its messages and tool calls, and the whole stream is kept
  in `.spool/runs/<thread>/`, out of git. The thread's log gets the session id (`claude --resume
  <id>` opens it) and every tool call the agent was refused.

## 0.16.0 · 2026-11-15

- Brief in the chat: the loop leads with what it needs from you or with the result, in a few lines,
  and leaves the detail to the page. `spool overview --brief` prints those lines; the full table
  comes only when you ask for everything.

## 0.15.0 · 2026-11-15

- The page runs the agents: `spool page --run`, or the **Agents** switch. Press ▶ and the thread is
  built with no chat open; the card shows what the agent is doing, and Stop ends it.
- A **Needs you** tab: questions, plans, the calls agents made, new skills and unfiled notes, each
  cleared with a click.
- A finished ticket shows **what changed** and has **Undo this thread**.
- Done means checked: `spool checks "npm test"`, and no thread is marked done unless it passes.
- Sprints carry a goal, a reason and a done-when.

## 0.14.0 · 2026-11-15

- A lock for the gate: `spool init --lock`. The commands that start work then run only for a person,
  on the page or at their own terminal; an agent is refused.
- **Add to Build** at the foot of the backlog moves everything it is showing, after every filter.
- `docs/how-it-works.md` is rewritten for Spool as it is now.

## 0.13.0 · 2026-11-15

- Each column on the board sorts and filters by itself, and remembers it.
- Dragging works. It never had: cards were not marked draggable in a way browsers accept.
- An add is never lost: the page recovers when its server restarts, and puts your words back in the
  box if a save fails.
- The page is tested in real Chrome on every `npm test`: clicking, typing and dragging.

## 0.12.1 · 2026-11-15

- The Backlog view shows as soon as you click it.
- Claude is shown by its own logo on a thread.
- The README sets a beginner up from nothing but a Claude account.

## 0.12.0 · 2026-11-15

- Sprints, with no dates: make one, fill it from the backlog, press ▶ on it and everything in it is
  built. `spool sprint`, `spool play`.
- The page is laid out like the boards people know: Board and Backlog views, a search, sprint
  pills, and cards with the key, priority, size and builder at the foot.
- Done: a ✓ on each card, "Mark all as complete", and completed threads kept as History.
- What you add or save on the page shows at once.
- The yarn is the page's icon. An audit's or plan's report is read on its ticket.

## 0.11.0 · 2026-11-15

- The loop reacts to the page: move a thread to Build and it starts within seconds, with no timer.
  `spool watch` is the command behind it. Opening the page starts the loop.
- A thread reads as a conversation: You, then Claude with the model beside the name, and the moves
  in between.
- The README shows the page, with pictures from a made-up project.
- Each ticket has its own address, and a reply on a finished thread becomes a linked follow-up.

## 0.10.0 · 2026-11-15

- Spool page: click a card and it opens as a ticket. Your words, the description, the agent's
  response and the full activity on one side; status, priority, difficulty, tags and version on the
  other, all editable.
- Tags and versions on threads (`--tag`, `--version`). Click one on a card to narrow the board to it.
- Finished threads end with **Mark as complete**: your approval of the change.
- Threads show which agent built them. Agents sign their work with `--as`.
- The page header shows the repo name and its version, and nothing else.

## 0.9.0 · 2026-11-15

- Spool page: **+ Add** at the foot of Proposed and Build puts a new thread in that column. The add
  box at the top is gone.
- A new README: short, quickstart first. The long version is in `docs/how-it-works.md`.

## 0.8.0 · 2026-11-15

- The Spool page: `spool page` or `/spool-page` opens a board of every thread in four columns —
  proposed, build, building, done. Drag a thread to Build or press ▶, add notes, answer questions.
- The build gate: every new thread starts proposed, and nothing is built until you move it to build,
  on the page or by saying so (`spool build`). `spool init --gate` turns it on.
- The loop builds what is in build and nothing else.
- `spool mcp`: Spool's commands as tools for an agent with no shell.
- `spool skills --suggest`: Spool notices procedures that recur across finished threads and the loop
  offers to write them down.

## 0.7.0 · 2026-11-15

- Three skills: `/spool-init`, `/spool-loop` and `/spool-record`. `/spool-recorder` is renamed
  `/spool-record`; `/spool-overview` and `/spool-help` are removed, and `spool install` takes the old
  copies away.
- The loop's table is printed by Spool itself (`spool overview --table`), so it is the same every
  time, and every row has a number, AI-suggested and on-hold threads included.
- One go can cover several threads: "go on 1 to 3" builds them back to back.

## 0.6.0 · 2026-11-15

- Before each thread the loop talks it through in plain words — what it is, why it is next, its
  plan — and builds on your word: go, change it, or pick another.
- The loop adds its own ideas to the spool as ✨ AI suggested. They wait for your yes.
- The recorder gives every thread a short spec: what, why, done when.
- What you agree in a talk is written on the thread, so the context lives in the spool.

## 0.5.0 · 2026-11-15

- The loop is simpler. Every run shows one table of every open thread, numbered in the order it
  suggests, then works them one by one without waiting for a go-ahead.
- As it starts each thread it says what the thread is and its plan, and it can be steered at any time.
- It notifies you when the list is done, when nothing can move without you, or when a question stops
  a thread.
- The schedule is only a check back in for anything new or more pressing: no sessions, no hours to
  fill.

## 0.4.0 · 2026-11-15

- The loop's check-in is one fixed layout: where the project stands, what shipped, a table of the
  whole spool (thread, status, difficulty, priority, what to talk through), what the loop recommends
  for the session, and what needs talking through.
- Nothing starts until you say go. The ten-minute timer is gone.
- The loop sets exactly one scheduled job. `/spool-loop again` and `/spool-loop go` no longer exist.
- `/spool-recorder <what, and where>` records the one message it is in front of; it no longer turns
  the chat into a recorder.
- `/spool-blockers` is removed: the loop's check-in walks you through everything waiting on you.
  `spool install` takes the old copy away.

## 0.3.0 · 2026-11-15

- `/spool-loop` is the main command: a cycle every three hours (or `/spool-loop <hours>`) that takes
  stock of the spool, checks in, waits ten minutes for you to steer, then works until the next check-in.
- A spool 🧶 holds threads 🧵: the overview, the skills and the check-in all say so, and every thread
  is marked 🧵 under its colour.
- Every check-in is three parts: the whole spool, a numbered proposal of what the loop intends to
  ship before the next one, then the questions.
- The loop's first return is a full interval away, not minutes after it starts.
- The loop notifies you through Claude when a check-in is waiting, when a question stops a thread,
  and when nothing can move without you.
- The recorder decides how to split what you dictate into threads, and sizes each one.
- The loop gives what shipped a version at the end of each cycle: a bump, a changelog entry and a tag.
