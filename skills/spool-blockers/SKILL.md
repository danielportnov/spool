---
name: spool-blockers
description: Walk the user through everything agents need from them on a project's spool - open questions, plans waiting for a go-ahead, calls agents made on their own, finished work to accept or undo - take their answers in plain words and unblock the work. Use for /spool-blockers, or when the user asks "what needs me", "what's blocked", "what do you need from me", "catch me up", "what did the agents do", or answers, approves or rejects something an agent did.
---

# Spool blockers

Agents work a project's spool 🧶 on their own, thread 🧵 by thread, and stop
only for calls that belong to the human. This is where the human makes those calls. Your job is to spend as
little of their attention as possible: put each call in front of them ready to
answer, take the answer in their words, and get work moving again.

`spool` is your tool for the spool. The commands call a thread a task. The human never types it, and you never
edit `.spool/` by hand.

Run `spool review` (`-P <project>` if they named one). If it says there is no
`.spool/` here, tell them to run `/spool-init`, and stop. If nothing is waiting,
say so in a line and stop.

## Go through it in this order

1. **Questions.** Work is stopped on these, and the first holds up the most.
   One at a time: the question in plain words, the options, which one the agent
   recommends and why, and what it unblocks. If your harness has a way to ask
   multiple-choice questions, use it, recommended option first.
   Their answer: `spool answer <d-id> <option number, or their words>`
2. **Plans waiting for a go-ahead.** Say the approach in a sentence and list
   the parts. Read the report file first if you need it to answer a question.
   - "go ahead": `spool approve <t-id>`, always by id, one plan at a time
   - "not like that": `spool revert <t-id> -m "<their words>"`
3. **Calls agents made on their own.** Read them out together, briefly: what
   was decided, and why. Ask if they would change any.
   - fine: `spool approve <d-id>`
   - "no, do X": `spool answer <d-id> "<their words>"`, and the rework is queued
4. **What shipped.** One line each: what changed and how to see it. Nothing is
   needed unless they dislike something.
   - "undo that" / "I don't like it": `spool revert <t-id> -m "<their words>"`.
     The code goes back, and the task reopens with their reason attached.
5. **New skills** agents wrote down: `spool approve <s-id>` or `spool drop <s-id>`.
6. **Unfiled feedback** in the inbox is usually waiting on one clarifying
   question. Ask it, then file the note by the `spool-recorder` rules.

When everything left is fine by them ("all good", "looks fine"):
`spool approve --all`. It never covers plans.

## Rules

- Never guess. If you can't tell which item they mean, or whether that was a yes, ask.
- Never answer for them, and never approve on their behalf, however obvious it seems.
- Their words are the record: pass what they said through, don't tidy it into your own.
- They may be listening, not reading: short sentences, no ids, no tables unless they ask.
- Stop when they stop. Whatever they did not get to stays waiting; say how much is left.

## Then

Say what their answers unblocked; `spool answer` prints what is now ready. If a
loop is running, it picks the work up at its next cycle. If not, offer
`/spool-loop`.
