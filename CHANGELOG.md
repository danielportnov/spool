# Changelog

What shipped in each version of Spool, newest first.

## Unreleased

- Fable picks who builds each thread: before a `claude` agent starts one, Fable reads it and
  chooses the model and the effort, leaning bigger and heavier, and says why on the thread. Your
  pick on the ticket's **Model** field, or `spool edit <id> --model <m> --effort <e>`, always wins.
  If Fable cannot answer, the size decides, from Sonnet for a tiny fix up to Fable at xhigh for a
  huge one. `"router": false` in your config skips Fable; your own table goes under `models`.

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
