---
name: spool
description: This project's work queue and feedback loop (the `spool` CLI). Use when the user gives feedback, an idea, a bug report or a complaint about the project; asks what's next, what's blocked or what needs their decision; says "run the loop" or asks you to work the queue; approves, answers or rejects something an agent did; or asks which skills exist. Also check it before starting any piece of work.
---

# Spool

Run `spool prime` and follow it. It prints the protocol and this project's
autonomy policy; the protocol lives in the CLI so it is always current.

- `spool status` — what is ready, active and blocked.
- `spool next --claim` — take the most important ready task.
- `spool review` — what is waiting on the human.

Never edit files in `.spool/` by hand.
