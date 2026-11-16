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

The page has three views. **Board** is four columns: Backlog, Build, Building,
Done. **Backlog** is for planning: sprints to fill and play, and under them
everything that is in no sprint. **Needs you** is every decision waiting on
them that is not a thread: questions, plans wanting a go-ahead, calls agents
made by themselves, new skills, notes nobody filed. Each is cleared there.

| On the page | What it does |
| --- | --- |
| Drag a thread 🧵 to **Build**, or press ▶ | It may be built now, in its turn. This is the only way anything gets built. |
| **Not yet**, or drag it back | Back to the backlog. Nothing builds it. |
| **+ Create sprint**, then drag threads into it | A sprint is a named set of threads with no dates. Being in one starts nothing. |
| **▶ Play sprint** | Everything in the sprint moves to Build at once. |
| The search, or a sprint's pill | Narrows the board to what matches. |
| **Add to Build**, at the foot of the backlog | Moves every thread the backlog is showing right now to Build, and none that a filter or the search has hidden. It asks once. |
| **Sort** and **Show** at the top of a column | Sorts or filters that column alone. The order agents build in does not change. |
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

Agents keep working while the page is open, and it shows threads move as they do.
`spool page -P <project>` shows one project of a folder of them.
