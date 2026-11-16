---
name: spool-page
description: Open the Spool page - a board in the browser with every thread of this project's spool in four columns (backlog, build, building, done), and a backlog view with sprints, where the user drags threads into build or presses play on a thread or a whole sprint, adds notes and answers questions. Use for /spool-page, or when the user says "open the spool page", "open the board", "show me the board", "let me see the spool", or wants to plan or move threads around.
---

# Spool page

The page is where the human plans and steers. Everything long lives there, so
the chat can stay short.

1. Run `spool page` in the background: it is a small server on their machine
   and has to keep running. It prints the page's address and opens it in their
   browser. If your harness has a browser pane, open the address there and
   add `--no-open`. No `.spool/` here? Tell them to run `/spool-init`, and stop.
2. Give them the address, and say in one line what the board is for. Do not
   describe the board in the chat. They can see it.
3. **Keep the board live.** Opening the page is starting the loop: build what
   is in Build, then watch the spool so the next thread they move there is
   built the moment they move it. The `spool-loop` skill has the rules:
   "Build what is in build" and "Watch the spool".

What they can do on it:

The page has two views. **Board** is four columns: Backlog, Build, Building,
Done. **Backlog** is for planning: sprints to fill and play, and under them
everything that is in no sprint. What waits on them is on its thread: a
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
| The quiet line under a card's name | Why the thread exists, from the `Why:` line of its spec. Cut short; the whole of it on hover. |
| Open a card | The ticket: what they said, what was done and by which agent, and everything that happened, with its fields at the side. |
| Change a field on the ticket | Its name, status, priority, difficulty, tags or version. Tags and versions are theirs to invent. |
| Click a tag or a version on a card | The board shows only those threads; click again to clear. |
| A note on a thread | It lands on that thread, in their words. |
| **Show what changed**, on a finished thread | The files and lines its commits touched, and the patch. |
| **Mark as complete**, at the foot of a finished thread | They have looked at the change and approve it. |
| **Undo this thread** | Takes back exactly what that thread changed, with their reason: to be done again, or dropped. |
| **+ Add** at the foot of Proposed or Build | A new thread in that column, named from their first line, with all their words kept on it. Added under Build, it is in build. |
| An answer button on a question | The thread it was holding up can move again. |

The page says so if the build gate is off in this project, which means new
threads go straight to build. Offer to turn it on: `spool init --gate`.

**Agents: on / off**, at the top right, is the page's own runner. On, the page
builds what is in Build by itself, with no chat: it starts the agent command
set on their machine for each thread and shows what it prints. Leave it off
when you are the one building from this chat, or two agents will work in one
folder. `spool page --run` starts with it on.

**Headless | Chat**, to its left, is who builds. Headless is that runner.
Chat is you: a chat running the loop. With Chat picked the page starts no
agent at all, and the Agents button only reports: **building** while a thread
is being built, **watching** while your `spool watch` is up, **off** when no
chat is listening. They want to see the work as it happens, or said the
headless runs are hard to follow? Chat is the pick for that; they set it on
the page, and it is kept for the project.

The page keeps itself current. When Spool is upgraded or rebuilt, the page
restarts onto the new code once no agent of its own is running, at the same
address, and the page they have open reloads itself. Do not stop and start it
to pick up new code: stopping it ends the agent it is running.

Agents keep working while the page is open, and it shows threads move as they do.
`spool page -P <project>` shows one project of a folder of them.
