---
name: spool-page
description: Open the Spool page - a board in the browser with every thread of this project's spool in four columns (backlog, build, building, done), and a backlog view with sprints, where the user drags threads into build or presses play on a thread or a whole sprint, adds notes and answers questions. Use for /spool-page, or when the user says "open the spool page", "open the board", "show me the board", "let me see the spool", or wants to plan or move threads around.
---

# Spool page

The page is where the human plans and steers. Everything long lives there, so
the chat can stay short.

1. Run `spool page -d`. It starts the page, a small server on their machine,
   in the background, and returns within a second or two with its address. It
   opens no browser and stays up after this chat has gone. One already up for
   this project? It says so and gives that address; use it. No `.spool/` here?
   Tell them to run `/spool-init`, and stop.
2. Show it to them: in your harness's browser pane if it has one, or else run
   `spool page` once more, which with a page up only opens that one in their
   browser and returns. Give them the address, and say in one line what the
   board is for. Do not describe the board in the chat. They can see it.
3. **Keep the board live.** Opening the page is starting the loop: build what
   is in Build, then watch the spool so the next thread they move there is
   built the moment they move it. The `spool-loop` skill has the rules:
   "Build what is in build" and "Watch the spool".

What they can do on it:

The page has two views. **Board** is four columns: Backlog, Build, Building,
Done. Above them, when anything has shipped that they have not looked at or
anything needs them, is the morning brief: the same as `spool brief`, so do
not repeat it in the chat when they have the board open. **Backlog** is for planning: sprints to fill and play, under them
everything that is in no sprint, and at the foot what was archived. What waits on them is on its thread: a
question on its card and ticket, a call an agent made as a post in its thread
(**Fine**, or **Overrule** in their words), a plan's go-ahead and a new skill
on the ticket. A card with something to look at says so. Notes nobody filed,
and anything about no thread, sit in a strip at the top of the Backlog view.

| On the page | What it does |
| --- | --- |
| Drag a thread 🧵 to **Build**, or press ▶ | It may be built now, in its turn. This is the only way anything gets built. |
| **Not yet**, or drag it back | Back to the backlog. Nothing builds it. |
| Drag a card up or down in **Build** | A line shows where it will land. Dropped there, that is its place: Build is built top first, by this page's agents, by `spool next` and by the loop. Dropped there from another column, it moves to Build in that place. |
| **+ Create sprint**, then drag threads into it | A sprint is a named set of threads with no dates. Being in one starts nothing. |
| **▶ Play sprint** | Everything in the sprint moves to Build at once. |
| The search, or a sprint's pill | Narrows the board to what matches. |
| **Add to Build**, at the foot of the backlog | Moves every thread the backlog is showing right now to Build, and none that a filter or the search has hidden. It asks once. |
| **Sort** and **Show** at the top of a column | Sorts or filters that column alone. The order agents build in does not change. Build sorted another way takes a drop as a move, not a place. |
| The box icon on a backlog card or row | Archives it: out of sight, not dropped. It leaves the board and the lists, is never built, and waits under **Archived** at the foot of the Backlog view, folded shut. **↩ Bring back** there, or moving it to Build, returns it as it was. |
| The quiet line under a card's name | Why the thread exists, from the `Why:` line of its spec. Cut short; the whole of it on hover. |
| Open a card | The ticket: what they said, what was done and by which agent, and everything that happened, with its fields at the side. |
| Change a field on the ticket | Its name, status, priority, difficulty, tags or version. Tags and versions are theirs to invent. |
| Click a tag or a version on a card | The board shows only those threads; click again to clear. |
| A note on a thread | It lands on that thread, in their words. |
| **Show what changed**, on a finished thread | The files and lines its commits touched, read like a pull request: a row for each file with its counts, folding open to numbered, coloured lines. |
| **Mark as complete**, at the foot of a finished thread | They have looked at the change and approve it. |
| **Undo this thread** | Takes back exactly what that thread changed, with their reason: to be done again, or dropped. |
| **+ Add** at the foot of Proposed or Build | A new thread in that column, named from their first line, with all their words kept on it. Added under Build, it is in build. |
| An answer button on a question | The thread it was holding up can move again. |
| A line of the brief, above the columns | Opens that thread. The headline folds the brief to one line, until another thread finishes. |
| **All good: approve everything**, at the foot of the brief | Approves every finished thread and every call agents made. A new skill is still kept or dropped on its thread. |

The page says so if the build gate is off in this project, which means new
threads go straight to build. Offer to turn it on: `spool init --gate`.

**Agents: on / off**, at the top right, is the page's own runner. On, the page
builds what is in Build by itself, with no chat: it starts the agent command
set on their machine for each thread, the moment it lands in Build, and shows
what it prints. It builds one thread at a time, or as many as `parallel` in
their `~/.config/spool/config.json` says, and then the button says how many;
agents share the project's folder until each run gets a worktree of its own,
so one is the rule. Leave it off when you are the one building from this chat,
or two agents will work in one folder. `spool page --run` starts with it on.
They say "turn the agents off" or "on" to you: that is `spool agents off` or
`spool agents on`, the same switch, and `spool agents` alone says where it
is. Off whenever they ask; on only on their word, never on your own. With
Chat picked, on is refused: the page starts nothing while a chat builds.

**■ Stop**, on the card of a thread the page is building, ends that thread's
agent at once and no other. The thread waits in Build, its card saying
**Stopped**, and nothing builds it until they press **▶ Carry on** on it or
drag it into Building. **↩ Abort** also undoes what the agent changed and
sends the thread back to the backlog.

**Headless | Chat**, to its left, is who builds. Headless is that runner.
Chat is you: a chat running the loop. With Chat picked the page starts no
agent at all, and the Agents button only reports: **building** while a thread
is being built, **watching** while your `spool watch` is up, **off** when no
chat is listening. They want to see the work as it happens, or said the
headless runs are hard to follow? Chat is the pick for that; it is kept for
the project. They set it on the page, or say so to you: "switch to chat mode"
is `spool builder chat`, "let the page build" is `spool builder headless`
(`spool builder` alone says what is set; `--at-once <n>` is how many threads
are built at the same time). Only on their word, never on your own.

The page keeps itself current. When Spool is upgraded or rebuilt, the page
restarts onto the new code once no agent of its own is running, at the same
address, and the page they have open reloads itself. Do not stop and start it
to pick up new code: stopping it ends the agents it is running.

`spool page --status` says whether a page is up for this project, at what
address, and who builds. `spool status` says it too, under the counts, and
when Build has work and nothing is being built, the reason in one line. `spool page --stop` ends it, as Ctrl-C would: only when
they ask.

Agents keep working while the page is open, and it shows threads move as they do.
`spool page -P <project>` shows one project of a folder of them.
