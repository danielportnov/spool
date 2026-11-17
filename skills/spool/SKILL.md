---
name: spool
description: Steer this project's Spool from the chat - open the board, say what gets built and in what order, answer what agents asked, catch up on what they did, tidy the backlog, and change who builds. Replies are short and the detail is on the board. Use for /spool [what you want], or when the user says "open the board", "show me the spool", "where do things stand", "what needs me", "what's blocked", "catch me up", "what happened overnight", "why is nothing building", "build that one", "not yet", "do X first", "undo that", "play the sprint", "tidy the backlog", "come up with ideas", "archive that", "switch to chat mode", "let the page build", "turn the agents off" or "build three at once" or "take over the backlog". Not for building, which is /spool-loop, or for filing a new idea, which is /spool-record.
---

# Spool

They say what they want, and you run the command for it. Every action on this
project's spool 🧶 is a `spool` command, and the board in their browser runs
the same ones. They never type one, and you never edit `.spool/` by hand.

**First, `spool status`.** One screen: what waits on them, the board's
address, who builds, and why Build is not moving when it is not. No `.spool/`
here? Say so in a line and set it up by the `spool-init` skill. Nothing after
`/spool`? Show `spool overview --brief`, as it comes.

## Your reply

They read it on a phone, between other things. **Be brief. The board holds
the detail.**

- **Lead with what you need from them, or with the result,** in one line:
  "Moved the jump to Build. It is second in line."
- **A few lines at most.** No tables, no plans, no lists of reasons. Anything
  long is on the board: point at it.
- **Their terms.** A thread 🧵 is "the jump", never `t-4kq7`.
- **Caveman mode** (`spool caveman` says if it is on) **or "caveman" in their message:** fewest words, short fragments, no filler, the board's address last. "3 shipped. Build empty. You: 6 calls to OK. Next: CI fix. http://127.0.0.1:4747/" Their reply alone for a message that says it; on and off are `spool caveman on` and `off`. Every Spool skill follows it.
- **End with the board's address.** A thread's own place is that, then
  `#<t-id>`; one project of a folder of them, that, then `?project=<name>`.

## They say, you run

| They say | Run |
| --- | --- |
| "open the board", "show me the spool" | `spool page -d`: it starts the board in the background, or finds the one already up, and gives its address. Show it in your browser pane, or `spool page` opens it in theirs. Do not describe the board in the chat |
| "show it in my terminal", "I'd rather stay in the terminal" | Theirs to type: `spool` with nothing after it, in their own terminal, opens the queue full-screen over the same board, and starts the board in the background if none is up. Run by you, it only prints the status |
| "where do things stand" | `spool overview --brief`, as it comes |
| "show me everything", "what's in the spool" | `spool overview --table`, as it comes: every open thread, numbered, so they can say "build 4" |
| "what needs me", "what's blocked" | `spool review` |
| "catch me up", "what happened overnight" | `spool brief`, as it comes; `--since 8h` or `--since yesterday` when they name a time |
| "why is nothing building" | `spool status`: its "Build is not moving" line says why, and the fix. No such line? `spool doctor` |
| "build 3", "go on that one", "yes, do it" | `spool build <t-id>` |
| "not yet", "take that out of build" | `spool propose <t-id>` |
| "do X first", "X before Y" | `spool order <t-id> --first`, or `--before <t-id>`. `spool loop --dry-run` lists Build in the exact order it will be built |
| "that one can wait", "X is urgent" | `spool edit <id> -p <0-3>`: 0 it's broken, 1 it's bothering them, 2 default, 3 someday |
| "park that until the launch" | `spool hold <t-id> -m "<their words>"`; "take it off hold" is `spool release <t-id>` |
| "archive that", "get it out of the way" | `spool archive <t-id>`; it is kept, and `spool archive --undo <t-id>` brings it back |
| "drop that", "no", about any thread | `spool drop <t-id> -m "<their words>"` |
| "tidy the backlog", "put the backlog in order"; "come up with ideas" | Tidying: `spool prime manager` (its rules), then `spool manage --start`; do the pass by them, end with `spool manage --end -m "<headline>"`, and reply with the headline and the run's link (the board, then `#<run t-id>`). One undo takes the pass back. Only "what is duplicated"? `spool list --alike`. Ideas? `spool ideate` (`--max <n>` if they named a number) prints the facts and the rules: read the code it names, file each idea as it says, and say in a line how many |
| "manage it while I sleep", "work through it until midnight" | `spool leave "<their exact words>" --until <time>`, with `--build <n>` only if they said how many may be built. Then tidy, as above |
| "make a sprint of these", "put that in the sprint" | `spool sprint "<name>" --goal "<what it is for>" --add <t-id…>`; `spool edit <t-id> --sprint none` takes one out |
| "play the sprint", "make a sprint of these and play it" | `spool play <sprint>`, once it is made: everything in it moves to Build at once |
| an answer, or "no" to a call an agent made: "the second one", "a", "no, do X" | `spool answer <d-id> <n or their words>`; a call they overrule is queued to be done again |
| "that's fine", about a call an agent made, shipped work or a new skill | `spool approve <id>`; "drop that skill" is `spool drop <s-id>` |
| "all good", "the rest is fine" | `spool approve --all`; it never covers plans |
| "go ahead with the plan" | `spool approve <t-id>`, always by id, one plan at a time |
| "undo that", "I don't like it", "not that plan" | `spool revert <t-id> -m "<their reason, in their words>"`: it goes back to the backlog with the reason and nothing builds it until they move it to Build (`--now` only if they said to do it again at once). Every agent reads the reason before it works. `spool lessons` lists them. Refused because later threads changed the same lines? Name them and ask; add `--with-later` only on their yes |
| "switch to chat mode", "I want to watch it build" | `spool builder chat`, then build here by the `spool-loop` skill |
| "let the page build", "go headless" | `spool builder headless`, then `spool agents on`. No board up? `spool page -d --run`. This chat stops building |
| "caveman mode on", "talk less", "caveman off" | `spool caveman on`, `spool caveman off` |
| "I'm AFK", "don't ask me, I'm away"; "I'm back" | `spool afk on`, `spool afk off`. While on, agents take their own recommendation and record it as a call; only what is truly theirs (money, pushing, deleting, accounts, what the product is) still asks |
| "turn the agents off", "turn them on" | `spool agents off`, `spool agents on` |
| "I don't need Spool here", "turn Spool back on" | `spool disable`, `spool enable`; `--all` for every project in this folder. Off, the queue is kept and every command refuses |
| "build three at once", "one at a time" | `spool builder --at-once <n>` |
| "take over the backlog", "stop taking over" | `spool takeover on`, `spool takeover off`. In Chat mode the chat then moves the top thread they filed to Build itself, up to the usage target |
| "use up to 80% of my weekly usage", "stop at 90% of the 5-hour limit" | `spool target --weekly <n>`, `--five-hour <n>`; `none` takes one off. A chat building in Chat mode works up to it |
| "tell me when a thread starts", "stop notifying me when one is done" | `spool notify on started`, `spool notify off done`; `only <events>` for exactly those. `spool notify` lists them |
| "what is this project for", "the goal has changed" | `spool goals`; `spool goals --edit -` with their words |
| "where is this heading", "how is the sprint going" | The Roadmap on the board: its address, then `?view=roadmap`. A sprint that is reached has its review there, `?review=<r-id>`: send them to it, and do not walk its threads in the chat |
| more on a thread that exists: "the jump should be snappy, not heavy" | `spool capture "<their exact words>"`, then `spool file <note-id> --into <t-id>` |
| anything new: an idea, a bug, a wish | `spool capture "<their exact words>"`, then file it by the `spool-record` skill |
| how to work: "stop at midnight", "use subagents" | nothing to record: do it |

**Only they start work.** Moving a thread to Build is the only way anything
gets built, and `spool build`, `spool play`, `spool release`, `spool leave`,
`spool builder`, `spool agents on` and `spool takeover on` are theirs: run one only on their plain
word. Never guess a go, an answer or an approval. If their reply does not
plainly say it, ask in one line. **Where the gate is locked,** those commands
refuse you. Give them the thread's place on the board and they press ▶. Do
not look for a way round it: that refusal is the point.

**Their words are the record.** Pass what they said through as they said it,
and run their commands as them, with no `--as`: an undo signed by you keeps
no lesson. The chat is not the record: the spool is.

**Who builds.** Headless: the board starts an agent for each thread in Build
while its Agents switch is on. Chat: a chat running `/spool-loop` builds, and
the board starts none. Opening the board builds nothing. They want to watch
the work, or find headless runs hard to follow? Offer Chat. The board
outlives this chat and restarts itself onto new code, so never stop and start
it yourself: that ends the agents it is running. `spool page --stop` only
when they ask.
