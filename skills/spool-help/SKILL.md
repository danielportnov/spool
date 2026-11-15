---
name: spool-help
description: List the Spool skills in one short table and say which one to use next. Use for /spool-help, or when the user asks what Spool is, how to use it, which Spool skills or commands exist, or what to do next with it.
---

# Spool help

Spool keeps a work queue inside the project so agents can work it without the
human at the keyboard. That queue is the project's spool 🧶, and each piece of
work in it is a thread 🧵. They say what they want; agents do it, and stop only for
calls that are theirs to make. The human uses the skills below. The `spool`
command line is the agents' tool underneath, and the human never needs to type it.

Show this table as it is:

| Skill | What it does | Use it |
| --- | --- | --- |
| `/spool-init [folder]` | Sets Spool up in this folder or repo, or in one inside it that you name | once per project |
| `/spool-loop [hours]` | The main one. Every `hours` (3 unless you say) it shows you the spool 🧶, proposes which threads 🧵 to ship next, asks what it needs up front, then works until the next check-in | once, and leave the chat open |
| `/spool-recorder <what, and where>` | Put it in front of anything you type or say: that one message is filed as threads 🧵, and the chat carries on as it was | whenever you have feedback or an idea |
| `/spool-blockers` | Walks you through what agents need from you: questions, go-aheads, anything to undo | to clear everything waiting on you in one go |
| `/spool-overview [project]` | The whole spool 🧶, every thread 🧵 colour-coded: needs you, blocked, in progress, ready, on hold | any time |

The flow: **init** once, then **loop**, and that is it. The loop checks in
every few hours; they answer, reprioritise, add ideas, and go back to their
day. **Recorder** goes in front of any idea, at any time, in any chat. The other two are for
looking closer.

Then add one line on what to do next here. Check with `spool status`; don't guess:

- `spool` is not installed, or there is no `.spool/` here: "Start with `/spool-init`."
- anything else: "`/spool-loop` starts the loop: a check-in now and every three hours,
  work in between. `/spool-loop 1` for every hour." If the spool is empty, add
  that the first check-in will ask what they want built.

Only if they ask about the command line: `spool help` lists the engine's verbs.
