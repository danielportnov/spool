---
name: spool-help
description: List the Spool skills in one short table and say which one to use next. Use for /spool-help, or when the user asks what Spool is, how to use it, which Spool skills or commands exist, or what to do next with it.
---

# Spool help

Spool keeps a work queue inside the project so agents can work it without the
human at the keyboard. They say what they want; agents do it, and stop only for
calls that are theirs to make. The human uses the skills below. The `spool`
command line is the agents' tool underneath, and the human never needs to type it.

Show this table as it is:

| Skill | What it does | Use it |
| --- | --- | --- |
| `/spool-init` | Sets Spool up in this folder or repo | once per project |
| `/spool-recorder` | Turns a chat into the recorder: talk or type, and everything is filed as work | whenever you have feedback or an idea |
| `/spool-loop [hours]` | Agents work the docket until nothing can move without you, and come back every `hours` | to get work going, and keep it going |
| `/spool-blockers` | Walks you through what agents need from you: questions, go-aheads, anything to undo | when the loop says it is waiting on you |
| `/spool-overview [project]` | The whole docket, colour-coded: needs you, blocked, in progress, ready, on hold | any time |

The flow: **init** once, **recorder** to fill the docket, **loop** to work it,
**blockers** when it needs you. **Overview** shows where things stand.

Then add one line on what to do next here. Check with `spool status`; don't guess:

- `spool` is not installed, or there is no `.spool/` here: "Start with `/spool-init`."
- the docket is empty: "`/spool-recorder` and tell it what you want."
- questions or plans are waiting on them: "`/spool-blockers` first: work is stopped on you."
- work is ready: "`/spool-loop 2` sets agents on it now and every two hours."

Only if they ask about the command line: `spool help` lists the engine's verbs.
