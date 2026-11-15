---
name: spool-overview
description: Show a project's spool as one short colour-coded list of threads - what needs the user, what has to be broken down, what is blocked and on what, what is in progress, ready and on hold. Use for /spool-overview [project], or when the user asks where things stand, what's in the spool, which threads are open, what's in the queue, what's blocked, or for the status of a project.
---

# Spool overview

Run `spool overview <project>`. Leave the project out for the one you are
standing in; at the top of a folder of projects that shows all of them. Project
names match loosely, so pass what they said. If it says there is no `.spool/`
here, tell them to run `/spool-init`, and stop.

`spool` is your tool; the human never types it. A project's queue is its
spool 🧶 and each piece of work in it is a thread 🧵: say it that way. The
commands call a thread a task.

## Show it

Give them the list as it comes: the 🧶 line for the project, then the same
groups, in the same order, each under its coloured dot, each thread starting
with 🧵 and each question with ❓. The colours and the marks are the point, so
keep them.

| | Group | Means |
| --- | --- | --- |
| 🔴 | Needs you | A question only they can answer, or a plan waiting for their go-ahead. Work is stopped behind it. |
| 🟣 | Break down | Too big to build in one go. It needs a plan first; an agent writes one unless they want to talk it through. |
| 🟡 | Blocked | Waiting on something else. Say what in plain words: their answer, a go-ahead, or another thread. |
| 🔵 | In progress | An agent has it now. |
| 🟢 | Ready | Can start. Listed in the order agents will take it. |
| ⚪ | On hold | They said not yet. Nothing happens until they say go. |

- One line per thread: the title in plain words, then only what matters about it.
- Leave out ids, sizes and priorities unless they ask, or two threads would be confused without them.
- Leave out empty groups. Keep long groups to the first few and say how many more.
- For several projects, one short block per project. Skip projects with nothing open.

## End with the one next move

One line, whichever comes first:

- anything under 🔴: "`/spool-loop` walks you through these at its check-in, and unblocks N threads."
- something under 🟣 they may want a say in: offer to talk it through before an agent plans it.
- 🟢 work and nobody working it: "`/spool-loop` starts on it."
- nothing open: "`/spool-recorder` to add what's next."
